// The sidebar keeps the canvas color after a theme switch (T). darkmodelib
// recolored the tree with its own colors after we had set ours.
//
// Run: bun tests/sidebar-theme-colors.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import { killAndWait, launchControlled } from "./win-automation";
import { findChildWindow, getClientRect, readWindowDCRow, sendMessage, sleep, WM_COMMAND } from "./winapi";

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
  const t = readWindowDCRow(tree, 10, getClientRect(tree).bottom - 5, 1)[0]!;
  const c = readWindowDCRow(canvas, 3, getClientRect(canvas).bottom - 5, 1)[0]!;
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
    "Theme = Solarized Dark\nShowToc = true\nShowFavorites = false\nRestoreSession = false\nCheckForUpdates = false\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    let tree = 0;
    for (let i = 0; i < 100 && !tree; i++) {
      tree = findChildWindow(frame, "SysTreeView32");
      await sleep(40);
    }
    const canvas = findChildWindow(frame, "SUMATRA_PDF_CANVAS");

    for (let i = 0; i <= kThemeSwitches; i++) {
      if (i > 0) {
        sendMessage(frame, WM_COMMAND, cmdId("CmdNextTheme"), 0);
      }
      const [t, c] = await waitSame(tree, canvas);
      if (t !== c) {
        throw new Error(`sidebar-theme-colors: after ${i} switches sidebar ${hex(t)}, canvas ${hex(c)}`);
      }
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
