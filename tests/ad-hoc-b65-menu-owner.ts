import { writeFileSync } from "node:fs";
import { testit as favoritesMenu } from "./favorites-menu.ts";
import { testit as recentFilesMenu } from "./recent-files-menu.ts";
import { cmdId, makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, waitForContextMenu } from "./win-automation.ts";
import { postMessage, sendMessage, VK_ESCAPE, WM_COMMAND, WM_KEYDOWN } from "./winapi.ts";

const MENU_BAR_FIRST_COMMAND = 50000;

export async function testit(): Promise<void> {
  const pdf = tmpPath("b65-menu-owner.pdf");
  writeFileSync(pdf, makeTextPdf("background menu"));

  const app = await launchControlled([pdf]);
  try {
    sendMessage(app.frame, WM_COMMAND, cmdId("CmdToggleMenuBar"), 0);
    postMessage(app.frame, WM_COMMAND, MENU_BAR_FIRST_COMMAND, 0);
    const menu = await waitForContextMenu(1500, app.frame);
    if (!menu) throw new Error("background menu did not open");

    try {
      await favoritesMenu();
      await recentFilesMenu();
    } finally {
      postMessage(menu, WM_KEYDOWN, VK_ESCAPE, 0);
    }
  } finally {
    app.client.close();
    await killAndWait(app.proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
