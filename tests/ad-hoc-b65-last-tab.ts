import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { cmdId, makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import {
  enumWindows,
  getClassName,
  getWindowPid,
  sendCopyDataW,
  sendMessage,
  sleep,
  WM_CLOSE,
  WM_COMMAND,
} from "./winapi.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("b65-last-tab.pdf");
  writeFileSync(pdf, makeTextPdf("last tab state"));

  const { proc, client, frame } = await launchControlled([pdf]);
  try {
    await client.waitForRenderIdle();
    const changed = await client.request(ControlCommand.TestPageAdjust, [40, 60]);
    if (changed[0] !== 0) throw new Error(`set page adjustment: ${changed[1]}`);

    sendMessage(frame, WM_COMMAND, cmdId("CmdClose"), 0);
    if (!sendCopyDataW(frame, 0x44646557, `[Open("${pdf}", 0, 1, 0)]`)) {
      throw new Error("reopen failed");
    }
    await client.waitForRenderIdle();

    const state = await client.request(ControlCommand.TestPageAdjust, []);
    if (state[0] !== 0 || !String(state[1]).includes("brightness=40 contrast=60 fs=40,60")) {
      throw new Error(`last tab lost page adjustment: ${state[1]}`);
    }

    sendMessage(frame, WM_COMMAND, cmdId("CmdNewWindow"), 0);
    let second = 0;
    const deadline = Date.now() + 3000;
    while (!second && Date.now() < deadline) {
      enumWindows((hwnd) => {
        if (hwnd !== frame && getWindowPid(hwnd) === proc.pid && getClassName(hwnd) === "SOLOK_PDF_FRAME") {
          second = hwnd;
          return false;
        }
        return true;
      });
      if (!second) await sleep(50);
    }
    if (!second) throw new Error("second window did not open");

    const changedAgain = await client.request(ControlCommand.TestPageAdjust, [35, 55]);
    if (changedAgain[0] !== 0) throw new Error(`set second page adjustment: ${changedAgain[1]}`);
    sendMessage(frame, WM_COMMAND, cmdId("CmdZoom200"), 0);
    const zoomBefore = await client.request(ControlCommand.TestDisplayMode, ["get"]);
    if (zoomBefore[0] !== 0 || !String(zoomBefore[1]).includes("zoom=200")) {
      throw new Error(`zoom did not change: ${zoomBefore[1]}`);
    }

    sendMessage(frame, WM_CLOSE, 0, 0);
    if (!sendCopyDataW(second, 0x44646557, `[Open("${pdf}", 0, 1, 0)]`)) {
      throw new Error("reopen in second window failed");
    }
    await client.waitForRenderIdle();

    const windowState = await client.request(ControlCommand.TestPageAdjust, []);
    if (windowState[0] !== 0 || !String(windowState[1]).includes("brightness=35 contrast=55 fs=35,55")) {
      throw new Error(`window close lost page adjustment: ${windowState[1]}`);
    }
    const zoomAfter = await client.request(ControlCommand.TestDisplayMode, ["get"]);
    if (zoomAfter[0] !== 0 || !String(zoomAfter[1]).includes("zoom=200")) {
      throw new Error(`window close lost zoom: ${zoomAfter[1]}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
