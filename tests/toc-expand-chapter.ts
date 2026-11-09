// Bookmarks context menu: Expand Chapter / Collapse Chapter act on the
// right-clicked entry and everything under it, leaving other chapters alone.
import { writeFileSync } from "node:fs";
import { assemblePdf, cmdId, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, pressKey } from "./win-automation.ts";
import { findSidebarTree, sidebarItemHeight, sidebarRows, type SidebarTree } from "./sidebar-tree.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getWindowPid,
  packCoords,
  getMenuItemCount,
  getMenuItemId,
  getPopupMenuHandle,
  isWindowVisible,
  postMessage,
  sendMessage,
  sleep,
  treeExpand,
  treeGetNextItem,
  treeExpandRecursively,
  treeGetRoot,
  TVE_COLLAPSE,
  TVE_EXPAND,
  TVGN_CARET,
  TVGN_NEXT,
  TVM_SELECTITEM,
  VK_ESCAPE,
  VK_RETURN,
  VK_RIGHT,
  WM_KEYDOWN,
} from "./winapi.ts";

const WM_CONTEXTMENU = 0x007b;
const MN_SELECTITEM = 0x01e5;

// Outline:
//   A
//     A1
//       A1a
//     A2
//   B
//     B1
function makePdf(): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Outlines /First 5 0 R /Last 9 0 R /Count 2 >>",
    "<< /Title (A) /Parent 4 0 R /Next 9 0 R /First 6 0 R /Last 8 0 R /Count -2 /Dest [3 0 R /Fit] >>",
    "<< /Title (A1) /Parent 5 0 R /Next 8 0 R /First 7 0 R /Last 7 0 R /Count -1 /Dest [3 0 R /Fit] >>",
    "<< /Title (A1a) /Parent 6 0 R /Dest [3 0 R /Fit] >>",
    "<< /Title (A2) /Parent 5 0 R /Prev 6 0 R /Dest [3 0 R /Fit] >>",
    "<< /Title (B) /Parent 4 0 R /Prev 5 0 R /First 10 0 R /Last 10 0 R /Count -1 /Dest [3 0 R /Fit] >>",
    "<< /Title (B1) /Parent 9 0 R /Dest [3 0 R /Fit] >>",
  ];
  return assemblePdf(objs);
}

// a shown popup menu of process `pid`; a closed one can linger hidden
async function waitForVisibleMenu(pid: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let menu = 0;
    enumWindows((h) => {
      if (getWindowPid(h) === pid && getClassName(h) === "#32768" && isWindowVisible(h)) {
        menu = h;
        return false;
      }
      return true;
    });
    if (menu) {
      return menu;
    }
    await sleep(50);
  }
  return 0;
}

enum MenuOpen {
  Mouse,
  Keyboard,
}

// open the bookmarks context menu on the top row and pick `cmd`. The keyboard
// form (-1, -1) used to also pop the document menu after it.
async function runTocMenuCmd(pid: number, tree: SidebarTree, cmd: string, how: MenuOpen): Promise<void> {
  const hwnd = tree.hwnd;
  if (how === MenuOpen.Keyboard) {
    if (tree.virtual) {
      sendMessage(hwnd, 0x8000 + 102, 14, 0);
    } else {
      sendMessage(hwnd, TVM_SELECTITEM, TVGN_CARET, treeGetRoot(hwnd));
    }
    postMessage(hwnd, WM_CONTEXTMENU, hwnd, -1);
  } else {
    const h = sidebarItemHeight(tree);
    const pt = clientToScreen(hwnd, 2 * h, h >> 1);
    postMessage(hwnd, WM_CONTEXTMENU, hwnd, packCoords(pt.x, pt.y));
  }
  const popup = await waitForVisibleMenu(pid);
  if (!popup) {
    throw new Error("bookmarks context menu did not open");
  }
  const menu = getPopupMenuHandle(popup);
  const id = cmdId(cmd);
  let pos = -1;
  for (let i = 0; i < getMenuItemCount(menu); i++) {
    if (getMenuItemId(menu, i) === id) {
      pos = i;
    }
  }
  if (pos < 0) {
    await pressKey(popup, VK_ESCAPE);
    throw new Error(`${cmd} not in the bookmarks context menu`);
  }
  postMessage(popup, MN_SELECTITEM, pos, 0);
  await pressKey(popup, VK_RETURN);
  const extra = await waitForVisibleMenu(pid, 600);
  if (extra) {
    await pressKey(extra, VK_ESCAPE);
    throw new Error(`another menu opened after the bookmarks menu (${MenuOpen[how]})`);
  }
}

function expectRows(tree: SidebarTree, want: number, what: string): void {
  const got = sidebarRows(tree);
  if (got !== want) {
    throw new Error(`${what}: ${got} visible bookmarks, want ${want}`);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("toc-expand-chapter: orig only (ng's menu is gpui)");
    return;
  }
  const pdf = tmpPath("toc-expand-chapter.pdf");
  writeFileSync(pdf, makePdf(), "latin1");

  const { proc, client, frame } = await launchControlled([pdf]);
  try {
    await client.waitForRenderIdle();
    let tree = findSidebarTree(frame, true);
    const deadline = Date.now() + 4000;
    while (!tree && Date.now() < deadline) {
      await sleep(40);
      tree = findSidebarTree(frame, true);
    }
    if (!tree) {
      throw new Error("no bookmarks tree");
    }
    const a = tree.virtual ? 0n : treeGetRoot(tree.hwnd);
    const b = tree.virtual ? 0n : treeGetNextItem(tree.hwnd, TVGN_NEXT, a);
    if (tree.virtual) {
      for (const row of [0, 1]) {
        sendMessage(tree.hwnd, 0x8000 + 102, 14, row);
        sendMessage(tree.hwnd, WM_KEYDOWN, 0x6f, 0); // VK_DIVIDE
      }
    } else {
      treeExpandRecursively(tree.hwnd, TVE_COLLAPSE);
    }
    expectRows(tree, 2, "all collapsed");

    if (tree.virtual) {
      sendMessage(tree.hwnd, 0x8000 + 102, 14, 1);
      sendMessage(tree.hwnd, WM_KEYDOWN, VK_RIGHT, 0);
    } else {
      treeExpand(tree.hwnd, TVE_EXPAND, b);
    }
    expectRows(tree, 3, "B expanded");

    await runTocMenuCmd(proc.pid, tree, "CmdTocExpandChapter", MenuOpen.Mouse);
    expectRows(tree, 6, "Expand Chapter on A");

    await runTocMenuCmd(proc.pid, tree, "CmdTocCollapseChapter", MenuOpen.Keyboard);
    expectRows(tree, 3, "Collapse Chapter on A (B stays expanded)");

    // A's children were collapsed too: expanding A one level hides A1a
    if (tree.virtual) {
      sendMessage(tree.hwnd, 0x8000 + 102, 14, 0);
      sendMessage(tree.hwnd, WM_KEYDOWN, VK_RIGHT, 0);
    } else {
      treeExpand(tree.hwnd, TVE_EXPAND, a);
    }
    expectRows(tree, 5, "A expanded one level after Collapse Chapter");
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
