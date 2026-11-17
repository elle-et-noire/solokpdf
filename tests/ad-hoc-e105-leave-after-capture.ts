// E105: the app input layer re-arms leave tracking when a window's mouse
// capture ends; the window has no code for it. The Automatically Scroll bar's
// Pause button captures the mouse on a click. After the click, the mouse
// leaving the bar must clear the button's hover.
//
// Run: bun tests/ad-hoc-e105-leave-after-capture.ts [--no-build]

import { writeFileSync } from "node:fs";
import { ControlCommand, type ControlClient } from "./control.ts";
import { makePdf, pollUntil, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import {
  clientToScreen,
  getClientRect,
  MK_LBUTTON,
  packCoords,
  sendMessage,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import { findCanvas, killAndWait, launchControlled, moveTestCursor } from "./win-automation.ts";

type Bar = { hwnd: number; paused: boolean; pause: { x: number; y: number }; hover: string };

async function bar(client: ControlClient): Promise<Bar | null> {
  const out = String((await client.request(ControlCommand.TestReadingAutoScroll, []))[1] ?? "");
  const st = /^OK visible=1 paused=(\d) .* hwnd=(\d+)$/m.exec(out);
  const r = /^pause=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(out);
  const hover = /^hover=(\w+)$/m.exec(out);
  if (!st || !r || !hover) return null;
  const pause = { x: +r[1]! + Math.floor(+r[3]! / 2), y: +r[2]! + Math.floor(+r[4]! / 2) };
  return { hwnd: +st[2]!, paused: st[1] === "1", pause, hover: hover[1]! };
}

async function waitBar(client: ControlClient, ok: (b: Bar) => boolean, what: string): Promise<Bar> {
  const b = await pollUntil(
    () => bar(client),
    (b) => !!b && ok(b),
    { timeoutMs: 3000, error: (b) => `e105: ${what}: ${JSON.stringify(b)}` },
  );
  return b!;
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("e105-leave.pdf");
  writeFileSync(pdf, makePdf(5, 1, 0, 0), "latin1");
  const appdata = writeAppdata("e105-appdata", "CheckForUpdates = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdToggleAutomaticallyScroll"]);
    const b0 = await waitBar(client, () => true, "no Automatically Scroll bar");
    const { hwnd, pause } = b0;

    // hover Pause through the test cursor
    const onPause = clientToScreen(hwnd, pause.x, pause.y);
    await moveTestCursor(onPause.x, onPause.y, client);
    sendMessage(hwnd, WM_MOUSEMOVE, 0, packCoords(pause.x, pause.y));
    await waitBar(client, (b) => b.hover === "pause", "Pause not hovered");

    // a click takes and releases the capture
    sendMessage(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(pause.x, pause.y));
    sendMessage(hwnd, WM_LBUTTONUP, 0, packCoords(pause.x, pause.y));
    await waitBar(client, (b) => b.paused !== b0.paused, "the click did not toggle Pause");

    // leave the bar for the middle of the canvas
    const canvas = findCanvas(frame);
    const cr = getClientRect(canvas);
    const away = clientToScreen(canvas, Math.floor(cr.right / 2), Math.floor(cr.bottom / 2));
    await moveTestCursor(away.x, away.y, client);
    await waitBar(client, (b) => b.hover === "none", "leaving the bar after a click kept the hover");
    console.log("e105: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
