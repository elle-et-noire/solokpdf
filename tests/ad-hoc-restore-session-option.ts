import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdId, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, pressEnter, sendCommand, waitToolWindow } from "./win-automation.ts";
import { enumChildWindows, getWindowText, isWindowEnabled, sendMessage, sleep } from "./winapi.ts";

const BM_GETCHECK = 0x00f0;
const BM_CLICK = 0x00f5;

function button(dialog: number, label: string): number {
  let found = 0;
  enumChildWindows(dialog, (hwnd) => {
    if (getWindowText(hwnd).replaceAll("&", "") !== label) return true;
    found = hwnd;
    return false;
  });
  if (!found) throw new Error(`Settings button missing: ${label}`);
  return found;
}

function checked(hwnd: number): boolean {
  return sendMessage(hwnd, BM_GETCHECK, 0, 0) !== 0n;
}

export async function testit(): Promise<void> {
  const dir = tmpPath("restore-session-option");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SolokPDF-settings.txt");
  writeFileSync(
    path,
    "UiLanguage = en\nCheckForUpdates = false\nRememberOpenedFiles = false\nRestoreSession = false\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir], { saveSettings: true });
  try {
    sendCommand(frame, cmdId("CmdOptions"));
    const dialog = await waitToolWindow(client, proc.pid!, "options", { title: "Settings" });
    if (!dialog) throw new Error("Settings dialog did not open");

    const remember = button(dialog, "Remember opened files");
    const restore = button(dialog, "Reopen last documents at startup");
    if (isWindowEnabled(restore) || checked(restore))
      throw new Error("Restore option should start disabled and unchecked");

    sendMessage(remember, BM_CLICK, 0, 0);
    if (!isWindowEnabled(restore)) throw new Error("Restore option did not enable with file history");
    sendMessage(restore, BM_CLICK, 0, 0);
    if (!checked(restore)) throw new Error("Restore option did not toggle");
    sendMessage(remember, BM_CLICK, 0, 0);
    if (isWindowEnabled(restore)) throw new Error("Restore option did not disable with file history");
    sendMessage(remember, BM_CLICK, 0, 0);
    await pressEnter(dialog);
    await sleep(500);

    const saved = readFileSync(path, "utf8");
    if (!/RememberOpenedFiles\s*=\s*true/.test(saved) || !/RestoreSession\s*=\s*true/.test(saved)) {
      throw new Error(`Settings were not saved:\n${saved}`);
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
