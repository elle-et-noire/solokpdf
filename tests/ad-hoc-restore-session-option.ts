import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdId, makeTopBottomPdf, runStandalone, tmpPath } from "./util.ts";
import { ControlCommand } from "./control.ts";
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

  const pdf = tmpPath("restore-session-option.pdf");
  writeFileSync(pdf, makeTopBottomPdf(2));
  const opened = await launchControlled(["-appdata", dir, pdf], { saveSettings: true });
  try {
    await opened.client.waitForRenderIdle();
  } finally {
    await opened.client.quit().catch(() => {});
    await killAndWait(opened.proc);
  }

  const withSession = readFileSync(path, "utf8");
  if (!withSession.includes("SessionData")) throw new Error("Session data was not saved");
  writeFileSync(path, withSession.replace(/RememberOpenedFiles\s*=\s*true/, "RememberOpenedFiles = false"));
  const noHistory = await launchControlled(["-appdata", dir], { saveSettings: true });
  try {
    await noHistory.client.waitForSessionRestored();
    const tab = await noHistory.client.request(ControlCommand.TestCurrentTab, []);
    if (String(tab[1]).includes(pdf)) throw new Error("Session restored while file history was disabled");
  } finally {
    await noHistory.client.quit().catch(() => {});
    await killAndWait(noHistory.proc);
  }
}

if (import.meta.main) await runStandalone(testit);
