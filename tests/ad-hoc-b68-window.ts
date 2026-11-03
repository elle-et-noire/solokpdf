import { assemblePdf, cmdId, runStandalone, tmpPath } from "./util.ts";
import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import {
  enumWindows,
  getClassName,
  getForegroundWindow,
  getWindow,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  postMessage,
  WM_CLOSE,
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
  if (!foreground) console.log("B68: foreground and z-order checks unavailable on this desktop");

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

  for (let i = 0; i < 3; i++) {
    const { proc, client, frame } = await launchControlled([pdf]);
    try {
      const after = getForegroundWindow();
      if (after && getWindowPid(after) === proc.pid)
        throw new Error(`launch ${i + 1} changed foreground: ${foreground} -> ${after} (frame ${frame})`);
      if (after && !isBehind(frame, after)) throw new Error(`launch ${i + 1} frame is not behind foreground`);

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
        if (afterNew && getWindowPid(afterNew) === proc.pid) throw new Error("new frame changed foreground");
        if (afterNew && !isBehind(second, afterNew)) throw new Error("new frame is not behind foreground");

        for (const command of [
          "CmdHelpAbout",
          "CmdAdvancedSettings",
          "CmdChangeTheme",
          "CmdCustomizeShortcuts",
          "CmdToggleKeyboardHelp",
          "CmdProperties",
          "CmdMergePDF",
          "CmdTabGroupSave",
          "CmdTabGroupRestore",
          "CmdSignDocument",
        ]) {
          console.log(`B68: ${command}`);
          const before = new Set<number>();
          enumWindows((hwnd) => {
            if (getWindowPid(hwnd) === proc.pid) before.add(hwnd);
            return true;
          });
          sendCommandSync(frame, cmdId(command));
          let opened = 0;
          const deadline = Date.now() + 3000;
          while (!opened && Date.now() < deadline) {
            enumWindows((hwnd) => {
              if (!before.has(hwnd) && getWindowPid(hwnd) === proc.pid && isWindowVisible(hwnd)) opened = hwnd;
              return true;
            });
            if (!opened) await sleep(50);
          }
          if (!opened) throw new Error(`${command} did not open a window`);
          for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt && command !== "CmdToggleKeyboardHelp") sendCommandSync(frame, cmdId(command));
            const after = getForegroundWindow();
            if (after && getWindowPid(after) === proc.pid)
              throw new Error(
                `${command} changed foreground: ${describeWindow(foreground)} -> ${describeWindow(after)}; frame=${describeWindow(frame)}`,
              );
          }
          postMessage(opened, WM_CLOSE, 0, 0);
          await sleep(50);
        }
        sendCommandSync(frame, cmdId("CmdFindFirst"));
        const afterFind = getForegroundWindow();
        if (afterFind && getWindowPid(afterFind) === proc.pid) throw new Error("CmdFindFirst changed foreground");
      }
    } catch (err) {
      const trace = await client.request(ControlCommand.TestActivationTrace, []).catch(() => ["trace unavailable"]);
      throw new Error(`${err}\nactivation trace:\n${trace[1] ?? trace[0]}`);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
