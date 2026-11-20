// The File menu must show both the user's external viewers (#4460) and
// "Send by E-mail...". The item after CmdOpenWithHtmlHelp was consumed as the
// slot for the external viewers and never added, and that item is
// CmdSendByEmail.
//
// Uses -appdata so it never touches the user's real settings.
//
// Run: bun tests/file-menu-send-by-email.ts [--no-build]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, cmdId, runStandalone, tmpPath, USE_NG, SETTINGS_FILE } from "./util.ts";
import {
  getMenuItemCount,
  getMenuItemId,
  getMenuItemText,
  getPopupMenuHandle,
  getSubMenu,
  postMessage,
  sendMessage,
  VK_ESCAPE,
} from "./winapi.ts";
import { killAndWait, launchSumatra, pressKey, waitForContextMenu, waitForFrame } from "./win-automation.ts";

const WM_COMMAND = 0x0111;
const kMenuBarCmdFirst = 50000;
const kFileMenuIdx = 0;
const kViewerName = "MenuTestViewer";

function menuEntries(menu: bigint): { ids: number[]; texts: string[] } {
  const ids: number[] = [];
  const texts: string[] = [];
  for (let i = 0; i < getMenuItemCount(menu); i++) {
    ids.push(getMenuItemId(menu, i));
    texts.push(getMenuItemText(menu, i));
  }
  return { ids, texts };
}

const SETTINGS = `UiLanguage = en
CheckForUpdates = false
RestoreSession = false
ExternalViewers [
\t[
\t\tCommandLine = notepad.exe "%1"
\t\tName = ${kViewerName}
\t]
]
`;

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("file-menu-send-by-email: orig menu code only, skipping for ng");
    return;
  }
  const dir = tmpPath("file-menu-send-by-email");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), SETTINGS);

  const pdf = `${import.meta.dir}/../ext/a-zlib/zlib.3.pdf`;
  const proc = launchSumatra(["-appdata", dir, pdf]);
  try {
    const frame = await waitForFrame(proc.pid!);
    // the menu bar is off by default
    sendMessage(frame, WM_COMMAND, cmdId("CmdToggleMenuBar"), 0);
    postMessage(frame, WM_COMMAND, kMenuBarCmdFirst + kFileMenuIdx, 0);
    const popup = await waitForContextMenu();
    const hmenu = getPopupMenuHandle(popup);
    const file = menuEntries(hmenu);
    let external = file;
    if (APP_NAME === "SolokPDF") {
      const i = file.texts.indexOf("Open Externally or Send");
      external = menuEntries(i >= 0 ? getSubMenu(hmenu, i) : 0n);
    }
    await pressKey(frame, VK_ESCAPE, 0);

    const got = [...file.texts, ...external.texts].join(" | ");
    if (!file.ids.includes(cmdId("CmdPrint"))) {
      throw new Error(`file-menu-send-by-email: not the File menu: ${got}`);
    }
    if (!external.texts.some((t) => t.includes(kViewerName))) {
      throw new Error(`file-menu-send-by-email: external viewer missing: ${got}`);
    }
    if (!external.ids.includes(cmdId("CmdSendByEmail"))) {
      throw new Error(`file-menu-send-by-email: CmdSendByEmail missing: ${got}`);
    }
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
