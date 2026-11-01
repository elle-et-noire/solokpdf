// Scrollbars = overlay: switching the theme repaints the bars in the new
// theme's colors. They are separate layered popups, which the frame's redraw
// doesn't reach, so they kept the previous theme's colors until a scroll.
//
// Light Gray -> next theme (Dark from 3.5): the bar must go dark.
//
// Run: bun tests/overlay-scrollbar-theme.ts [--no-build]

import { join } from "node:path";
import { cmdId, EXE, ROOT, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import {
  captureScreenRegionPixels,
  enumWindows,
  getClassName,
  getWindowPid,
  getWindowRect,
  setProcessDpiAware,
  setTopmost,
  sleep,
} from "./winapi.ts";
import { withControlledSumatra } from "./control.ts";
import { sendCommandSync, waitForFrame } from "./win-automation.ts";

const SCROLLBAR_CLASS = "SUMATRA_OVERLAY_SCROLLBAR";
// a light bar averages well above this, a dark one well below
const lumaSplit = 128;

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

// average brightness of the vertical bar as shown on screen
function verticalBarLuma(frame: number, pid: number): number {
  const bars = overlayScrollbars(pid);
  const rects = bars.map((b) => getWindowRect(b));
  const i = rects.findIndex((r) => r.bottom - r.top > r.right - r.left);
  if (i < 0) {
    throw new Error("overlay-scrollbar-theme: no vertical overlay scrollbar");
  }
  const r = rects[i]!;
  for (const hwnd of [frame, ...bars]) {
    setTopmost(hwnd, true);
  }
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  const px = captureScreenRegionPixels(r.left, r.top, w, h);
  setTopmost(frame, false);
  if (!px) {
    throw new Error("overlay-scrollbar-theme: capture failed");
  }
  let sum = 0;
  for (let k = 0; k < w * h; k++) {
    sum += (px[k * 4 + 2]! * 299 + px[k * 4 + 1]! * 587 + px[k * 4]! * 114) / 1000;
  }
  return sum / (w * h);
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    // ng draws its bars in the frame; this is about the Windows popups
    return;
  }
  setProcessDpiAware();
  const appdata = writeAppdata(
    "overlay-scrollbar-theme",
    [
      "UiLanguage = en",
      "RestoreSession = false",
      "ShowStartPage = false",
      "Scrollbars = overlay",
      "Theme = Light Gray",
    ].join("\n"),
  );

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      await client.waitForRenderIdle(30000);
      await client.setNotificationsEnabled(false);

      const before = verticalBarLuma(frame, proc.pid!);
      if (before < lumaSplit) {
        throw new Error(`overlay-scrollbar-theme: Light Gray bar is dark (luma ${before.toFixed(0)})`);
      }
      sendCommandSync(frame, cmdId("CmdNextTheme"));
      await client.waitForRenderIdle(30000);
      await sleep(300);
      const after = verticalBarLuma(frame, proc.pid!);
      if (after >= lumaSplit) {
        throw new Error(
          `overlay-scrollbar-theme: bar kept the light theme's colors after switching to a dark one (luma ${before.toFixed(0)} -> ${after.toFixed(0)})`,
        );
      }
    },
    ["-appdata", appdata, "-view", "continuous", "-zoom", "200", join(ROOT, "tests", "issue-5871.pdf")],
  );
}

if (import.meta.main) {
  await runStandalone(testit);
}
