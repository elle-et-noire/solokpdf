import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import "../tools/solokpdf/tree-reader-fixture";
import { sidebarRowText } from "./sidebar-tree";
import { cmdId, runStandalone } from "./util";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation";
import { findChildWindow, isWindowVisible, sendMessage, VK_RIGHT, WM_KEYDOWN } from "./winapi";

export async function testit(): Promise<void> {
  const dir = resolve(".work/tree-reader-check");
  const { proc, client, frame } = await launchControlled(
    ["-appdata", `${dir}/appdata`, `${dir}/tree-reader-check.pdf`],
    {
      env: { SOLOKPDF_VIRTUAL_TOC: "1", SOLOKPDF_VIRTUAL_FAVORITES: "1" },
    },
  );
  try {
    await client.waitForRenderIdle();
    const toc = findChildWindow(frame, "SumatraVirtualBookmarksTree");
    assert.ok(toc, "virtual bookmarks tree unavailable");
    assert.equal(Number(sendMessage(toc, 0x8000 + 102, 0, 0)), 3, "bookmarks fixture differs");
    const bookmarks = { hwnd: toc, virtual: true };
    assert.deepEqual(
      [0, 1, 2].map((row) => sidebarRowText(bookmarks, row)),
      ["First", "Second", "Third"],
    );
    sendMessage(toc, 0x8000 + 102, 14, 1);
    sendMessage(toc, WM_KEYDOWN, VK_RIGHT, 0);
    assert.equal(sidebarRowText(bookmarks, 2), "Nested");
    const favorites = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    assert.ok(favorites, "virtual favorites tree unavailable");
    assert.ok(isWindowVisible(favorites), "favorites sidebar is hidden");
    assert.equal(Number(sendMessage(favorites, 0x8000 + 102, 0, 0)), 1, "favorites should start collapsed");
    sendMessage(favorites, 0x8000 + 102, 14, 0);
    sendMessage(favorites, WM_KEYDOWN, VK_RIGHT, 0);
    assert.equal(Number(sendMessage(favorites, 0x8000 + 102, 0, 0)), 3, "favorites fixture differs");
    const tree = { hwnd: favorites, virtual: true };
    assert.ok(sidebarRowText(tree, 1).includes("First favorite"));
    assert.ok(sidebarRowText(tree, 2).includes("Third favorite"));
    sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    assert.equal(isWindowVisible(favorites), false, "favorites sidebar did not close");
    sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    assert.equal(isWindowVisible(favorites), true, "favorites sidebar did not reopen");
    assert.equal(Number(sendMessage(favorites, 0x8000 + 102, 0, 0)), 3, "favorites expansion was not preserved");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
