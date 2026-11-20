// The PDF tools re-open the file from disk, without the password or the key the
// document was unlocked with, so they all failed on a password-protected PDF.
// Their output must stay encrypted: only Decrypt PDF removes the password.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import {
  EXE,
  USE_NG,
  assemblePdf,
  cmdId,
  extractPageText,
  loadPng,
  makeTopBottomPdf,
  pollUntil,
  runStandalone,
  tmpPath,
  SETTINGS_FILE,
} from "./util.ts";
import { killAndWait, launchControlled, pressEnter, sendCommand, waitToolWindow } from "./win-automation.ts";
import { enumChildWindows, getClassName, getControlText, isWindowVisible, sendText } from "./winapi.ts";
import { kPassword, rememberedKey } from "./pdf-decrypt-remembered-key.ts";

const kPages = 2;
const kPage1 = "page 1 top";
const kPage2 = "page 2 top";

type App = Awaited<ReturnType<typeof launchControlled>>;
type Launch = () => Promise<App>;

function encrypt(dir: string, method: string, fixture = makeTopBottomPdf(kPages)): string {
  const plain = join(dir, `${method}-plain.pdf`);
  const encrypted = join(dir, `${method}.pdf`);
  writeFileSync(plain, fixture);
  const p = Bun.spawnSync([EXE, "clean", "-E", method, "-U", kPassword, "-O", "owner", plain, encrypted]);
  if (p.exitCode !== 0) {
    throw new Error(`pdf-tools-encrypted: encrypting failed: ${p.stderr.toString()}`);
  }
  return encrypted;
}

// the output needs the original password, and has the wanted pages
function checkEncryptedOutput(name: string, out: string, want: string[], notWant: string[] = []): string {
  if (!readFileSync(out).includes("/Encrypt")) {
    throw new Error(`pdf-tools-encrypted: ${name}: the output lost its encryption`);
  }
  const plain = `${out}.plain.pdf`;
  const p = Bun.spawnSync([EXE, "clean", "-p", kPassword, "-D", out, plain]);
  if (p.exitCode !== 0) {
    throw new Error(`pdf-tools-encrypted: ${name}: the password doesn't open the output: ${p.stderr.toString()}`);
  }
  const text = extractPageText(plain);
  for (const s of want) {
    if (!text.includes(s)) {
      throw new Error(`pdf-tools-encrypted: ${name}: no '${s}' in '${text}'`);
    }
  }
  for (const s of notWant) {
    if (text.includes(s)) {
      throw new Error(`pdf-tools-encrypted: ${name}: unexpected '${s}' in '${text}'`);
    }
  }
  return plain;
}

// not a quit: the encrypted output opens in a tab and its password dialog is modal
async function stop(app: App): Promise<void> {
  app.client.close();
  await killAndWait(app.proc);
}

async function submitDialog(app: App, cmd: string, title: string, input = ""): Promise<string> {
  sendCommand(app.frame, cmdId(cmd));
  const dlg = await waitToolWindow(app.client, app.proc.pid!, "pdftool", { title });
  if (!dlg) {
    throw new Error(`pdf-tools-encrypted: no dialog '${title}'`);
  }
  const edits: number[] = [];
  enumChildWindows(dlg, (hwnd) => {
    if (getClassName(hwnd) === "Edit") {
      edits.push(hwnd);
    }
    return true;
  });
  const destEdit = edits.find((h) => /\.(pdf|txt)$/i.test(getControlText(h)));
  if (!destEdit) {
    throw new Error(`pdf-tools-encrypted: '${title}' has no destination edit`);
  }
  const dest = getControlText(destEdit);
  if (input) {
    const extraEdit = edits.find((h) => h !== destEdit);
    if (!extraEdit) throw new Error(`pdf-tools-encrypted: '${title}' has no extra edit`);
    sendText(extraEdit, input);
  }
  await pressEnter(destEdit);
  await pollUntil(
    () => existsSync(dest) && !isWindowVisible(dlg),
    (ok) => ok,
    { error: `${title}: did not finish writing ${dest}` },
  );
  return dest;
}

async function runDialog(launch: Launch, cmd: string, title: string, pages = ""): Promise<string> {
  const app = await launch();
  try {
    await app.client.waitForRenderIdle();
    return await submitDialog(app, cmd, title, pages);
  } finally {
    await stop(app);
  }
}

const kDiskNote = "Original page-range note";
const kEditedNote = "Unsaved page-range note";

function pageRangeFixture(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 3 /Kids [5 0 R 7 0 R 9 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /Annot /Subtype /Square /P 5 0 R /Rect [72 490 140 540] /Contents (${kDiskNote}) >>`,
  ];
  for (const page of [1, 2, 3]) {
    const pageObj = objects.length + 1;
    const annots = page === 1 ? " /Annots [4 0 R]" : "";
    const body = `BT /F1 18 Tf 72 560 Td (page ${page} top) Tj ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj + 1} 0 R${annots} >>`,
      `<< /Length ${body.length} >>\nstream\n${body}endstream`,
    );
  }
  return Buffer.from(assemblePdf(objects));
}

async function checkDirtyPageRanges(dir: string, passwordArgs: string[]): Promise<void> {
  const fixture = pageRangeFixture();
  const source = passwordArgs.length ? encrypt(dir, "aes-256", fixture) : join(dir, "page-range.pdf");
  if (!passwordArgs.length) writeFileSync(source, fixture);
  const disk = readFileSync(source);

  for (const [cmd, title, pages] of [
    ["CmdPdfExtractPages", "Extract Pages", "1-2"],
    ["CmdPdfDeletePages", "Delete Pages From PDF", "3"],
  ] as const) {
    const app = await launchControlled([...passwordArgs, source]);
    let out: string;
    try {
      await app.client.waitForRenderIdle();
      const [status, edit] = await app.client.request(ControlCommand.TestCurrentPdf, [
        "set-annot-contents",
        kEditedNote,
      ]);
      if (status !== 0 || !String(edit).includes(`changed=1 before='${kDiskNote}'`)) {
        throw new Error(`${title}: source edit failed: ${edit}`);
      }
      out = await submitDialog(app, cmd, title, pages);
      if (!passwordArgs.length) {
        await app.client.selectTab(0);
        const [stateStatus, state] = await app.client.request(ControlCommand.TestMarkupAnnots);
        if (stateStatus !== 0 || !String(state).includes("undo canUndo=1 canRedo=0 modified=1")) {
          throw new Error(`${title}: source lost dirty or undo state: ${state}`);
        }
      }
    } finally {
      await stop(app);
    }

    if (!readFileSync(source).equals(disk)) throw new Error(`${title}: source file changed`);
    const plain = passwordArgs.length ? checkEncryptedOutput(title, out, [kPage1, kPage2], ["page 3 top"]) : out;
    const output = await launchControlled([...passwordArgs, out]);
    try {
      await output.client.waitForRenderIdle();
      const [pageStatus, count] = await output.client.request(ControlCommand.TestCurrentPdf, ["pages"]);
      if (pageStatus !== 0 || count !== "pages=2") throw new Error(`${title}: wanted two pages, got ${count}`);
      const [status, note] = await output.client.request(ControlCommand.TestCurrentPdf, [
        "set-annot-contents",
        kEditedNote,
      ]);
      if (status !== 0 || !String(note).includes(`changed=0 before='${kEditedNote}'`)) {
        throw new Error(`${title}: output lost the unsaved annotation: ${note}`);
      }
    } finally {
      await stop(output);
    }
    if (!extractPageText(plain, 1).includes(kPage1) || !extractPageText(plain, 2).includes(kPage2)) {
      throw new Error(`${title}: output pages out of order`);
    }
  }
}

const kRedacted = "HIDDENMARKER";
const kOutsideCrop = "OUTSIDECROP";

function redactionFixture(): Buffer {
  const text = `BT /F1 18 Tf 72 700 Td (${kRedacted}) Tj 220 0 Td (${kPage1}) Tj ET`;
  const text2 = `BT /F1 18 Tf 72 700 Td (${kPage2}) Tj 0 -400 Td (${kOutsideCrop}) Tj ET`;
  // Rewriting the page's content array leaves obsolete streams to collect.
  return Buffer.from(
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 2 /Kids [4 0 R 8 0 R] >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents [5 0 R 6 0 R] /Annots [7 0 R] >>",
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
      "<< /Length 0 >>\nstream\nendstream",
      "<< /Type /Annot /Subtype /Redact /P 4 0 R /Rect [70 696 230 718] /QuadPoints [70 718 230 718 70 696 230 696] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 550 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 9 0 R >>",
      `<< /Length ${text2.length} >>\nstream\n${text2}\nendstream`,
    ]),
  );
}

async function checkRedactedTools(dir: string): Promise<void> {
  mkdirSync(dir);
  const plain = join(dir, "redaction.pdf");
  const fixture = redactionFixture();
  writeFileSync(plain, fixture);
  const encrypted = encrypt(dir, "aes-256", fixture);
  const failures: string[] = [];
  for (const [cmd, title, source, keepEncryption, input] of [
    ["CmdPdfCompress", "Compress PDF", encrypted, true],
    ["CmdPdfDecompress", "Decompress PDF", encrypted, true],
    ["CmdPdfEncrypt", "Encrypt PDF", plain, true, kPassword],
    ["CmdPdfDecrypt", "Decrypt PDF", encrypted, false],
    ["CmdDocumentExtractText", "Extract Text From PDF", encrypted, false],
    ["CmdPdfBake", "Bake PDF", encrypted, true],
    ["CmdPdfExtractPages", "Extract Pages", encrypted, true, "1"],
    ["CmdPdfDeletePages", "Delete Pages From PDF", encrypted, true, "2"],
    ["CmdSaveTrimmedPagesAs", "Save Trimmed Pages As", encrypted, true],
    ["CmdMergePDF", "Merge PDF", encrypted, true],
  ] as const) {
    const disk = readFileSync(source);
    const app = await launchControlled(["-pwd", kPassword, source]);
    try {
      await app.client.waitForRenderIdle();
      const state = async () => String((await app.client.request(ControlCommand.TestMarkupAnnots))[1]);
      assert.match(await state(), new RegExp(`^page1text=.*${kRedacted}`, "m"));
      sendCommand(app.frame, cmdId("CmdApplyRedactions"));
      const undo = "undo canUndo=1 canRedo=0 modified=1";
      const applied = await pollUntil(state, (s) => s.includes(undo));
      assert.doesNotMatch(applied, new RegExp(`^page1text=.*${kRedacted}`, "m"));

      let output: string;
      if (cmd === "CmdSaveTrimmedPagesAs") {
        output = join(dir, "trimmed.pdf");
        await app.client.request(ControlCommand.TestInvokeCommand, ["CmdToggleTrimEmptyMargins"]);
        await app.client.request(ControlCommand.TestSaveFileName, [output]);
        await app.client.request(ControlCommand.TestInvokeCommand, [cmd]);
        await pollUntil(() => existsSync(output), Boolean);
        const [status, result] = await app.client.request(ControlCommand.TestConvertToImages, [
          join(dir, "redacted-<N>.png"),
          "1",
          72,
        ]);
        assert.equal(status, 0, String(result));
        const image = loadPng(join(dir, "redacted-1.png"));
        // Near the right edge of the mark, where the original page was white.
        const pixel = (88 * image.w + 221) * image.nComp;
        assert.deepEqual(Array.from(image.data.subarray(pixel, pixel + 3)), [0, 0, 0]);
      } else if (cmd === "CmdMergePDF") {
        output = join(dir, "redacted-merged.pdf");
        await saveMerge(app, output);
      } else {
        output = await submitDialog(app, cmd, title, input);
      }
      await app.client.selectTab(0);
      assert.match(await state(), /undo canUndo=1 canRedo=0 modified=1/);
      assert.deepEqual(readFileSync(source), disk);
      sendCommand(app.frame, cmdId("CmdUndo"));
      const undone = await pollUntil(state, (s) => s.includes("undo canUndo=0 canRedo=1 modified=0"));
      assert.match(undone, new RegExp(`^page1text=.*${kRedacted}`, "m"));

      const textOutput = cmd === "CmdDocumentExtractText";
      const pageRange = cmd === "CmdPdfExtractPages" || cmd === "CmdPdfDeletePages";
      const wanted = pageRange ? [kPage1] : [kPage1, kPage2];
      const excluded = pageRange ? [kRedacted, kPage2] : [kRedacted];
      const pdf = keepEncryption ? checkEncryptedOutput(title, output, wanted, excluded) : output;
      if (!keepEncryption) {
        if (!textOutput) assert.ok(!readFileSync(pdf).includes("/Encrypt"));
        const exported = textOutput ? readFileSync(output, "utf8") : extractPageText(pdf);
        for (const marker of wanted) assert.ok(exported.includes(marker), `missing '${marker}'`);
        assert.ok(!exported.includes(kRedacted), "redacted text returned");
      }
      if (!textOutput) {
        const decoded = `${output}.decoded.pdf`;
        const p = Bun.spawnSync([EXE, "clean", "-d", pdf, decoded]);
        assert.equal(p.exitCode, 0, p.stderr.toString());
        const contents = readFileSync(decoded);
        assert.ok(!contents.includes(kRedacted), "redacted text remained in a PDF stream");
        if (cmd === "CmdSaveTrimmedPagesAs") {
          assert.ok(contents.includes(kOutsideCrop), "trimming erased text outside the CropBox");
        }
      }
      console.log(`${title}: redaction, encryption and source state OK`);
    } catch (err) {
      failures.push(`${title}: ${err}`);
    } finally {
      await stop(app);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}

async function runExtractPages(launch: Launch, out: string): Promise<void> {
  const app = await launch();
  try {
    await app.client.waitForRenderIdle();
    const res = await app.client.request(ControlCommand.TestExtractPages, [out, "2", 0]);
    if (res[0] !== 0) {
      throw new Error(`pdf-tools-encrypted: extract pages: ${String(res[1] ?? "").trim()}`);
    }
  } finally {
    await stop(app);
  }
}

async function runMerge(launch: Launch, out: string): Promise<void> {
  const app = await launch();
  try {
    await app.client.waitForRenderIdle();
    await saveMerge(app, out);
  } finally {
    await stop(app);
  }
}

async function saveMerge(app: App, out: string): Promise<void> {
  await app.client.setNotificationsEnabled(false);
  sendCommand(app.frame, cmdId("CmdMergePDF"));
  await pollUntil(
    async () => (await app.client.request(ControlCommand.TestMergePdf, ["", "", 0]))[0],
    (code) => code === 0,
  );
  const res = await app.client.request(ControlCommand.TestMergePdf, ["saveas", out, 0]);
  assert.equal(res[1], "OK saved=1");
}

export async function testit(): Promise<void> {
  // ng's tool dialogs have no Win32 edit to drive
  if (USE_NG) {
    console.log("skip pdf-tools-encrypted: orig only");
    return;
  }
  const dir = tmpPath("pdf-tools-encrypted");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await checkRedactedTools(join(dir, "redacted"));
  await checkDirtyPageRanges(dir, []);
  const edited = join(dir, "edited");
  mkdirSync(edited);
  await checkDirtyPageRanges(edited, ["-pwd", kPassword]);

  // unlocked with a key remembered in file history: the engine has no password
  const appdata = join(dir, "appdata");
  mkdirSync(appdata);
  const rc4 = encrypt(dir, "rc4-40");
  writeFileSync(
    join(appdata, SETTINGS_FILE),
    `FileStates [\n\t[\n\t\tFilePath = ${rc4}\n\t\tDecryptionKey = ${rememberedKey(rc4)}\n\t]\n]\n`,
  );
  const withKey: Launch = () => launchControlled(["-appdata", appdata, rc4]);
  const both = [kPage1, kPage2];

  checkEncryptedOutput("compress", await runDialog(withKey, "CmdPdfCompress", "Compress PDF"), both);
  checkEncryptedOutput("decompress", await runDialog(withKey, "CmdPdfDecompress", "Decompress PDF"), both);
  checkEncryptedOutput("bake", await runDialog(withKey, "CmdPdfBake", "Bake PDF"), both);
  const deleted = await runDialog(withKey, "CmdPdfDeletePages", "Delete Pages From PDF", "1");
  checkEncryptedOutput("delete pages", deleted, [kPage2], [kPage1]);

  const extracted = join(dir, "extracted.pdf");
  await runExtractPages(withKey, extracted);
  checkEncryptedOutput("extract pages", extracted, [kPage2], [kPage1]);

  const merged = join(dir, "merged.pdf");
  await runMerge(withKey, merged);
  checkEncryptedOutput("merge", merged, both);

  // the text of a password-protected PDF is what the user asked for: not encrypted
  const txt = await runDialog(withKey, "CmdDocumentExtractText", "Extract Text From PDF");
  if (!readFileSync(txt, "utf8").includes(kPage1)) {
    throw new Error("pdf-tools-encrypted: extract text: wrong text");
  }

  // AES-256, opened with a password
  const aes = encrypt(dir, "aes-256");
  const withPwd: Launch = () => launchControlled(["-pwd", kPassword, aes]);
  checkEncryptedOutput("aes compress", await runDialog(withPwd, "CmdPdfCompress", "Compress PDF"), both);
}

if (import.meta.main) {
  await runStandalone(testit);
}
