// Scrollbars = smart: both overlay bars show when a document opens and hide a
// few seconds later. When the second one hid, the first one, already hidden,
// was painted again (the themed bars repaint each other for their shared
// corner) and stayed on screen for good.
//
// The bars are layered popups, so their pixels are read off the screen: the
// frame and the bars are raised topmost first, without taking the focus.
//
// Run: bun tests/smart-scrollbars-autohide.ts [--no-build]

import { join } from "node:path";
import { EXE, ROOT, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import {
  captureScreenRegionPixels,
  captureWindowPixels,
  enumWindows,
  getClassName,
  getWindowPid,
  getWindowRect,
  type Rect,
  setProcessDpiAware,
  setTopmost,
  sleep,
} from "./winapi.ts";
import { withControlledSumatra } from "./control.ts";
import { findCanvas, waitForFrame } from "./win-automation.ts";

const SCROLLBAR_CLASS = "SUMATRA_OVERLAY_SCROLLBAR";
// OverlayScrollbar::showAfterScrollMs plus slack for a slow (ASan) build
const autoHideWaitMs = 8000;
// pixels a hidden bar may still differ by: the frame's rounded corner clips
// the screen there but not the PrintWindow capture. A shown bar is thousands.
const strayPixels = 64;

function overlayScrollbars(pid: number): number[] {
  const res: number[] = [];
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) === pid && getClassName(hwnd) === SCROLLBAR_CLASS) {
      res.push(hwnd);
    }
    return true;
  });
  return res;
}

// Pixels of the bar's rectangle on screen that differ from the canvas painted
// alone (PrintWindow leaves the popups out): 0 when the bar draws nothing.
function barPixelsShown(frame: number, canvas: number, bar: number): number {
  const r: Rect = getWindowRect(bar);
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  const c = getWindowRect(canvas);
  const canvasPx = captureWindowPixels(canvas, "client");
  for (const hwnd of [frame, ...overlayScrollbars(getWindowPid(frame))]) {
    setTopmost(hwnd, true);
  }
  const screenPx = captureScreenRegionPixels(r.left, r.top, w, h);
  setTopmost(frame, false);
  if (!canvasPx || !screenPx) {
    throw new Error("smart-scrollbars-autohide: capture failed");
  }
  let differ = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = r.left - c.left + x;
      const cy = r.top - c.top + y;
      if (cx < 0 || cy < 0 || cx >= canvasPx.w || cy >= canvasPx.h) {
        continue;
      }
      const si = (y * w + x) * 4;
      const ci = (cy * canvasPx.w + cx) * 4;
      if (
        screenPx[si] !== canvasPx.data[ci] ||
        screenPx[si + 1] !== canvasPx.data[ci + 1] ||
        screenPx[si + 2] !== canvasPx.data[ci + 2]
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

      const bars = overlayScrollbars(proc.pid!);
      if (bars.length !== 2) {
        throw new Error(`smart-scrollbars-autohide: want 2 overlay scrollbars, got ${bars.length}`);
      }
      // the capture has to see a shown bar, or a pass below proves nothing
      const shown = bars.map((b) => barPixelsShown(frame, canvas, b));
      if (shown.some((n) => n <= strayPixels)) {
        throw new Error(`smart-scrollbars-autohide: bars not visible after opening (${shown})`);
      }

      await sleep(autoHideWaitMs);
      const after = bars.map((b) => barPixelsShown(frame, canvas, b));
      if (after.some((n) => n > strayPixels)) {
        throw new Error(`smart-scrollbars-autohide: a bar still shows after auto-hide (differing pixels: ${after})`);
      }
    },
    ["-appdata", appdata, "-view", "continuous", "-zoom", "200", join(ROOT, "tests", "issue-5871.pdf")],
  );
}

if (import.meta.main) {
  await runStandalone(testit);
}
