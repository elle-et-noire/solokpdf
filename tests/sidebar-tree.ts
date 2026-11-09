import {
  findChildWindow,
  findVisibleChildWindow,
  countVisibleTreeRows,
  getClientRect,
  sendMessage,
  treeGetItemHeight,
  treeGetSelection,
  treeIsItemInView,
  treeGetNextItem,
  treeGetRoot,
  TVGN_NEXTVISIBLE,
  TVGN_CARET,
  TVM_GETCOUNT,
  TVM_SELECTITEM,
} from "./winapi";

const TEST_STATE = 0x8000 + 102;
const TEST_ITEM_COUNT = 20;

export type SidebarTree = { hwnd: number; virtual: boolean };

export function findSidebarTree(
  frame: number,
  visible = false,
  kind: "bookmarks" | "favorites" = "bookmarks",
): SidebarTree | null {
  const find = visible ? findVisibleChildWindow : findChildWindow;
  const virtual = find(frame, kind === "bookmarks" ? "SumatraVirtualBookmarksTree" : "SumatraVirtualFavoritesTree");
  if (virtual) return { hwnd: virtual, virtual: true };
  const native = find(frame, "SysTreeView32");
  return native ? { hwnd: native, virtual: false } : null;
}

export function sidebarSelection(tree: SidebarTree): bigint {
  if (!tree.virtual) return treeGetSelection(tree.hwnd);
  return BigInt(Number(sendMessage(tree.hwnd, TEST_STATE, 1, 0)) + 1);
}

export function sidebarItemHeight(tree: SidebarTree): number {
  if (!tree.virtual) return treeGetItemHeight(tree.hwnd);
  return Number(sendMessage(tree.hwnd, TEST_STATE, 3, 0));
}

export function sidebarRows(tree: SidebarTree): number {
  if (!tree.virtual) return countVisibleTreeRows(tree.hwnd);
  return Number(sendMessage(tree.hwnd, TEST_STATE, 0, 0));
}

export function sidebarItemCount(tree: SidebarTree): number {
  if (!tree.virtual) return Number(sendMessage(tree.hwnd, TVM_GETCOUNT, 0, 0));
  return Number(sendMessage(tree.hwnd, TEST_STATE, TEST_ITEM_COUNT, 0));
}

export function sidebarSelectRow(tree: SidebarTree, row: number): void {
  if (tree.virtual) {
    sendMessage(tree.hwnd, TEST_STATE, 14, row);
    return;
  }
  let item = row < 0 ? 0n : treeGetRoot(tree.hwnd);
  for (let i = 0; i < row && item; i++) item = treeGetNextItem(tree.hwnd, TVGN_NEXTVISIBLE, item);
  sendMessage(tree.hwnd, TVM_SELECTITEM, TVGN_CARET, item);
}

export function sidebarRowText(tree: SidebarTree, row: number): string {
  if (!tree.virtual) throw new Error("row text requires a virtual tree");
  const bytes: number[] = [];
  for (let offset = 0; offset < 4096; offset++) {
    const value = Number(sendMessage(tree.hwnd, 0x8000 + 103, row, offset));
    if (value === 0) return new TextDecoder().decode(new Uint8Array(bytes));
    bytes.push(value - 1);
  }
  throw new Error("tree row text exceeds test limit");
}

export function sidebarSelectionInView(tree: SidebarTree, item: bigint): boolean {
  if (!tree.virtual) return treeIsItemInView(tree.hwnd, item);
  if (item === 0n) return false;
  const height = sidebarItemHeight(tree);
  const top = (Number(item) - 1) * height;
  const scroll = Number(sendMessage(tree.hwnd, TEST_STATE, 2, 0));
  const rect = getClientRect(tree.hwnd);
  return height > 0 && top >= scroll && top + height <= scroll + rect.bottom - rect.top;
}
