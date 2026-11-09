// A hovered bookmark fills its whole row with the theme's hover color, and a
// hovered selected one keeps the selection color. The Explorer theme painted
// its own hot face instead: outside the palette, and on a selected row a gray
// block left of the title.
//
// Run: bun tests/toc-hover-colors.ts [--no-build]

import {
  findSidebarTree,
  sidebarItemHeight,
  sidebarSelection,
  sidebarRows,
  sidebarSelectRow,
  type SidebarTree,
} from "./sidebar-tree";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import { ControlCommand, type ControlClient } from "./control";
import { killAndWait, launchControlled, sendCommandSync, moveTestCursor } from "./win-automation";
import {
  findChildWindow,
  clientToScreen,
  packCoords,
  WM_MOUSEMOVE,
  WM_MOUSELEAVE,
  getClientRect,
  readWindowDCRow,
  sendMessage,
  sleep,
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
    "<< /Title (Chapter two) /Parent 5 0 R /Prev 6 0 R /Next 8 0 R /Dest [4 0 R /Fit] /C [1 0 0] >>",
    "<< /Title (Chapter three) /Parent 5 0 R /Prev 7 0 R /Dest [3 0 R /Fit] >>",
  ]);
}

// a COLORREF (0x00bbggrr) as #rrggbb
const hex = (c: number) =>
  "#" + [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map((v) => v.toString(16).padStart(2, "0")).join("");

// a row's fill at its left edge (left of the title) and at its right end
// (past the title; page numbers are off)
function rowEnds(tree: SidebarTree, row: number): [number, number] {
  const dy = sidebarItemHeight(tree);
  const dx = getClientRect(tree.hwnd).right;
  const y = row * dy + Math.floor(dy / 2);
  const left = readWindowDCRow(tree.hwnd, 2, y, 1)[0]!;
  const right = readWindowDCRow(tree.hwnd, dx - 3, y, 1)[0]!;
  return [left, right];
}

async function hoverRow(tree: SidebarTree, row: number, client: ControlClient): Promise<void> {
  const y = row < 0 ? -10 : row * sidebarItemHeight(tree) + Math.floor(sidebarItemHeight(tree) / 2);
  const point = clientToScreen(tree.hwnd, 10, y);
  await moveTestCursor(point.x, point.y, client);
  sendMessage(tree.hwnd, row < 0 ? WM_MOUSELEAVE : WM_MOUSEMOVE, 0, packCoords(10, y));
}

// polls until the row is filled in one color other than `not`; returns it
async function uniformFill(tree: SidebarTree, row: number, not: number, what: string): Promise<number> {
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

async function selectedIcon(hwnd: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rc = getClientRect(hwnd);
    let green = 0;
    let blue = 0;
    for (let y = 0; y < rc.bottom; y++) {
      for (const pixel of readWindowDCRow(hwnd, 0, y, rc.right)) {
        if ((pixel & 0xffffff) === 0x00996633) blue++;
        if ((pixel & 255) < 80 && ((pixel >> 8) & 255) > 160 && ((pixel >> 16) & 255) < 80) green++;
      }
    }
    if (green && blue) return;
    await sleep(40);
  }
  throw new Error("toc-hover-colors: toolbar lacks selection background or icon color");
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
    "Theme = Selection Test\nShowToc = true\nShowTocPageNumbers = false\nShowFavorites = false\n" +
      "RestoreSession = false\nCheckForUpdates = false\nThemes [\n [\n Name = Selection Test\n" +
      " TextColor = #ffffff\n BackgroundColor = #193247\n ControlBackgroundColor = #193247\n" +
      " LinkColor = #ffffff\n SelectionBackgroundColor = #336699\n SelectionTextColor = #00ff00\n ]\n]\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", appdata, "-page", "2", pdf]);
  try {
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdZoomFitPageAndSinglePage"));
    const toolbar = findChildWindow(frame, "SUMATRA_VIRT_TOOLBAR");
    if (!toolbar) throw new Error("toc-hover-colors: toolbar missing");
    await selectedIcon(toolbar);
    let tree: SidebarTree | null = null;
    for (let i = 0; i < 100 && (!tree || sidebarSelection(tree) === 0n); i++) {
      tree = findSidebarTree(frame);
      await sleep(40);
    }
    if (!tree || sidebarSelection(tree) !== 2n) {
      throw new Error("toc-hover-colors: Chapter two isn't the selected bookmark");
    }

    await hoverRow(tree, -1, client);
    const bg = rowEnds(tree, 2)[0];
    const selected = await uniformFill(tree, 1, bg, "selected row");
    if (hex(selected) !== "#336699") {
      throw new Error(`toc-hover-colors: selected row ${hex(selected)}, want #336699`);
    }
    const rowHeight = sidebarItemHeight(tree);
    const width = getClientRect(tree.hwnd).right;
    let green = 0;
    for (let y = rowHeight; y < 2 * rowHeight; y++) {
      for (const pixel of readWindowDCRow(tree.hwnd, 0, y, width)) {
        if ((pixel & 255) < 80 && ((pixel >> 8) & 255) > 160 && ((pixel >> 16) & 255) < 80) green++;
      }
    }
    if (!green) throw new Error("toc-hover-colors: selected text is not green");

    await hoverRow(tree, 0, client);
    const hover = await uniformFill(tree, 0, bg, "hovered row");
    if (hover === selected) {
      throw new Error(`toc-hover-colors: hover ${hex(hover)} is the selection color`);
    }

    await hoverRow(tree, 1, client);
    const selectedHot = await uniformFill(tree, 1, bg, "hovered selected row");
    if (selectedHot !== selected) {
      throw new Error(`toc-hover-colors: hovered selected row ${hex(selectedHot)}, want ${hex(selected)}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }

  const fav = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await fav.client.waitForRenderIdle();
    const result = await fav.client.request(ControlCommand.TestFavoriteNav, ["add", 1]);
    if (result[0] !== 0) throw new Error("toc-hover-colors: could not add favorite");
    sendCommandSync(fav.frame, cmdId("CmdFavoriteShowInTab"));
    let tree: SidebarTree | null = null;
    for (let i = 0; i < 100 && (!tree || sidebarRows(tree) === 0); i++) {
      tree = findSidebarTree(fav.frame, true, "favorites");
      await sleep(40);
    }
    if (!tree || sidebarRows(tree) === 0) throw new Error("toc-hover-colors: favorites tree is empty");
    sidebarSelectRow(tree, 0);
    const selected = await uniformFill(tree, 0, 0, "selected favorite");
    if (hex(selected) !== "#336699") {
      throw new Error(`toc-hover-colors: selected favorite ${hex(selected)}, want #336699`);
    }
    let green = 0;
    for (let y = 0; y < sidebarItemHeight(tree); y++) {
      for (const pixel of readWindowDCRow(tree.hwnd, 0, y, getClientRect(tree.hwnd).right)) {
        if ((pixel & 255) < 80 && ((pixel >> 8) & 255) > 160 && ((pixel >> 16) & 255) < 80) green++;
      }
    }
    if (!green) throw new Error("toc-hover-colors: selected favorite text is not green");
  } finally {
    fav.client.close();
    await killAndWait(fav.proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
