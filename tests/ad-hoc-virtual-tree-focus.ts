import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control";
import { makeBookmarkedPdf } from "./toc-tree-sent-click";
import { cmdId, runStandalone, tmpPath, writeAppdata } from "./util";
import { activateTestFrame, killAndWait, launchControlled, pressKey, sendCommandSync } from "./win-automation";
import {
  findChildWindow,
  enumWindows,
  getClassName,
  getFocusedHwnd,
  getMenuItemCount,
  getMenuItemId,
  getParentWindow,
  getPopupMenuHandle,
  getWindowPid,
  isWindowVisible,
  packCoords,
  postMessage,
  sendMessage,
  sendText,
  sleep,
  VK_ESCAPE,
  VK_TAB,
  WM_KEYDOWN,
  WM_LBUTTONDOWN,
} from "./winapi";

const WM_CONTEXTMENU = 0x007b;

async function waitMenu(pid: number, timeout = 3000): Promise<number> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let menu = 0;
    enumWindows((hwnd) => {
      if (getWindowPid(hwnd) === pid && getClassName(hwnd) === "#32768" && isWindowVisible(hwnd)) {
        menu = hwnd;
        return false;
      }
      return true;
    });
    if (menu) return menu;
    await sleep(40);
  }
  return 0;
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("virtual-tree-focus.pdf");
  const other = tmpPath("virtual-tree-focus-other.pdf");
  writeFileSync(pdf, makeBookmarkedPdf());
  writeFileSync(other, makeBookmarkedPdf());
  const appdata = writeAppdata("virtual-tree-focus-settings", "ShowToc = true\nShowFavorites = true\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf, other], {
    env: { SOLOKPDF_VIRTUAL_TOC: "1", SOLOKPDF_VIRTUAL_FAVORITES: "1" },
  });
  try {
    await client.waitForRenderIdle();
    const add = await client.request(ControlCommand.TestFavoriteNav, ["add", 1]);
    assert.equal(add[0], 0, `adding favorite: ${add}`);
    const toc = findChildWindow(frame, "SumatraVirtualBookmarksTree");
    const favorites = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    assert.ok(toc && favorites, "sidebar trees unavailable");
    if (!isWindowVisible(favorites)) sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    assert.ok(isWindowVisible(toc) && isWindowVisible(favorites), "sidebar trees not visible");
    const filter = findChildWindow(getParentWindow(getParentWindow(favorites)), "Edit");
    assert.ok(filter, "favorites filter unavailable");
    sendText(filter, "virtual-tree-focus");
    sendText(filter, "");
    await activateTestFrame(client);
    sendMessage(toc, WM_LBUTTONDOWN, 0, packCoords(40, 5));
    assert.equal(getFocusedHwnd(frame), toc, "bookmark tree did not receive focus");
    sendMessage(toc, WM_KEYDOWN, VK_TAB, 0);
    assert.equal(getFocusedHwnd(frame), favorites, "Tab did not move from bookmarks to favorites");
    await client.request(ControlCommand.TestFocusState, ["shift-down"]);
    sendMessage(favorites, WM_KEYDOWN, VK_TAB, 0);
    await client.request(ControlCommand.TestFocusState, ["shift-up"]);
    assert.equal(getFocusedHwnd(frame), toc, "Shift+Tab did not move from favorites to bookmarks");
    sendMessage(toc, WM_KEYDOWN, VK_TAB, 0);
    assert.equal(getFocusedHwnd(frame), favorites, "Tab did not return to favorites");
    assert.equal(Number(sendMessage(favorites, 0x8000 + 102, 14, 0)), 1, "favorite selection failed");
    postMessage(favorites, WM_CONTEXTMENU, favorites, -1);
    const popup = await waitMenu(proc.pid!);
    assert.ok(popup, "favorites keyboard menu did not open");
    const menu = getPopupMenuHandle(popup);
    const ids = Array.from({ length: getMenuItemCount(menu) }, (_, i) => getMenuItemId(menu, i));
    assert.ok(ids.includes(cmdId("CmdFavoriteDel")), `favorites keyboard menu lacks Delete Favorite: ${ids}`);
    await pressKey(popup, VK_ESCAPE, 100);
    assert.equal(await waitMenu(proc.pid!, 600), 0, "another menu opened after the favorites menu");
    await pressKey(favorites, 0x75, 100); // VK_F6
    assert.equal(getFocusedHwnd(frame), frame, "F6 did not move focus to the document");
    await pressKey(frame, 0x75, 100);
    assert.equal(getFocusedHwnd(frame), toc, "F6 did not return focus to bookmarks");
    const before = String((await client.request(ControlCommand.TestCurrentTab, []))[1]);
    await client.request(ControlCommand.TestFocusState, ["ctrl-down"]);
    sendMessage(toc, WM_KEYDOWN, VK_TAB, 0);
    await client.request(ControlCommand.TestFocusState, ["ctrl-up"]);
    const after = String((await client.request(ControlCommand.TestCurrentTab, []))[1]);
    assert.notEqual(after, before, "Ctrl+Tab did not change documents");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
