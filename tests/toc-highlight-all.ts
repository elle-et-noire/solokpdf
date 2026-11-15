// TocHighlightAllMatches: on page 1, Chapter three shares the page with the
// selected Chapter one. It takes the selection color only when the setting is on.
//
// Run: bun tests/toc-highlight-all.ts [--no-build]

import { findSidebarTree, sidebarItemHeight, sidebarSelection, type SidebarTree } from "./sidebar-tree";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import { killAndWait, launchControlled } from "./win-automation";
import { getClientRect, readWindowDCRow, sleep } from "./winapi";

const kSelectionBg = 0x996633; // #336699 as COLORREF
const kChapterThreeRow = 2;

// Chapter one and three on page 1, Chapter two on page 2
function makePdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    "<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 3 >>",
    "<< /Title (Chapter one) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>",
    "<< /Title (Chapter two) /Parent 5 0 R /Prev 6 0 R /Next 8 0 R /Dest [4 0 R /Fit] >>",
    "<< /Title (Chapter three) /Parent 5 0 R /Prev 7 0 R /Dest [3 0 R /Fit] >>",
  ]);
}

// fill right of the title, where only the row background is drawn
function rowFill(tree: SidebarTree, row: number): number {
  const dy = sidebarItemHeight(tree);
  const x = getClientRect(tree.hwnd).right - 3;
  return readWindowDCRow(tree.hwnd, x, row * dy + Math.floor(dy / 2), 1)[0]! & 0xffffff;
}

async function chapterThreeHighlighted(pdf: string, highlightAll: boolean): Promise<boolean> {
  const appdata = tmpPath(`toc-highlight-all-${highlightAll}`);
  rmSync(appdata, { recursive: true, force: true });
  mkdirSync(appdata, { recursive: true });
  writeFileSync(
    join(appdata, SETTINGS_FILE),
    `TocHighlightAllMatches = ${highlightAll}\n` +
      "Theme = Selection Test\nShowToc = true\nShowFavorites = false\n" +
      "RestoreSession = false\nCheckForUpdates = false\nThemes [\n [\n Name = Selection Test\n" +
      " TextColor = #ffffff\n BackgroundColor = #193247\n ControlBackgroundColor = #193247\n" +
      " LinkColor = #ffffff\n SelectionBackgroundColor = #336699\n SelectionTextColor = #00ff00\n ]\n]\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    let tree: SidebarTree | null = null;
    for (let i = 0; i < 100 && (!tree || sidebarSelection(tree) === 0n); i++) {
      tree = findSidebarTree(frame);
      await sleep(40);
    }
    if (!tree || sidebarSelection(tree) !== 1n) {
      throw new Error("toc-highlight-all: Chapter one isn't the selected bookmark");
    }

    // the selected row is painted; give the extra highlight the same chance
    for (let i = 0; i < 50 && rowFill(tree, 0) !== kSelectionBg; i++) await sleep(40);
    if (rowFill(tree, 0) !== kSelectionBg) throw new Error("toc-highlight-all: selected row isn't painted");
    return rowFill(tree, kChapterThreeRow) === kSelectionBg;
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP toc-highlight-all: ng draws its own tree");
    return;
  }
  const pdf = tmpPath("toc-highlight-all.pdf");
  writeFileSync(pdf, makePdf(), "latin1");

  if (!(await chapterThreeHighlighted(pdf, true))) {
    throw new Error("toc-highlight-all: same-page bookmark not highlighted with TocHighlightAllMatches = true");
  }
  if (await chapterThreeHighlighted(pdf, false)) {
    throw new Error("toc-highlight-all: same-page bookmark highlighted with TocHighlightAllMatches = false");
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
