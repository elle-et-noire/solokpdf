import { cmdId, runStandalone } from "./util.ts";
import {
  enumWindows,
  getClassName,
  getForegroundWindow,
  getWindow,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  GW_HWNDNEXT,
  sleep,
} from "./winapi.ts";
import { FRAME_CLASS, killAndWait, launchControlled, sendCommand, sendCommandSync } from "./win-automation.ts";

function describeWindow(hwnd: number): string {
  return `${hwnd} class=${getClassName(hwnd)} pid=${getWindowPid(hwnd)} title=${JSON.stringify(getWindowText(hwnd))}`;
}

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

function isBehind(hwnd: number, foreground: number): boolean {
  for (let below = getWindow(foreground, GW_HWNDNEXT); below; below = getWindow(below, GW_HWNDNEXT)) {
    if (below === hwnd) return true;
  }
  return false;
}

export async function testit(): Promise<void> {
  const foreground = getForegroundWindow();
  if (!foreground) {
    console.log("SKIP B68: no foreground window");
    return;
  }

  for (let i = 0; i < 3; i++) {
    const { proc, client, frame } = await launchControlled([]);
    try {
      const after = getForegroundWindow();
      if (after !== foreground)
        throw new Error(`launch ${i + 1} changed foreground: ${foreground} -> ${after} (frame ${frame})`);
      if (!isBehind(frame, foreground)) throw new Error(`launch ${i + 1} frame is not behind foreground`);

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
        if (getForegroundWindow() !== foreground) throw new Error("new frame changed foreground");
        if (!isBehind(second, foreground)) throw new Error("new frame is not behind foreground");

        for (const command of ["CmdHelpAbout", "CmdAdvancedSettings"]) {
          sendCommandSync(frame, cmdId(command));
          sendCommandSync(frame, cmdId(command));
          const after = getForegroundWindow();
          if (after !== foreground)
            throw new Error(
              `${command} changed foreground: ${describeWindow(foreground)} -> ${describeWindow(after)}; frame=${describeWindow(frame)}`,
            );
        }
      }
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
