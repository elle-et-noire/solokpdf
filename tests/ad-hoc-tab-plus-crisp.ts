// The tab bar's "+" is two axis-aligned strokes: they must sit on the pixel grid, with no
// half-covered gray rows beside them. A 2px anti-aliased line centered on integer coordinates
// covers 3 rows at 50/100/50%, which reads as a blurred cross.
import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowPixels } from "./winapi.ts";

const PLUS_KIND = "tabsPlus";
// a channel this close to the background or the stroke color counts as that color
const kTolerance = 24;

function gray(data: Uint8Array, i: number): number {
  return Math.round((data[i]! + data[i + 1]! + data[i + 2]!) / 3);
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("tab-plus-crisp.pdf");
  writeFileSync(pdf, makeTextPdf("tab plus"));
  const s = await launchControlled([pdf]);
  try {
    await s.client.request(ControlCommand.SetNotificationsEnabled, [0]);
    const plus = (await s.client.virtTree()).find((c) => c.kind === PLUS_KIND);
    if (!plus) throw new Error("no + button");
    const cap = captureWindowPixels(plus.hwnd, "client");
    if (!cap) throw new Error("capture failed");

    const { x, y, dx, dy } = plus.rect;
    const values: number[] = [];
    for (let row = y; row < y + dy; row++) {
      for (let col = x; col < x + dx; col++) values.push(gray(cap.data, (row * cap.w + col) * 4));
    }
    const bg = values[0]!;
    const ink = values.reduce((a, v) => (Math.abs(v - bg) > Math.abs(a - bg) ? v : a), bg);
    if (Math.abs(ink - bg) < 64) throw new Error(`no visible stroke (bg ${bg}, ink ${ink})`);

    const inkCount = values.filter((v) => Math.abs(v - ink) <= kTolerance).length;
    const blurred = values.filter((v) => Math.abs(v - bg) > kTolerance && Math.abs(v - ink) > kTolerance).length;
    console.log(`+ ${dx}x${dy}: bg ${bg}, ink ${ink}, ink pixels ${inkCount}, in-between ${blurred}`);
    if (blurred > 0) throw new Error(`+ has ${blurred} half-covered pixels beside its strokes`);
  } finally {
    await s.client.request(ControlCommand.Quit, []).catch(() => {});
    s.client.close();
    await killAndWait(s.proc);
  }
}

if (import.meta.main) await runStandalone(testit);
