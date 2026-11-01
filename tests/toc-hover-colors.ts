// A hovered bookmark fills its whole row with the theme's hover color, and a
// hovered selected one keeps the selection color. The Explorer theme painted
// its own hot face instead: outside the palette, and on a selected row a gray
// block left of the title.
//
// Run: bun tests/toc-hover-colors.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import { killAndWait, launchControlled } from "./win-automation";
import {
  findChildWindow,
  getClientRect,
  readWindowDCRow,
  sleep,
  treeGetItemHeight,
  treeGetNextItem,
  treeGetRoot,
  treeGetSelection,
  treeSetHot,
  TVGN_NEXT,
} from "./winapi";

// Chapter two is on page 2, the others on page 1: opened on page 2, only it is selected
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

// a COLORREF (0x00bbggrr) as #rrggbb
const hex = (c: number) =>
  "#" + [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map((v) => v.toString(16).padStart(2, "0")).join("");

// a row's fill at its left edge (left of the title) and at its right end
// (past the title; page numbers are off)
function rowEnds(tree: number, row: number): [number, number] {
  const dy = treeGetItemHeight(tree);
  const dx = getClientRect(tree).right;
  const y = row * dy + Math.floor(dy / 2);
  const left = readWindowDCRow(tree, 2, y, 1)[0]!;
  const right = readWindowDCRow(tree, dx - 3, y, 1)[0]!;
  return [left, right];
}

// polls until the row is filled in one color other than `not`; returns it
async function uniformFill(tree: number, row: number, not: number, what: string): Promise<number> {
  let ends: [number, number] = [0, 0];
  for (let i = 0; i < 50; i++) {
    ends = rowEnds(tree, row);
    if (ends[0] === ends[1] && ends[0] !== not) {
      return ends[0];
    }
    await sleep(40);
  }
  throw new Error(`toc-hover-colors: ${what}: left ${hex(ends[0])}, right ${hex(ends[1])}, background ${hex(not)}`);
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP toc-hover-colors: ng draws its own tree");
    return;
  }
  const pdf = tmpPath("toc-hover-colors.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const appdata = tmpPath("toc-hover-colors-appdata");
  rmSync(appdata, { recursive: true, force: true });
  mkdirSync(appdata, { recursive: true });
  writeFileSync(
    join(appdata, SETTINGS_FILE),
    "Theme = Solarized Dark\nShowToc = true\nShowTocPageNumbers = false\nShowFavorites = false\n" +
      "RestoreSession = false\nCheckForUpdates = false\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", appdata, "-page", "2", pdf]);
  try {
    await client.waitForRenderIdle();
    let tree = 0;
    for (let i = 0; i < 100 && (!tree || treeGetSelection(tree) === 0n); i++) {
      tree = findChildWindow(frame, "SysTreeView32");
      await sleep(40);
    }
    const one = treeGetRoot(tree);
    const two = treeGetNextItem(tree, TVGN_NEXT, one);
    if (treeGetSelection(tree) !== two) {
      throw new Error("toc-hover-colors: Chapter two isn't the selected bookmark");
    }

    treeSetHot(tree, 0n);
    const bg = rowEnds(tree, 2)[0];
    const selected = await uniformFill(tree, 1, bg, "selected row");

    treeSetHot(tree, one);
    const hover = await uniformFill(tree, 0, bg, "hovered row");
    if (hover === selected) {
      throw new Error(`toc-hover-colors: hover ${hex(hover)} is the selection color`);
    }

    treeSetHot(tree, two);
    const selectedHot = await uniformFill(tree, 1, bg, "hovered selected row");
    if (selectedHot !== selected) {
      throw new Error(`toc-hover-colors: hovered selected row ${hex(selectedHot)}, want ${hex(selected)}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
