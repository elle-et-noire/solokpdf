// The sidebar keeps the canvas color after a theme switch (T). darkmodelib
// recolored the tree with its own colors after we had set ours.
//
// Run: bun tests/sidebar-theme-colors.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import { findSidebarTree } from "./sidebar-tree";
import { killAndWait, launchControlled } from "./win-automation";
import {
  enumChildWindows,
  findChildWindow,
  getClassName,
  getClientRect,
  isWindowVisible,
  readWindowDCRow,
  sendMessage,
  sleep,
  WM_COMMAND,
} from "./winapi";

const kThemeSwitches = 3;

function makePdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
    "<< /Title (Chapter one) /Parent 4 0 R /Dest [3 0 R /Fit] >>",
  ]);
}

// a COLORREF (0x00bbggrr) as #rrggbb
const hex = (c: number) =>
  "#" + [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map((v) => v.toString(16).padStart(2, "0")).join("");

// the empty tree below its rows and the canvas below the page
function sample(tree: number, canvas: number): [number, number] {
  const tr = getClientRect(tree);
  const cr = getClientRect(canvas);
  if (tr.right <= 10 || tr.bottom < 5 || cr.right <= 3 || cr.bottom < 5) {
    throw new Error("sidebar-theme-colors: sample outside client area");
  }
  const t = readWindowDCRow(tree, 10, tr.bottom - 5, 1)[0];
  const c = readWindowDCRow(canvas, 3, cr.bottom - 5, 1)[0];
  if (t === undefined || c === undefined || t === 0xffffffff || c === 0xffffffff) {
    throw new Error("sidebar-theme-colors: pixel read failed");
  }
  return [t, c];
}

// polls until both match; returns the last sample
async function waitSame(tree: number, canvas: number): Promise<[number, number]> {
  let s = sample(tree, canvas);
  for (let i = 0; i < 50 && s[0] !== s[1]; i++) {
    await sleep(40);
    s = sample(tree, canvas);
  }
  return s;
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP sidebar-theme-colors: ng draws its own tree");
    return;
  }
  const pdf = tmpPath("sidebar-theme-colors.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const appdata = tmpPath("sidebar-theme-colors-appdata");
  rmSync(appdata, { recursive: true, force: true });
  mkdirSync(appdata, { recursive: true });
  writeFileSync(
    join(appdata, SETTINGS_FILE),
    `Theme = Solarized Dark\nShowToc = true\nShowFavorites = true\nRestoreSession = false\nCheckForUpdates = false\nFileStates [\n [\n FilePath = ${pdf}\n Favorites [\n [\n PageNo = 1\n Name = Favorite\n ]\n ]\n ]\n]\n`,
  );

  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    let tree = 0;
    for (let i = 0; i < 100 && !tree; i++) {
      tree = findSidebarTree(frame)?.hwnd ?? 0;
      await sleep(40);
    }
    if (!tree) throw new Error("sidebar-theme-colors: tree unavailable");
    let favorites = 0;
    enumChildWindows(frame, (hwnd) => {
      const name = getClassName(hwnd);
      if (
        hwnd !== tree &&
        isWindowVisible(hwnd) &&
        (name === "SysTreeView32" || name === "SumatraVirtualFavoritesTree")
      ) {
        favorites = hwnd;
        return false;
      }
      return true;
    });
    if (!favorites) throw new Error("sidebar-theme-colors: favorites tree unavailable");
    const canvas = findChildWindow(frame, "SUMATRA_PDF_CANVAS");
    if (!canvas) throw new Error("sidebar-theme-colors: canvas unavailable");

    let previous = -1;
    for (let i = 0; i <= kThemeSwitches; i++) {
      if (i > 0) {
        sendMessage(frame, WM_COMMAND, cmdId("CmdNextTheme"), 0);
        const deadline = Date.now() + 3000;
        while (sample(tree, canvas)[1] === previous && Date.now() < deadline) await sleep(40);
        if (sample(tree, canvas)[1] === previous) throw new Error("sidebar-theme-colors: theme did not change");
      }
      const [t, c] = await waitSame(tree, canvas);
      if (t !== c) {
        throw new Error(`sidebar-theme-colors: after ${i} switches sidebar ${hex(t)}, canvas ${hex(c)}`);
      }
      const [f, background] = await waitSame(favorites, canvas);
      if (f !== background) {
        throw new Error(`sidebar-theme-colors: after ${i} switches favorites ${hex(f)}, canvas ${hex(background)}`);
      }
      previous = background;
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
