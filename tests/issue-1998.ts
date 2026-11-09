// Test for issue #1998: "Expand to current page in toc tree".
//
// CmdExpandToCurrentPage expands the table-of-contents tree down to the entry
// matching the current page and selects it (like Explorer's "Expand to current
// folder"). Implemented in src/TableOfContents.cpp (ExpandTocToCurrentPage),
// wired to the TOC context menu and the global command dispatcher.
//
// The test opens a PDF with a nested TOC, navigates to the last page, collapses
// the whole tree, then invokes the command via WM_COMMAND and reads the tree
// state with cross-process TreeView messages. After the command, the path to the
// (deeply nested) last-page entry must be expanded -- so more tree rows are
// visible than when fully collapsed -- and an item must be selected. Reverting
// the fix leaves the tree collapsed with no expansion, so the test fails.
//
// Drives the app from Bun via FFI (tests/winapi.ts).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import { assemblePdf, cmdId, tmpPath, USE_NG, SETTINGS_FILE } from "./util";
import { launchControlled, sendCommandSync, killAndWait } from "./win-automation";
import { findSidebarTree, sidebarRows, sidebarRowText, sidebarSelection } from "./sidebar-tree";
import {
  collapseTreeRoots,
  countVisibleTreeRows,
  findChildWindow,
  sleep,
  sendMessage,
  treeGetNextItem,
  treeGetRoot,
  treeGetSelection,
  TVGN_CHILD,
  VK_LEFT,
  WM_KEYDOWN,
} from "./winapi";

function makePdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 3 >>",
    "<< /Title (Chapter) /Parent 5 0 R /First 7 0 R /Last 7 0 R /Count 2 /Dest [3 0 R /Fit] >>",
    "<< /Title (Section) /Parent 6 0 R /First 8 0 R /Last 8 0 R /Count 1 /Dest [3 0 R /Fit] >>",
    "<< /Title (Last page) /Parent 7 0 R /Dest [4 0 R /Fit] >>",
  ]);
}

// command ids, looked up by name from src/Commands.h (the numeric values shift
// whenever commands are added/removed, so never hardcode them)
const CmdGoToLastPage = cmdId("CmdGoToLastPage");
const CmdExpandToCurrentPage = cmdId("CmdExpandToCurrentPage");

const SETTINGS = [
  `ShowToc = true`,
  `ShowFavorites = false`,
  `DefaultDisplayMode = continuous`,
  `DefaultZoom = fit page`,
  `Scrollbars = windows`,
  `RestoreSession = false`,
  `ShowStartPage = false`,
  `CheckForUpdates = false`,
  ``,
].join("\n");

// ng draws the outline in the sidebar; there is no SysTreeView32 to message
async function ngToc(client: Awaited<ReturnType<typeof launchControlled>>["client"], op: string) {
  const raw = String((await client.request(ControlCommand.TestUiState, [op]))[1] ?? "");
  const m = /tocRows=(-?\d+) tocSel=(\d)/.exec(raw);
  if (!m) {
    throw new Error(`toc state: ${raw}`);
  }
  return { rows: +m[1]!, sel: m[2] === "1" };
}

function checkExpanded(collapsed: number, after: number, hasSelection: boolean) {
  console.log(`  collapsed rows=${collapsed}, after-expand rows=${after}, hasSelection=${hasSelection}`);
  if (collapsed !== 1) {
    throw new Error(`baseline collapsed tree has ${collapsed} rows, expected 1`);
  }
  if (!hasSelection) {
    throw new Error(`CmdExpandToCurrentPage did not select a TOC entry`);
  }
  if (after !== 3) {
    throw new Error(`CmdExpandToCurrentPage showed ${after} rows, expected 3`);
  }
  console.log(`  expanded TOC to current page: ${collapsed} -> ${after} visible rows ✓`);
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("issue-1998.pdf");
  writeFileSync(pdf, makePdf(), "latin1");

  const appdata = tmpPath("issue-1998-appdata");
  rmSync(appdata, { recursive: true, force: true });
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), SETTINGS);

  // kill stale dev-build instances so reuse-instance can't forward our launch
  // to an old window (which would leave our process window-less)
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();

    if (USE_NG) {
      const deadline = Date.now() + 8000;
      let loaded = await ngToc(client, "count");
      while (Date.now() < deadline && loaded.rows <= 0) {
        await sleep(40);
        loaded = await ngToc(client, "count");
      }
      if (loaded.rows <= 0) {
        throw new Error("could not find the TOC tree window");
      }
      sendCommandSync(frame, CmdGoToLastPage);
      await client.waitForRenderIdle();
      const collapsed = (await ngToc(client, "collapse-roots")).rows;
      sendCommandSync(frame, CmdExpandToCurrentPage);
      const afterDeadline = Date.now() + 3000;
      let after = collapsed;
      let hasSelection = false;
      while (Date.now() < afterDeadline) {
        const state = await ngToc(client, "count");
        after = state.rows;
        hasSelection = state.sel;
        if (after > collapsed && hasSelection) {
          break;
        }
        await sleep(30);
      }
      checkExpanded(collapsed, after, hasSelection);
      const sidebar = String((await client.request(ControlCommand.TestUiState, []))[1] ?? "");
      if (!sidebar.includes("tocSel='Last page'")) {
        throw new Error(`wrong selected bookmark: ${sidebar}`);
      }
      return;
    }

    const virtual = findSidebarTree(frame, true);
    if (virtual?.virtual) {
      sendCommandSync(frame, CmdGoToLastPage);
      await client.waitForRenderIdle();
      if (Number(sendMessage(virtual.hwnd, 0x8000 + 102, 14, 0)) !== 1) {
        throw new Error("could not select root bookmark");
      }
      sendMessage(virtual.hwnd, WM_KEYDOWN, VK_LEFT, 0);
      const collapsed = sidebarRows(virtual);
      sendCommandSync(frame, CmdExpandToCurrentPage);
      const afterDeadline = Date.now() + 3000;
      while (Date.now() < afterDeadline && (sidebarRows(virtual) !== 3 || sidebarSelection(virtual) !== 3n)) {
        await sleep(30);
      }
      checkExpanded(collapsed, sidebarRows(virtual), sidebarSelection(virtual) === 3n);
      if (sidebarRowText(virtual, 2) !== "Last page") throw new Error("wrong bookmark selected");
      return;
    }

    // wait for the TOC tree to load with items
    const deadline = Date.now() + 8000;
    let tree = 0;
    while (Date.now() < deadline) {
      tree = findChildWindow(frame, "SysTreeView32");
      if (tree && countVisibleTreeRows(tree) > 0) {
        break;
      }
      await sleep(40);
    }
    if (!tree) {
      throw new Error("could not find the TOC tree window");
    }

    // go to the last page (deep in the document, under nested TOC entries)
    sendCommandSync(frame, CmdGoToLastPage);
    await client.waitForRenderIdle();

    // collapse the whole tree, then measure
    collapseTreeRoots(tree);
    const collapsed = countVisibleTreeRows(tree);

    // invoke the command under test
    sendCommandSync(frame, CmdExpandToCurrentPage);
    const afterDeadline = Date.now() + 3000;
    let after = collapsed;
    while (Date.now() < afterDeadline) {
      after = countVisibleTreeRows(tree);
      if (after > collapsed && treeGetSelection(tree) !== 0n) {
        break;
      }
      await sleep(30);
    }
    const section = treeGetNextItem(tree, TVGN_CHILD, treeGetRoot(tree));
    const lastPage = treeGetNextItem(tree, TVGN_CHILD, section);
    const hasSelection = lastPage !== 0n && treeGetSelection(tree) === lastPage;
    checkExpanded(collapsed, after, hasSelection);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  const { runStandalone } = await import("./util");
  await runStandalone(testit);
}
