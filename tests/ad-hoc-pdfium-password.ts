import { pdfiumOpenLog } from "../cmd/solok-fetch-pdfium";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, ControlCommand, uniquePipeName, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  getClassName,
  getWindowPid,
  getWindowText,
  enumChildWindows,
  enumWindows,
  sendText,
  lockFileRange,
  findChildWindow,
  killAndWait,
  sendMessage,
} from "./winapi.ts";
import { openDocumentAsync, pressEnter, waitForFrame } from "./win-automation.ts";

const password = "solok-pässword";
const BM_GETCHECK = 0x00f0;
const BM_CLICK = 0x00f5;

function protectedPassword(pdf: string): string {
  const digest = new Bun.CryptoHasher("md5").update(readFileSync(pdf)).digest();
  const bytes = Buffer.from(password, "utf8");
  const values = [...bytes].join(",");
  const entropy = [...digest].join(",");
  const script =
    `Add-Type -AssemblyName System.Security;` +
    `$b=[byte[]]@(${values});` +
    `$e=[byte[]]@(${entropy});` +
    `$p=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `([BitConverter]::ToString($p) -replace '-','')`;
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`DPAPI: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export async function testit(): Promise<void> {
  const dir = tmpPath("pdfium-password");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const plain = join(dir, "plain.pdf");
  const encrypted = join(dir, "encrypted.pdf");
  const appdata = join(dir, "appdata");
  const log = join(dir, "open.log");
  mkdirSync(appdata);
  writeFileSync(
    plain,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    ]),
    "latin1",
  );
  const clean = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", password, "-O", "owner", plain, encrypted]);
  if (clean.exitCode !== 0) throw new Error(`Cannot encrypt fixture: ${clean.stderr.toString()}`);
  const sealed = protectedPassword(encrypted);
  writeFileSync(
    join(appdata, "SolokPDF-settings.txt"),
    `RememberOpenedFiles = true\nRememberStatePerDocument = true\nFileStates [\n  [\n    FilePath = ${encrypted}\n    ProtectedPassword = ${sealed}\n  ]\n]\n`,
  );

  const extracted = join(dir, "extracted.pdf");
  await withControlledSumatra(
    EXE,
    async (client) => {
      const deadline = Date.now() + 10_000;
      let opened = false;
      while (!opened && Date.now() < deadline) {
        const res = await client.request(ControlCommand.TestDocumentProperties);
        opened = res[0] === 0;
        if (!opened) await Bun.sleep(100);
      }
      if (!opened) throw new Error("Remembered password did not open the document");

      // PDF tools re-open the file and need the PDFium tab's password
      const res = await client.request(ControlCommand.TestExtractPages, [extracted, "1", 0]);
      if (res[0] !== 0) throw new Error(`Extract pages failed: ${String(res[1] ?? "").trim()}`);
    },
    ["-appdata", appdata, "-log-to-file", log, encrypted],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  const output = readFileSync(log, "utf8");
  if (!output.includes(pdfiumOpenLog) || output.includes("Using MuPDF fallback")) {
    throw new Error("Remembered password did not reopen in PDFium");
  }
  const check = Bun.spawnSync([EXE, "clean", "-p", password, "-D", extracted, join(dir, "extracted-plain.pdf")]);
  if (check.exitCode !== 0) throw new Error(`Extracted pages don't open with the password: ${check.stderr}`);

  const largePlain = join(dir, "large-plain.pdf");
  const largeEncrypted = join(dir, "large-encrypted.pdf");
  const padding = "x".repeat(33 * 1024 * 1024);
  writeFileSync(
    largePlain,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
      `<< /Length ${padding.length} >>\nstream\n${padding}\nendstream`,
    ]),
    "latin1",
  );
  const largeClean = Bun.spawnSync([
    EXE,
    "clean",
    "-E",
    "aes-256",
    "-U",
    password,
    "-O",
    "owner",
    largePlain,
    largeEncrypted,
  ]);
  if (largeClean.exitCode !== 0 || statSync(largeEncrypted).size < padding.length) {
    throw new Error(`Cannot create handle-backed encrypted fixture: ${largeClean.stderr.toString()}`);
  }
  const fingerprint = new Bun.CryptoHasher("md5").update(readFileSync(largeEncrypted)).digest("hex");
  const rememberedDir = join(dir, "remembered");
  mkdirSync(rememberedDir);
  writeFileSync(join(rememberedDir, SETTINGS_FILE), "ReloadModifiedDocuments = false\nRestoreSession = false\n");
  const moved = join(dir, "moved.pdf");
  const saved = await rememberPassword(rememberedDir, largeEncrypted, () => {
    renameSync(largeEncrypted, moved);
    writeFileSync(largeEncrypted, readFileSync(encrypted));
  });
  if (!saved.toLowerCase().includes(`decryptionkey = ${fingerprint}`)) {
    throw new Error("Remembered key fingerprint differs from the retained PDF");
  }
  if (!saved.includes("ProtectedPassword = ") || saved.includes(password)) {
    throw new Error("Remembered password was not saved as DPAPI ciphertext");
  }
  rmSync(largeEncrypted);
  renameSync(moved, largeEncrypted);
  await reopenRemembered(rememberedDir, largeEncrypted);
  console.log("Retained PDF credentials reopened in PDFium and MuPDF");
  await checkUnreadableFingerprint(dir, largeEncrypted);
  await checkFingerprintLock(plain, largeEncrypted);
}

async function rememberPassword(appdata: string, path: string, beforeAccept?: () => void): Promise<string> {
  const pipe = uniquePipeName();
  const proc = Bun.spawn([EXE, "-appdata", appdata, "-dbg-control", pipe, path], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" },
  });
  try {
    let dialog = 0;
    const deadline = Date.now() + 10_000;
    while (!dialog && Date.now() < deadline) {
      enumWindows((hwnd) => {
        if (getWindowPid(hwnd) === proc.pid && getWindowText(hwnd) === "Enter password") {
          dialog = hwnd;
          return false;
        }
        return true;
      });
      if (!dialog) await Bun.sleep(100);
    }
    if (!dialog) throw new Error("Password dialog did not appear");
    let remember = 0;
    const controlsDeadline = Date.now() + 5_000;
    while (Date.now() < controlsDeadline) {
      enumChildWindows(dialog, (hwnd) => {
        if (getWindowText(hwnd).includes("Remember the password")) {
          remember = hwnd;
          return false;
        }
        return true;
      });
      if (remember || !beforeAccept) break;
      await Bun.sleep(50);
    }
    const edit = findChildWindow(dialog, "Edit");
    if (!edit) {
      const children: string[] = [];
      enumChildWindows(dialog, (hwnd) => {
        children.push(`${getClassName(hwnd)}:${getWindowText(hwnd)}`);
        return true;
      });
      throw new Error(`Password edit missing: ${children.join(", ")}`);
    }
    if (Boolean(remember) !== Boolean(beforeAccept))
      throw new Error(`Unexpected Remember checkbox: ${Boolean(remember)}`);
    beforeAccept?.();
    sendText(edit, password);
    if (remember) {
      sendMessage(remember, BM_CLICK, 0, 0);
      if (sendMessage(remember, BM_GETCHECK, 0, 0) !== 1n) throw new Error("Remember checkbox did not check");
    }
    await pressEnter(edit);
    const client = await ControlClient.connect(pipe, 10_000);
    try {
      await waitForDocument(client);
      await client.quit();
    } finally {
      client.close();
    }
    await proc.exited;
    return readFileSync(join(appdata, SETTINGS_FILE), "utf8");
  } finally {
    if (!proc.killed && (await Promise.race([proc.exited, Bun.sleep(100).then(() => null)])) === null) {
      await killAndWait(proc);
    }
  }
}

async function checkUnreadableFingerprint(dir: string, path: string): Promise<void> {
  const appdata = join(dir, "read-failure");
  mkdirSync(appdata);
  writeFileSync(join(appdata, SETTINGS_FILE), "RememberOpenedFiles = true\nRememberStatePerDocument = true\n");
  // Only a full-file fingerprint reads the middle of the unused stream.
  const unlock = lockFileRange(path, 16 * 1024 * 1024, 1);
  try {
    const saved = await rememberPassword(appdata, path);
    if (/^\s*(DecryptionKey|ProtectedPassword) = \S/m.test(saved)) {
      throw new Error("Credentials persisted without a fingerprint");
    }
  } finally {
    unlock();
  }
  console.log("Fingerprint read failure still allowed manual opening");
}

async function checkFingerprintLock(plain: string, encrypted: string): Promise<void> {
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await waitForDocument(client);
      const frame = await waitForFrame(proc.pid!);
      const [armed, armResult] = await client.request(ControlCommand.TestCurrentPdf, [
        "park-render",
        5000,
        "fingerprint",
        0,
        0,
        "any",
      ]);
      if (armed !== 0) throw new Error(`Cannot park fingerprinting: ${armResult}`);
      if (!openDocumentAsync(frame, encrypted)) {
        throw new Error("Cannot open the encrypted tab");
      }
      const deadline = Date.now() + 4000;
      while ((await client.selectTab()).count < 2 && Date.now() < deadline) await Bun.sleep(25);
      await client.selectTab(0);
      let state = "";
      while (Date.now() < deadline) {
        state = String((await client.request(ControlCommand.TestCurrentPdf, ["park-state"]))[1]);
        if (state.includes("parked=1")) break;
        await Bun.sleep(25);
      }
      if (!state.includes("parked=1")) throw new Error(`Fingerprint did not pause: ${state}`);
      const [held, result] = await client.request(ControlCommand.TestCurrentPdf, ["hold-pdfium-lock", 1]);
      state = String((await client.request(ControlCommand.TestCurrentPdf, ["park-state"]))[1]);
      if (held !== 0 || !state.includes("parked=1")) {
        throw new Error(`Other tab could not acquire the PDFium lock during fingerprinting: ${result}, ${state}`);
      }
    },
    ["-pwd", password, plain],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  console.log("Another tab acquired the PDFium lock during fingerprinting");
}

async function waitForDocument(client: ControlClient): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await client.request(ControlCommand.TestDocumentProperties);
    if (res[0] === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("Password did not open the document");
}

async function reopenRemembered(appdata: string, path: string): Promise<void> {
  for (const engine of ["pdfium", "mupdf"]) {
    const reopenedLog = join(appdata, `reopened-${engine}.log`);
    await withControlledSumatra(EXE, waitForDocument, ["-appdata", appdata, "-log-to-file", reopenedLog, path], {
      env: { ...process.env, SOLOKPDF_ENGINE: engine },
    });
    const reopened = readFileSync(reopenedLog, "utf8");
    if (engine === "pdfium" && !reopened.includes(pdfiumOpenLog)) {
      throw new Error("Remembered password reopened outside PDFium");
    }
    if (reopened.includes("Using MuPDF fallback")) throw new Error(`${engine}: unexpected fallback`);
  }
}

if (import.meta.main) await runStandalone(testit);
