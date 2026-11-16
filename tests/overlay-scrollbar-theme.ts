// Scrollbars = overlay: switching the theme repaints the bars in the new
// theme's colors. They are layered windows, which the frame's redraw doesn't
// reach, so they kept the previous theme's colors until a scroll. As children
// of the canvas (E97), a PrintWindow of the canvas shows them.
//
// Light Gray -> next theme (Dark from 3.5): the bar must go dark.
//
// Run: bun tests/overlay-scrollbar-theme.ts [--no-build]

import { join } from "node:path";
import { cmdId, EXE, ROOT, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import { captureWindowPixels, getWindowRect, setProcessDpiAware, sleep } from "./winapi.ts";
import { withControlledSumatra } from "./control.ts";
import { canvasOverlayScrollbars, findCanvas, sendCommandSync, waitForFrame } from "./win-automation.ts";

// a light bar averages well above this, a dark one well below
const lumaSplit = 128;

// average brightness of the vertical bar as drawn over the canvas
function verticalBarLuma(frame: number, pid: number): number {
  const canvas = findCanvas(frame);
  const bars = canvasOverlayScrollbars(pid, canvas);
  const rects = bars.map((b) => getWindowRect(b));
  const i = rects.findIndex((r) => r.bottom - r.top > r.right - r.left);
  if (i < 0) {
    throw new Error("overlay-scrollbar-theme: no vertical overlay scrollbar");
  }
  const r = rects[i]!;
  const c = getWindowRect(canvas);
  const px = captureWindowPixels(canvas, "client");
  if (!px) {
    throw new Error("overlay-scrollbar-theme: capture failed");
  }
  let sum = 0;
  let n = 0;
  for (let y = r.top - c.top; y < r.bottom - c.top; y++) {
    for (let x = r.left - c.left; x < r.right - c.left; x++) {
      if (x < 0 || y < 0 || x >= px.w || y >= px.h) continue;
      const k = (y * px.w + x) * 4;
      sum += (px.data[k + 2]! * 299 + px.data[k + 1]! * 587 + px.data[k]! * 114) / 1000;
      n++;
    }
  }
  return sum / Math.max(n, 1);
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
