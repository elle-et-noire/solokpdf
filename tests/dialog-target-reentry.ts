import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ControlCommand } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { cmdId, EXE, makeTextPdf, pollUntil, runStandalone, tmpPath, USE_NG } from "./util.ts";
import {
  killAndWait,
  launchControlled,
  pressEnter,
  sendCommandAsync,
  takeStderr,
  waitForTitle,
} from "./win-automation.ts";
import {
  enumChildWindows,
  enumWindows,
  findChildWindow,
  getClassName,
  getControlText,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  postMessage,
  sendCopyDataW,
  sendText,
  waitForTopWindow,
  WM_COMMAND,
  WM_CLOSE,
} from "./winapi.ts";

const kDdeCopyData = 0x44646557;

async function checkExit(app: Awaited<ReturnType<typeof launchControlled>>): Promise<void> {
  await Promise.race([
    app.client.quit(),
    Bun.sleep(8000).then(() => {
      throw new Error("quit timed out");
    }),
  ]);
  const exit = await Promise.race([app.proc.exited, Bun.sleep(8000).then(() => -1)]);
  if (exit === -1) throw new Error("process did not exit");
  const stderr = await takeStderr(app.proc);
  if (exit !== 0 || /AddressSanitizer|runtime error/i.test(stderr)) {
    throw new Error(`exit=${exit} stderr=${stderr}`);
  }
}

async function checkSave(engine: string, mode: "same" | "switch" | "close" | "reload"): Promise<void> {
  const dir = tmpPath(`dialog-target-reentry/save-${engine}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const original = join(dir, "original.pdf");
  const other = join(dir, "other.pdf");
  const saved = join(dir, "saved.pdf");
  writeFileSync(original, makeTextPdf("ORIGINAL"));
  writeFileSync(other, makeTextPdf("OTHER"));
  const app = await launchControlled([original], {
    env: { ...process.env, SOLOKPDF_ENGINE: engine },
    startupDiagnosticsDir: dir,
  });
  let saveCommand: Promise<Error | null> | undefined;
  try {
    await app.client.waitForRenderIdle();
    if (mode === "close") {
      if (!sendCopyDataW(app.frame, kDdeCopyData, `[Open("${other.replaceAll("\\", "/")}",0,0,0)]`)) {
        throw new Error("DDE open failed");
      }
      await waitForTitle(app.frame, (title) => title.includes("other.pdf"));
      postMessage(app.frame, WM_COMMAND, cmdId("CmdPrevTab"), 0);
      await waitForTitle(app.frame, (title) => title.includes("original.pdf"));
    }
    saveCommand = sendCommandAsync(app.frame, cmdId("CmdSaveAs")).then(
      () => null,
      (error: Error) => error,
    );
    const dialog = await waitForTopWindow(app.proc.pid!, "#32770", 10000);
    if (!dialog) throw new Error("Save As dialog did not open");
    const initialNames = [basename(original), basename(original, ".pdf")];
    const edit = await pollUntil(
      () => {
        let result = 0;
        enumChildWindows(dialog, (hwnd) => {
          if (getClassName(hwnd) === "Edit" && isWindowVisible(hwnd) && initialNames.includes(getControlText(hwnd))) {
            result = hwnd;
            return false;
          }
          return true;
        });
        return result;
      },
      (hwnd) => hwnd !== 0,
      { error: "Save As filename field was not initialized" },
    );
    if (mode === "switch") {
      if (!sendCopyDataW(app.frame, kDdeCopyData, `[Open("${other.replaceAll("\\", "/")}",0,0,0)]`)) {
        throw new Error("DDE open failed");
      }
      await waitForTitle(app.frame, (title) => title.includes("other.pdf"));
    }
    if (mode === "close") {
      if (!sendCopyDataW(app.frame, kDdeCopyData, "[CmdClose]")) throw new Error("DDE close failed");
      await waitForTitle(app.frame, (title) => title.includes("other.pdf"));
    }
    if (mode === "reload") {
      writeFileSync(original, makeTextPdf("REPLACED"));
      if (!sendCopyDataW(app.frame, kDdeCopyData, `[Open("${original.replaceAll("\\", "/")}",0,0,1)]`)) {
        throw new Error("DDE reload failed");
      }
      const text = await app.client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
      if (text[0] !== 0 || !String(text[1]).includes("REPLACED")) throw new Error(`reload did not replace: ${text}`);
    }
    sendText(edit, saved);
    const entered = getControlText(edit);
    if (entered !== saved) throw new Error(`Save As filename is '${entered}', expected '${saved}'`);
    postMessage(dialog, WM_COMMAND, 1, 0);
    await pollUntil(
      () => isWindowVisible(dialog),
      (visible) => !visible,
      { error: "Save As did not close" },
    );
    const error = await saveCommand;
    if (error) throw error;
    await app.client.waitForRenderIdle();
    if (mode === "same" && !existsSync(saved)) throw new Error(`${engine}: ordinary Save As made no file`);
    if (mode !== "same" && existsSync(saved)) throw new Error(`${engine}: stale Save As was not cancelled`);
    if (existsSync(saved) && !readFileSync(saved).equals(readFileSync(original))) {
      throw new Error(`${engine}: Save As wrote the switched document`);
    }
    await checkExit(app);
    console.log(`${engine}: Save As ${mode} target checked`);
  } finally {
    app.client.close();
    await killAndWait(app.proc);
    await saveCommand;
  }
}

async function checkReload(engine: string, accept: boolean): Promise<void> {
  const dir = tmpPath(`dialog-target-reentry/reload-${engine}-${accept}`);
  mkdirSync(dir, { recursive: true });
  const original = join(dir, "original.pdf");
  const encrypted = join(dir, "encrypted.pdf");
  const other = join(dir, "other.pdf");
  writeFileSync(original, makeTextPdf("ORIGINAL"));
  writeFileSync(other, makeTextPdf("OTHER"));
  const enc = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", "pw", "-O", "owner", original, encrypted]);
  if (enc.exitCode !== 0) throw new Error(`encrypt failed: ${enc.stderr.toString()}`);
  const app = await launchControlled([original], { env: { ...process.env, SOLOKPDF_ENGINE: engine } });
  try {
    await app.client.waitForRenderIdle();
    copyFileSync(encrypted, original);
    postMessage(app.frame, WM_COMMAND, cmdId("CmdReloadDocument"), 0);
    const dialog = await pollUntil(
      () => {
        let found = 0;
        enumWindows((hwnd) => {
          if (getWindowPid(hwnd) === app.proc.pid && getWindowText(hwnd) === "Enter password") found = hwnd;
          return !found;
        });
        return found;
      },
      (hwnd) => hwnd !== 0,
      { error: "reload password dialog did not open" },
    );
    if (!sendCopyDataW(app.frame, kDdeCopyData, `[Open("${other.replaceAll("\\", "/")}",0,0,0)]`)) {
      throw new Error("DDE open during reload failed");
    }
    await waitForTitle(app.frame, (title) => title.includes("other.pdf"));
    if (accept) {
      const edit = findChildWindow(dialog, "Edit");
      if (!edit) throw new Error("password edit not found");
      sendText(edit, "pw");
      await pressEnter(edit);
    } else {
      postMessage(dialog, WM_CLOSE, 0, 0);
    }
    await pollUntil(
      () => isWindowVisible(dialog),
      (visible) => !visible,
      { error: "password dialog did not close" },
    );
    await app.client.waitForRenderIdle();
    const text = await app.client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
    if (text[0] !== 0 || !String(text[1]).includes("OTHER")) {
      throw new Error(`${engine}: reload replaced the switched tab: ${text}`);
    }
    writeFileSync(original, makeTextPdf("ORIGINAL"));
    postMessage(app.frame, WM_COMMAND, cmdId("CmdPrevTab"), 0);
    await waitForTitle(app.frame, (title) => title.includes("original.pdf"));
    const originalText = await app.client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
    if (originalText[0] !== 0 || !String(originalText[1]).includes("ORIGINAL")) {
      throw new Error(`${engine}: original tab was lost: ${originalText}`);
    }
    await checkExit(app);
    console.log(`${engine}: reload ${accept ? "accepted" : "cancelled"} after switching checked`);
  } finally {
    app.client.close();
    await killAndWait(app.proc);
  }
}

async function checkReloadClose(engine: string): Promise<void> {
  const dir = tmpPath(`dialog-target-reentry/close-${engine}`);
  mkdirSync(dir, { recursive: true });
  const original = join(dir, "original.pdf");
  const encrypted = join(dir, "encrypted.pdf");
  const other = join(dir, "other.pdf");
  writeFileSync(original, makeTextPdf("ORIGINAL"));
  writeFileSync(other, makeTextPdf("OTHER"));
  const enc = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", "pw", "-O", "owner", original, encrypted]);
  if (enc.exitCode !== 0) throw new Error(`encrypt failed: ${enc.stderr.toString()}`);
  const app = await launchControlled([original], { env: { ...process.env, SOLOKPDF_ENGINE: engine } });
  try {
    await app.client.waitForRenderIdle();
    if (!sendCopyDataW(app.frame, kDdeCopyData, `[Open("${other.replaceAll("\\", "/")}",0,0,0)]`)) {
      throw new Error("DDE open failed");
    }
    await waitForTitle(app.frame, (title) => title.includes("other.pdf"));
    postMessage(app.frame, WM_COMMAND, cmdId("CmdPrevTab"), 0);
    await waitForTitle(app.frame, (title) => title.includes("original.pdf"));
    copyFileSync(encrypted, original);
    postMessage(app.frame, WM_COMMAND, cmdId("CmdReloadDocument"), 0);
    const dialog = await pollUntil(
      () => {
        let found = 0;
        enumWindows((hwnd) => {
          if (getWindowPid(hwnd) === app.proc.pid && getWindowText(hwnd) === "Enter password") found = hwnd;
          return !found;
        });
        return found;
      },
      (hwnd) => hwnd !== 0,
      { error: "reload password dialog did not open" },
    );
    if (!sendCopyDataW(app.frame, kDdeCopyData, "[CmdClose]")) throw new Error("DDE close failed");
    await waitForTitle(app.frame, (title) => title.includes("other.pdf"));
    if (isWindowVisible(dialog)) postMessage(dialog, WM_CLOSE, 0, 0);
    await app.client.waitForRenderIdle();
    const text = await app.client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
    if (text[0] !== 0 || !String(text[1]).includes("OTHER")) throw new Error(`close lost other tab: ${text}`);
    await checkExit(app);
    console.log(`${engine}: close target during reload checked`);
  } finally {
    app.client.close();
    await killAndWait(app.proc);
  }
}

async function checkReloadExit(engine: string): Promise<void> {
  const dir = tmpPath(`dialog-target-reentry/exit-${engine}`);
  mkdirSync(dir, { recursive: true });
  const original = join(dir, "original.pdf");
  const encrypted = join(dir, "encrypted.pdf");
  writeFileSync(original, makeTextPdf("ORIGINAL"));
  const enc = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", "pw", "-O", "owner", original, encrypted]);
  if (enc.exitCode !== 0) throw new Error(`encrypt failed: ${enc.stderr.toString()}`);
  const app = await launchControlled([original], { env: { ...process.env, SOLOKPDF_ENGINE: engine } });
  try {
    await app.client.waitForRenderIdle();
    copyFileSync(encrypted, original);
    postMessage(app.frame, WM_COMMAND, cmdId("CmdReloadDocument"), 0);
    await pollUntil(
      () => {
        let found = false;
        enumWindows((hwnd) => {
          if (getWindowPid(hwnd) === app.proc.pid && getWindowText(hwnd) === "Enter password") found = true;
          return !found;
        });
        return found;
      },
      (found) => found,
      { error: "reload password dialog did not open" },
    );
    await checkExit(app);
    console.log(`${engine}: exit during reload checked`);
  } finally {
    app.client.close();
    await killAndWait(app.proc);
  }
}

async function checkReloadSame(engine: string): Promise<void> {
  const dir = tmpPath(`dialog-target-reentry/same-${engine}`);
  mkdirSync(dir, { recursive: true });
  const original = join(dir, "original.pdf");
  const updated = join(dir, "updated.pdf");
  const encrypted = join(dir, "encrypted.pdf");
  writeFileSync(original, makeTextPdf("ORIGINAL"));
  writeFileSync(updated, makeTextPdf("UPDATED"));
  const enc = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", "pw", "-O", "owner", updated, encrypted]);
  if (enc.exitCode !== 0) throw new Error(`encrypt failed: ${enc.stderr.toString()}`);
  const app = await launchControlled([original], { env: { ...process.env, SOLOKPDF_ENGINE: engine } });
  try {
    await app.client.waitForRenderIdle();
    copyFileSync(encrypted, original);
    postMessage(app.frame, WM_COMMAND, cmdId("CmdReloadDocument"), 0);
    const dialog = await pollUntil(
      () => {
        let found = 0;
        enumWindows((hwnd) => {
          if (getWindowPid(hwnd) === app.proc.pid && getWindowText(hwnd) === "Enter password") found = hwnd;
          return !found;
        });
        return found;
      },
      (hwnd) => hwnd !== 0,
      { error: "reload password dialog did not open" },
    );
    const edit = findChildWindow(dialog, "Edit");
    if (!edit) throw new Error("password edit not found");
    sendText(edit, "pw");
    await pressEnter(edit);
    await pollUntil(
      () => isWindowVisible(dialog),
      (visible) => !visible,
      { error: "password dialog did not close" },
    );
    await app.client.waitForRenderIdle();
    const text = await app.client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
    if (text[0] !== 0 || !String(text[1]).includes("UPDATED")) throw new Error(`reload lost updated text: ${text}`);
    await checkExit(app);
    console.log(`${engine}: reload unchanged target checked`);
  } finally {
    app.client.close();
    await killAndWait(app.proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG || !IS_WIN) return;
  rmSync(tmpPath("dialog-target-reentry"), { recursive: true, force: true });
  for (const engine of ["pdfium", "mupdf"]) {
    await checkReloadSame(engine);
    await checkReload(engine, false);
    await checkReload(engine, true);
    await checkReloadClose(engine);
    await checkReloadExit(engine);
    await checkSave(engine, "same");
    await checkSave(engine, "switch");
    await checkSave(engine, "close");
    await checkSave(engine, "reload");
  }
}

if (import.meta.main) await runStandalone(testit);
