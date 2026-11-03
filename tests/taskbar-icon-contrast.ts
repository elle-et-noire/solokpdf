// The taskbar icon (the window's big icon) stands out from the taskbar. It
// took the theme's text color, which can match the taskbar: a light theme's
// dark ink on a dark taskbar. The test picks the theme whose text color is
// closest to this machine's taskbar, so it fails without the fix.
//
// Run: bun tests/taskbar-icon-contrast.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import {
  captureScreenRegionPixels,
  enumWindows,
  getClassName,
  getWindowIconPixels,
  getWindowRect,
  ICON_BIG,
  setProcessDpiAware,
  sleep,
} from "./winapi.ts";

// non-text UI against its background (WCAG 1.4.11)
const MIN_CONTRAST = 3.0;
// candidate themes and their TextColor (the old ink)
const THEMES: [string, number[]][] = [
  ["Light", [0x00, 0x00, 0x00]],
  ["Solarized Light", [0x21, 0x23, 0x23]],
  ["Dark", [0xf9, 0xfa, 0xfb]],
  ["Solarized Dark", [0x83, 0x94, 0x96]],
];

const hex = (c: number[]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

// the taskbar's most common color along a row near its top edge; null without one
function taskbarColor(): number[] | null {
  let tray = 0;
  enumWindows((h: number) => {
    if (getClassName(h) === "Shell_TrayWnd") {
      tray = h;
      return false;
    }
    return true;
  });
  if (!tray) {
    return null;
  }
  const r = getWindowRect(tray);
  const w = r.right - r.left;
  const px = captureScreenRegionPixels(r.left, r.top + 2, w, 1);
  if (!px) {
    return null;
  }
  const counts = new Map<string, number>();
  for (let i = 0; i < w; i++) {
    const k = `${px[i * 4 + 2]},${px[i * 4 + 1]},${px[i * 4]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])[0]![0]
    .split(",")
    .map(Number);
}

// the icon's most common nearly opaque color: its ink
function iconInk(frame: number): number[] {
  const icon = getWindowIconPixels(frame, ICON_BIG);
  if (!icon) {
    throw new Error("taskbar-icon-contrast: the frame has no 32 bpp big icon");
  }
  const counts = new Map<string, number>();
  for (let i = 0; i < icon.dx * icon.dy; i++) {
    if (icon.bgra[i * 4 + 3]! < 240) {
      continue;
    }
    const k = `${icon.bgra[i * 4 + 2]},${icon.bgra[i * 4 + 1]},${icon.bgra[i * 4]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size === 0) {
    throw new Error("taskbar-icon-contrast: the big icon has no opaque pixels");
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])[0]![0]
    .split(",")
    .map(Number);
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP taskbar-icon-contrast: ng has its own icons");
    return;
  }
  setProcessDpiAware();
  const taskbar = taskbarColor();
  if (!taskbar) {
    console.log("SKIP taskbar-icon-contrast: no taskbar on this desktop; run on a visible input desktop");
    return;
  }
  const [theme] = THEMES.reduce((a, b) => (contrastRatio(a[1], taskbar) <= contrastRatio(b[1], taskbar) ? a : b));

  const dir = tmpPath("taskbar-icon-contrast-appdata");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), `Theme = ${theme}\nRestoreSession = false\nCheckForUpdates = false\n`);
  const { proc, client, frame } = await launchControlled(["-appdata", dir]);
  try {
    for (let i = 0; i < 100 && !getWindowIconPixels(frame, ICON_BIG); i++) {
      await sleep(50);
    }
    const ink = iconInk(frame);
    const k = contrastRatio(ink, taskbar);
    if (k < MIN_CONTRAST) {
      throw new Error(
        `taskbar-icon-contrast: ${theme}: icon ${hex(ink)} on taskbar ${hex(taskbar)}, contrast ${k.toFixed(2)}`,
      );
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
