// E72: -dbg-control Quit with an uncommitted in-place edit (FreeText annotation or form
// text field) exits without showing the "Unsaved changes" prompt.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { annotFixture, fixture, startAnnotInput, startInput } from "./pending-document-input.ts";
import { cmdId, runStandalone, SETTINGS_FILE, SLOW_BUILD_FACTOR, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { enumWindows, getClassName, getWindowPid, getWindowText, isWindowVisible, postMessage } from "./winapi.ts";

const kQuitTimeoutMs = 15000 * SLOW_BUILD_FACTOR;
const kClickButton = 0x0400 + 102; // TDM_CLICK_BUTTON
const kBtnDiscard = 100;

function visibleDialog(pid: number): number {
  let found = 0;
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) !== pid || getClassName(hwnd) !== "#32770" || !isWindowVisible(hwnd)) return true;
    found = hwnd;
    return false;
  });
  return found;
}

async function checkQuit(engine: string, input: "FreeText" | "text"): Promise<void> {
  const label = `${engine}-${input}`;
  const dir = tmpPath(`quit-pending-input/${label}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nRestoreSession = false\nLazyLoading = false\n");
  const source = join(dir, "source.pdf");
  writeFileSync(source, input === "text" ? fixture("ORIGINAL") : annotFixture("ORIGINAL", "FreeText"), "latin1");

  const { proc, client, frame } = await launchControlled(["-appdata", dir, "-zoom", "fit page", source], {
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    await client.waitForRenderIdle();
    if (input === "FreeText") sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
    const canvas = findCanvas(frame);
    if (input === "text") await startInput(client, canvas, "text");
    else await startAnnotInput(client, canvas, proc.pid!, "FreeText");

    // the document is clean until the pending edit is committed
    await client.request(ControlCommand.Quit);
    client.close();
    const deadline = Date.now() + kQuitTimeoutMs;
    while (proc.exitCode === null) {
      const dlg = visibleDialog(proc.pid!);
      if (dlg) {
        const title = getWindowText(dlg);
        postMessage(dlg, kClickButton, kBtnDiscard, 0);
        throw new Error(`${label}: Quit showed dialog '${title}'`);
      }
      if (Date.now() > deadline) throw new Error(`${label}: app did not exit within ${kQuitTimeoutMs} ms of Quit`);
      await Bun.sleep(50);
    }
    if (proc.exitCode !== 0) throw new Error(`${label}: exit code ${proc.exitCode}`);
    console.log(`${label}: Quit exited without a prompt`);
  } finally {
    if (proc.exitCode === null) await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP ad-hoc-quit-pending-input: Windows edit controls only");
    return;
  }
  const failures: string[] = [];
  for (const engine of ["pdfium", "mupdf"]) {
    for (const input of ["FreeText", "text"] as const) {
      try {
        await checkQuit(engine, input);
      } catch (e) {
        failures.push(String(e));
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
