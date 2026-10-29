import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";
import {
  getClassName,
  getWindowPid,
  getWindowText,
  enumChildWindows,
  enumWindows,
  sendText,
  findChildWindow,
  killAndWait,
  sendMessage,
} from "./winapi.ts";
import { pressEnter } from "./win-automation.ts";
import { ControlClient, uniquePipeName } from "./control.ts";

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

  await withControlledSumatra(
    EXE,
    async (client) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const res = await client.request(ControlCommand.TestDocumentProperties);
        if (res[0] === 0) return;
        await Bun.sleep(100);
      }
      throw new Error("Remembered password did not open the document");
    },
    ["-appdata", appdata, "-log-to-file", log, encrypted],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  const output = readFileSync(log, "utf8");
  if (!output.includes("PDFium 158.0.8111.0: opened") || output.includes("Using MuPDF fallback")) {
    throw new Error("Remembered password did not reopen in PDFium");
  }

  const rememberedDir = join(dir, "remembered");
  mkdirSync(rememberedDir);
  const pipe = uniquePipeName();
  const proc = Bun.spawn([EXE, "-appdata", rememberedDir, "-dbg-control", pipe, encrypted], {
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
    while (!remember && Date.now() < controlsDeadline) {
      enumChildWindows(dialog, (hwnd) => {
        if (getWindowText(hwnd).includes("Remember the password")) {
          remember = hwnd;
          return false;
        }
        return true;
      });
      if (!remember) await Bun.sleep(50);
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
    if (!remember) throw new Error("Remember checkbox missing");
    sendText(edit, password);
    sendMessage(remember, BM_CLICK, 0, 0);
    if (sendMessage(remember, BM_GETCHECK, 0, 0) !== 1n) throw new Error("Remember checkbox did not check");
    await pressEnter(edit);
    const client = await ControlClient.connect(pipe, 10_000);
    await client.quit();
    client.close();
    await proc.exited;
    const saved = readFileSync(join(rememberedDir, "SolokPDF-settings.txt"), "utf8");
    if (!saved.includes("ProtectedPassword = ") || !saved.includes("DecryptionKey = ") || saved.includes(password)) {
      throw new Error("Remembered password was not saved as DPAPI ciphertext");
    }
  } finally {
    if (!proc.killed && (await Promise.race([proc.exited, Bun.sleep(100).then(() => null)])) === null) {
      await killAndWait(proc);
    }
  }

  for (const engine of ["pdfium", "mupdf"]) {
    const reopenedLog = join(dir, `reopened-${engine}.log`);
    await withControlledSumatra(
      EXE,
      async (client) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const res = await client.request(ControlCommand.TestDocumentProperties);
          if (res[0] === 0) return;
          await Bun.sleep(100);
        }
        throw new Error(`${engine}: remembered password did not reopen`);
      },
      ["-appdata", rememberedDir, "-log-to-file", reopenedLog, encrypted],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
    const reopened = readFileSync(reopenedLog, "utf8");
    if (engine === "pdfium" && !reopened.includes("PDFium 158.0.8111.0: opened")) {
      throw new Error("Remembered password reopened outside PDFium");
    }
    if (reopened.includes("Using MuPDF fallback")) throw new Error(`${engine}: unexpected fallback`);
  }
}

if (import.meta.main) await runStandalone(testit);
