import { assemblePdf, cmdId, runStandalone, tmpPath } from "./util.ts";
import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import {
  enumWindows,
  getClassName,
  getForegroundWindow,
  getWindowPid,
  isWindowVisible,
  sendCopyDataW,
  sleep,
} from "./winapi.ts";
import { FRAME_CLASS, killAndWait, launchControlled, sendCommand, sendCommandSync } from "./win-automation.ts";

function otherFrame(pid: number, first: number): number {
  let found = 0;
  enumWindows((hwnd) => {
    if (hwnd === first || getWindowPid(hwnd) !== pid || getClassName(hwnd) !== FRAME_CLASS || !isWindowVisible(hwnd))
      return true;
    found = hwnd;
    return false;
  });
  return found;
}

export async function testit(): Promise<void> {
  const foreground = getForegroundWindow();
  if (!foreground) console.log("B68: foreground checks unavailable on this desktop");

  const pdf = tmpPath("ad-hoc-b68-window.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]),
    "latin1",
  );

  const failures: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { proc, client, frame } = await launchControlled([pdf]);
    try {
      const after = getForegroundWindow();
      if (after && getWindowPid(after) === proc.pid)
        failures.push(`launch ${i + 1} changed foreground: ${foreground} -> ${after} (frame ${frame})`);

      if (i === 0) {
        sendCommand(frame, cmdId("CmdNewWindow"));
        const deadline = Date.now() + 3000;
        let second = 0;
        while (!second && Date.now() < deadline) {
          second = otherFrame(proc.pid!, frame);
          if (!second) await sleep(50);
        }
        if (!second) throw new Error("new frame did not appear");
        await sleep(100);
        const afterNew = getForegroundWindow();
        if (afterNew && getWindowPid(afterNew) === proc.pid) failures.push("new frame changed foreground");

        sendCommandSync(frame, cmdId("CmdNewTab"));
        const afterTab = getForegroundWindow();
        if (afterTab && getWindowPid(afterTab) === proc.pid) failures.push("new tab changed foreground");
        sendCopyDataW(frame, 0x44646557, `[Open("${pdf}", 0, 1, 0)]`);
        const afterOpen = getForegroundWindow();
        if (afterOpen && getWindowPid(afterOpen) === proc.pid) failures.push("opening document changed foreground");
      }
      if (failures.length) {
        const trace = await client.request(ControlCommand.TestActivationTrace, []).catch(() => ["trace unavailable"]);
        failures.push(`activation trace:\n${trace[1] ?? trace[0]}`);
      }
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
