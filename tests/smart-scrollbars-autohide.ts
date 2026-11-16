// Scrollbars = smart: both overlay bars show when a document opens and hide a
// few seconds later. When the second one hid, the first one, already hidden,
// was painted again (the themed bars repaint each other for their shared
// corner) and stayed on screen for good.
//
// The bars are layered children of the canvas, which a PrintWindow of the
// canvas includes (E97): it is compared with one taken with the bars' windows
// hidden for the moment.
//
// Run: bun tests/smart-scrollbars-autohide.ts [--no-build]

import { join } from "node:path";
import { EXE, ROOT, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import {
  captureWindowPixels,
  getWindowRect,
  isWindowVisible,
  type Rect,
  setProcessDpiAware,
  setWindowPos,
  sleep,
  SWP_NOACTIVATE,
  SWP_NOZORDER,
} from "./winapi.ts";
import { withControlledSumatra } from "./control.ts";
import { canvasOverlayScrollbars, findCanvas, waitForFrame } from "./win-automation.ts";

// OverlayScrollbar::showAfterScrollMs plus slack for a slow (ASan) build
const autoHideWaitMs = 4000;
// pixels a hidden bar may still differ by. A shown bar is thousands.
const strayPixels = 64;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;

// the canvas with its bars hidden for the moment: the page alone
function canvasWithoutBars(canvas: number, bars: number[]) {
  const flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE;
  const shown = bars.filter((b) => isWindowVisible(b));
  for (const b of shown) setWindowPos(b, 0, 0, 0, 0, flags | SWP_HIDEWINDOW);
  const px = captureWindowPixels(canvas, "client");
  for (const b of shown) setWindowPos(b, 0, 0, 0, 0, flags | SWP_SHOWWINDOW);
  return px;
}

// Pixels of the bar's rectangle that differ from the canvas painted without
// the bars: 0 when the bar draws nothing.
function barPixelsShown(canvas: number, bars: number[], bar: number): number {
  const r: Rect = getWindowRect(bar);
  const c = getWindowRect(canvas);
  const withBars = captureWindowPixels(canvas, "client");
  const page = canvasWithoutBars(canvas, bars);
  if (!withBars || !page) {
    throw new Error("smart-scrollbars-autohide: capture failed");
  }
  let differ = 0;
  for (let y = r.top - c.top; y < r.bottom - c.top; y++) {
    for (let x = r.left - c.left; x < r.right - c.left; x++) {
      if (x < 0 || y < 0 || x >= page.w || y >= page.h) {
        continue;
      }
      const i = (y * page.w + x) * 4;
      if (
        withBars.data[i] !== page.data[i] ||
        withBars.data[i + 1] !== page.data[i + 1] ||
        withBars.data[i + 2] !== page.data[i + 2]
      ) {
        differ++;
      }
    }
  }
  return differ;
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    // ng draws its bars in the frame; this is about the Windows popups
    return;
  }
  setProcessDpiAware();
  const appdata = writeAppdata(
    "smart-scrollbars-autohide",
    ["UiLanguage = en", "RestoreSession = false", "ShowStartPage = false", "Scrollbars = smart"].join("\n"),
  );

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      await client.waitForRenderIdle(30000);
      await client.setNotificationsEnabled(false);
      const canvas = findCanvas(frame);

      const bars = canvasOverlayScrollbars(proc.pid!, canvas);
      if (bars.length !== 2) {
        throw new Error(`smart-scrollbars-autohide: want 2 overlay scrollbars, got ${bars.length}`);
      }
      // the capture has to see a shown bar, or a pass below proves nothing. Only
      // one: in a window that didn't get the focus smart bars hide right away
      const shown = bars.map((b) => barPixelsShown(canvas, bars, b));
      if (shown.every((n) => n <= strayPixels)) {
        throw new Error(`smart-scrollbars-autohide: bars not visible after opening (${shown})`);
      }

      await sleep(autoHideWaitMs);
      const after = bars.map((b) => barPixelsShown(canvas, bars, b));
      if (after.some((n) => n > strayPixels)) {
        throw new Error(`smart-scrollbars-autohide: a bar still shows after auto-hide (differing pixels: ${after})`);
      }

      // the horizontal bar stops short of the vertical one while both are
      // needed, hidden or not: stretching it as the vertical one hid made it
      // visibly grow just before it faded out too
      const rects = bars.map((b) => getWindowRect(b));
      const vert = rects[0].bottom - rects[0].top > rects[0].right - rects[0].left ? rects[0] : rects[1];
      const horz = vert === rects[0] ? rects[1] : rects[0];
      if (horz.right > vert.left) {
        throw new Error(
          `smart-scrollbars-autohide: the horizontal bar runs under the vertical one after auto-hide (right ${horz.right}, vertical bar at ${vert.left})`,
        );
      }
    },
    ["-appdata", appdata, "-view", "continuous", "-zoom", "200", join(ROOT, "tests", "issue-5871.pdf")],
  );
}

if (import.meta.main) {
  await runStandalone(testit);
}
