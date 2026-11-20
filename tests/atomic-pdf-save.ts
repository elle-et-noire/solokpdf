import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import {
  APP_NAME,
  assemblePdf,
  cmdId,
  EXE,
  extractPageText,
  makeTextPdf,
  pollUntil,
  runStandalone,
  SETTINGS_FILE,
  tmpPath,
  USE_NG,
} from "./util.ts";
import {
  findCanvas,
  FRAME_CLASS,
  killAndWait,
  launchControlled,
  pressEnter,
  sendCommand,
  waitToolWindow,
} from "./win-automation.ts";
import {
  enumChildWindows,
  getClassName,
  getControlText,
  findTopWindow,
  isWindowVisible,
  observeProcessExit,
  postMessage,
  sendCopyDataW,
  sendText,
  VK_NEXT,
  waitForTopWindow,
  WM_CLOSE,
  WM_KEYDOWN,
} from "./winapi.ts";

function copySource(padding: number, withAnnotation: boolean): Buffer {
  const content = "BT /F1 18 Tf 72 200 Td (COPIED SOURCE) Tj ET";
  return Buffer.from(
    assemblePdf(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ${withAnnotation ? "/Annots [6 0 R]" : ""} >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Annot /Subtype /Square /P 3 0 R /Rect [72 50 150 100] /Contents (ORIGINAL) >>",
      ],
      { header: `%PDF-1.7\n%${"x".repeat(padding)}\n` },
    ),
    "latin1",
  );
}

async function check(engine: string, size: "small" | "big" | "merge" | "copy", failure: string): Promise<boolean> {
  const label = `${engine}-${size}-${failure}`;
  const dir = tmpPath(`atomic-pdf-save/${label}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.pdf");
  const dest = join(dir, "keep.pdf");
  const original = makeTextPdf("KEEP THIS FILE");
  const padding = size === "merge" ? 0 : size === "big" ? 33 * 1024 * 1024 : 256 * 1024;
  const data = copySource(padding, size === "copy");
  writeFileSync(source, data);
  writeFileSync(dest, original);
  if (failure === "p") chmodSync(dest, 0o444);
  let ran = false;
  let nativeExit: (() => number | null) | undefined;
  try {
    ran = await withControlledSumatra(
      EXE,
      async (client, proc) => {
        nativeExit = observeProcessExit(proc.pid!);
        await client.waitForRenderIdle();
        if ((await client.request(ControlCommand.TestCurrentPdf, ["save-faults"]))[1] !== "supported") {
          console.log("SKIP atomic-pdf-save: Debug fault injection unavailable");
          return false;
        }
        const before = readdirSync(dir).sort().join("\n");
        if (size === "copy") {
          const edited = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "COPIED EDIT"]);
          if (!String(edited[1]).includes("changed=1")) throw new Error(`${label}: could not edit: ${edited[1]}`);
          const saved = await client.request(ControlCommand.TestCurrentPdf, ["save-copy", dest]);
          if (String(saved[1]) !== `saved=${failure ? 0 : 1}`) throw new Error(`${label}: ${saved[1]}`);
          const state = await client.request(ControlCommand.TestMarkupAnnots);
          if (!String(state[1]).includes("modified=1")) throw new Error(`${label}: copy marked source clean`);
        } else if (size === "merge") {
          const opened = await client.request(ControlCommand.TestMergePdf, ["open", "", 0]);
          if (opened[0] !== 0) throw new Error(`Merge failed to open: ${opened[1]}`);
          const saved = await client.request(ControlCommand.TestMergePdf, ["saveas", dest, 0]);
          if (String(saved[1]) !== `OK saved=${failure ? 0 : 1}`) throw new Error(`${label}: ${saved[1]}`);
          await client.request(ControlCommand.TestMergePdf, ["close", "", 0]);
        } else {
          const saving = client.request(ControlCommand.TestSaveFileAs, [dest]);
          if (failure) {
            const dialog = await pollUntil(
              () => findTopWindow(proc.pid!, "#32770"),
              (hwnd) => !!hwnd && isWindowVisible(hwnd),
              { timeoutMs: 5000, error: "No save failure warning" },
            );
            postMessage(dialog!, WM_CLOSE, 0, 0);
          }
          const saved = await saving;
          if ((saved[0] === 0) !== !failure) throw new Error(`${label}: unexpected save result ${saved[1]}`);
        }
        if (
          !existsSync(dest) ||
          (failure
            ? !readFileSync(dest).equals(original)
            : size !== "merge" && size !== "copy" && !readFileSync(dest).equals(data))
        )
          throw new Error(`${label}: failed save destroyed the existing destination`);
        if (!failure && size === "merge") {
          await client.waitForRenderIdle();
          const text = await client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
          if (!String(text[1]).includes("COPIED SOURCE")) throw new Error(`${label}: merged output lost source text`);
        }
        if (!failure && size === "copy") {
          const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
          if (!sendCopyDataW(frame, 0x44646557, `[Open("${dest}", 0, 1, 0)]`))
            throw new Error(`${label}: reopen failed`);
          await client.waitForRenderIdle();
          const text = await client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
          const edit = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "COPIED EDIT"]);
          if (!String(text[1]).includes("COPIED SOURCE") || !String(edit[1]).includes("before='COPIED EDIT'"))
            throw new Error(`${label}: copy lost content: ${text[1]} ${edit[1]}`);
        }
        if (readdirSync(dir).sort().join("\n") !== before) throw new Error(`${label}: temporary output leaked`);
        if (!readFileSync(source).equals(data)) throw new Error(`${label}: source changed`);
        return true;
      },
      ["-appdata", join(dir, "settings"), "-log-to-file", join(dir, "app.log"), source],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_SAVE_FAILURE: failure === "p" ? "" : failure } },
    );
  } catch (error) {
    throw new Error(`${error}; native exit=${nativeExit?.()}`);
  } finally {
    nativeExit?.();
    if (existsSync(dest)) chmodSync(dest, 0o666);
  }
  if (ran) console.log(`${label}: destination preserved`);
  return ran;
}

async function checkToolCopy(engine: string, tool: "extract" | "merge"): Promise<boolean> {
  const dir = mkdtempSync(tmpPath("atomic-tool-copy-"));
  const temp = join(dir, "temp");
  mkdirSync(temp);
  const source = join(dir, "source.pdf");
  const dest = join(dir, "output.pdf");
  const data = copySource(0, true);
  const original = Buffer.from(makeTextPdf("KEEP THIS FILE"));
  writeFileSync(source, data);
  writeFileSync(dest, original);
  return withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      if ((await client.request(ControlCommand.TestCurrentPdf, ["save-faults"]))[1] !== "supported") {
        console.log("SKIP PDF tool input copy: Debug fault injection unavailable");
        return false;
      }
      const before = readdirSync(temp).sort();
      const edit = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "COPIED EDIT"]);
      assert.match(String(edit[1]), /changed=1/);
      if (tool === "merge") {
        const opened = await client.request(ControlCommand.TestMergePdf, ["open", "", 0]);
        assert.equal(opened[0], 0, String(opened[1]));
      }
      const save = () =>
        tool === "merge"
          ? client.request(ControlCommand.TestMergePdf, ["saveas", dest, 0])
          : client.request(ControlCommand.TestExtractPages, [dest, "1", 0]);
      const outputBefore = readdirSync(dir).sort();

      for (const failure of ["copy write", "output publication", ""]) {
        if (failure === "output publication") chmodSync(dest, 0o444);
        const [status, result] = await save();
        if (tool === "merge") assert.equal(result, `OK saved=${failure ? 0 : 1}`);
        else assert.equal(status, failure ? 1 : 0, String(result));
        if (failure === "output publication") chmodSync(dest, 0o666);
        if (failure) assert.deepEqual(readFileSync(dest), original, `${failure}: destination changed`);
        assert.deepEqual(readdirSync(temp).sort(), before, `${failure || "success"}: temporary input leaked`);
        assert.deepEqual(readdirSync(dir).sort(), outputBefore, `${failure || "success"}: temporary output leaked`);
      }

      assert.match(extractPageText(dest, 1), /COPIED SOURCE/);
      const decoded = join(dir, "decoded.pdf");
      const result = Bun.spawnSync([EXE, "clean", "-d", dest, decoded]);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.match(readFileSync(decoded, "latin1"), /\/Contents\s*\(COPIED EDIT\)/);
      assert.deepEqual(readFileSync(source), data);
      await client.selectTab(0);
      const state = await client.request(ControlCommand.TestMarkupAnnots);
      assert.match(String(state[1]), /undo canUndo=1 canRedo=0 modified=1/);
      return true;
    },
    ["-appdata", join(dir, "settings"), source],
    { env: { ...process.env, TEMP: temp, TMP: temp, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_SAVE_FAILURE: "f" } },
  );
}

async function checkToolDestination(engine: string, tool: "text" | "compress"): Promise<void> {
  const dir = mkdtempSync(tmpPath("atomic-tool-destination-"));
  const source = join(dir, "source.pdf");
  const moved = join(dir, "moved.pdf");
  const text = tool === "text";
  const dest = join(dir, text ? "output.txt" : "output.pdf");
  const original = Buffer.from(text ? "KEEP THIS TEXT" : makeTextPdf("KEEP THIS FILE"));
  const data = makeTextPdf("TOOL SOURCE");
  writeFileSync(source, data);
  writeFileSync(dest, original);
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nReloadModifiedDocuments = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", dir, source], {
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    await client.waitForRenderIdle();
    const title = text ? "Extract Text From PDF" : "Compress PDF";
    sendCommand(frame, cmdId(text ? "CmdDocumentExtractText" : "CmdPdfCompress"));
    const dlg = await waitToolWindow(client, proc.pid, "pdftool", { title });
    assert.ok(dlg, `Missing ${title}`);
    let edit = 0;
    enumChildWindows(dlg, (hwnd) => {
      if (getClassName(hwnd) === "Edit" && /\.(pdf|txt)$/.test(getControlText(hwnd))) edit = hwnd;
      return !edit;
    });
    assert.ok(edit, "Missing destination edit");
    sendText(edit, dest);
    const before = readdirSync(dir).sort();
    if (text) renameSync(source, moved);
    else chmodSync(dest, 0o444);

    await pressEnter(edit);
    const warning = await pollUntil(() => findTopWindow(proc.pid, "#32770"), isWindowVisible, {
      error: `${title}: missing failure warning`,
    });
    postMessage(warning, WM_CLOSE, 0, 0);
    await pollUntil(
      () => isWindowVisible(warning),
      (visible) => !visible,
    );
    if (text) renameSync(moved, source);
    else chmodSync(dest, 0o666);
    assert.deepEqual(readFileSync(dest), original, `${title}: failure changed the destination`);
    assert.deepEqual(readdirSync(dir).sort(), before, `${title}: failed output leaked`);

    await pressEnter(edit);
    await pollUntil(
      () => isWindowVisible(dlg),
      (visible) => !visible,
      { error: `${title}: retry did not finish` },
    );
    assert.match(text ? readFileSync(dest, "utf8") : extractPageText(dest, 1), /TOOL SOURCE/);
    assert.deepEqual(readdirSync(dir).sort(), before, `${title}: successful output leaked`);
    assert.deepEqual(readFileSync(source), data);
  } finally {
    if (existsSync(dest)) chmodSync(dest, 0o666);
    client.close();
    await killAndWait(proc);
  }
}

async function checkPdfTools(): Promise<void> {
  if (APP_NAME !== "SolokPDF") return;
  const failures: string[] = [];
  for (const engine of ["pdfium", "mupdf"]) {
    for (const tool of ["extract", "merge", "text", "compress"] as const) {
      const label = `${engine}-${tool}`;
      try {
        if (tool === "extract" || tool === "merge") {
          if (!(await checkToolCopy(engine, tool))) continue;
        } else {
          await checkToolDestination(engine, tool);
        }
        console.log(`${label}: output and cleanup verified`);
      } catch (error) {
        failures.push(`${label}: ${error}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

async function checkQueuedInput(engine: string, action: "save-result" | "save-copy"): Promise<void> {
  const label = `${engine}-${action}`;
  const dir = tmpPath(`atomic-pdf-save/${label}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.pdf");
  const dest = action === "save-copy" ? join(dir, "copy.pdf") : source;
  const log = join(dir, "app.log");
  const release = join(dir, "release-write");
  const original = assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 400 400] >>",
    "<< /Type /Page /Parent 2 0 R /Annots [5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R >>",
    "<< /Type /Annot /Subtype /Square /P 3 0 R /Rect [72 50 150 100] /Contents (ORIGINAL) >>",
  ]);
  writeFileSync(source, original, "latin1");

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const canvas = findCanvas(await waitForTopWindow(proc.pid!, FRAME_CLASS));
      await client.waitForRenderIdle();
      const [, pdf] = await client.request(ControlCommand.TestCurrentPdf);
      const kind = engine === "pdfium" ? "enginePdfium" : "enginePdf";
      if (!String(pdf).startsWith(`engine=${kind} `)) throw new Error(`${label}: unexpected engine: ${pdf}`);
      if ((await client.chapterInfo()).page !== 1) throw new Error(`${label}: expected page 1`);
      const [, edit] = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "PDF WRITE EDIT"]);
      if (!String(edit).includes("changed=1")) throw new Error(`${label}: ${edit}`);

      const readLog = () => readFileSync(log, "utf8");
      const saving = client.request(ControlCommand.TestCurrentPdf, [action, dest]);
      try {
        await pollUntil(readLog, (s) => s.includes("TestPdfWrite: waiting"), {
          error: `${label}: PDF write did not reach the gate`,
        });
        if (action === "save-copy" ? existsSync(dest) : readFileSync(dest, "latin1") !== original) {
          throw new Error(`${label}: destination changed before the write`);
        }
        if (!postMessage(canvas, WM_KEYDOWN, VK_NEXT, 0)) throw new Error(`${label}: could not queue Page Down`);
      } finally {
        writeFileSync(release, "");
        const [, saved] = await saving;
        if (!String(saved).startsWith("saved=1")) throw new Error(`${label}: ${saved}`);
      }

      const page = await pollUntil(
        () => client.chapterInfo(),
        (info) => info.page === 2,
        {
          error: `${label}: queued Page Down did not reach page 2`,
        },
      );
      const logged = readLog();
      const write = /TestPdfWrite: completed in (\d+\.\d+) ms/.exec(logged);
      if (!write) throw new Error(`${label}: missing write timing`);
      if (action === "save-result" && !logged.includes("incremental: 1,")) {
        throw new Error(`${label}: expected an incremental write`);
      }
      if (!readFileSync(dest, "latin1").includes("PDF WRITE EDIT")) throw new Error(`${label}: edit was not saved`);
      if (action === "save-copy" && readFileSync(source, "latin1") !== original) {
        throw new Error(`${label}: saving a copy changed the source`);
      }
      console.log(`${label}: write ${write[1]} ms, queued Page Down reached page ${page.page}`);
    },
    ["-appdata", join(dir, "settings"), "-log-to-file", log, "-view", "single page", "-zoom", "fit page", source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_PDF_WRITE_RELEASE: release } },
  );
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  if (process.argv.includes("--pdf-tools-only")) return checkPdfTools();
  if (process.argv.includes("--queued-input-only")) {
    for (const engine of ["pdfium", "mupdf"]) {
      await checkQueuedInput(engine, "save-result");
      await checkQueuedInput(engine, "save-copy");
    }
    return;
  }
  for (const engine of ["pdfium", "mupdf"]) {
    for (const size of engine === "pdfium"
      ? (["small", "big", "merge", "copy"] as const)
      : (["merge", "copy"] as const)) {
      for (const failure of size === "copy" ? ["f", "p", ""] : ["w", ...(size === "merge" ? [] : ["r"]), "p", ""]) {
        const label = `${engine}-${size}-${failure}`;
        if (process.env.ATOMIC_SAVE_CASE && process.env.ATOMIC_SAVE_CASE !== label) continue;
        if (!(await check(engine, size, failure))) return;
      }
    }
  }
  if (!process.env.ATOMIC_SAVE_CASE) await checkPdfTools();
}

if (import.meta.main) await runStandalone(testit);
