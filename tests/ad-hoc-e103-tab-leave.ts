// E103: a mouse capture cancels the tab strip's leave tracking. After a tab
// click (capture taken and released) the mouse leaving the strip must still
// clear hover, and after a middle-click close it must unfreeze the widths.
//
// Run: bun tests/ad-hoc-e103-tab-leave.ts [--no-build]

import { writeFileSync } from "node:fs";
import { ControlCommand, type ControlClient } from "./control.ts";
import { makePdf, pollUntil, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import {
  clientToScreen,
  getClientRect,
  MK_LBUTTON,
  MK_MBUTTON,
  packCoords,
  sendMessage,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MBUTTONDOWN,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import { findChildByClass, killAndWait, launchControlled, moveTestCursor } from "./win-automation.ts";

type Strip = { dxs: number[]; hover: number; frozen: boolean };

async function strip(client: ControlClient): Promise<Strip> {
  const out = String((await client.request(ControlCommand.TestTabWidths, []))[1] ?? "");
  const dxs = [...out.matchAll(/^dx=(\d+) /gm)].map((m) => +m[1]!);
  const st = /^state hover=(-?\d+) frozen=(\d)$/m.exec(out);
  if (!st) throw new Error(`e103: no tab state in:\n${out}`);
  return { dxs, hover: +st[1]!, frozen: st[2] === "1" };
}

// moves the test cursor onto client point (x,y) of hwnd and sends the move
async function hover(hwnd: number, x: number, y: number): Promise<void> {
  const s = clientToScreen(hwnd, x, y);
  await moveTestCursor(s.x, s.y);
  sendMessage(hwnd, WM_MOUSEMOVE, 0, packCoords(x, y));
}

async function waitLeft(client: ControlClient, what: string): Promise<void> {
  await pollUntil(
    () => strip(client),
    (s) => s.hover === -1 && !s.frozen,
    { timeoutMs: 3000, error: (s) => `e103: ${what}: leaving the strip left ${JSON.stringify(s)}` },
  );
}

export async function testit(): Promise<void> {
  const files = ["a", "b", "c"].map((n) => {
    const p = tmpPath(`e103-${n}.pdf`);
    writeFileSync(p, makePdf(1, 1, 0, 0), "latin1");
    return p;
  });
  const appdata = writeAppdata("e103-appdata", "CheckForUpdates = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, ...files]);
  try {
    await client.waitForRenderIdle();
    const tabs = findChildByClass(frame, "SumatraTabsCtrlClass");
    if (!tabs) throw new Error("e103: no tab bar");
    const cr = getClientRect(tabs);
    const y = Math.floor(cr.bottom / 2);
    const s0 = await strip(client);
    if (s0.dxs.length < 3) throw new Error(`e103: expected 3 tabs: ${JSON.stringify(s0)}`);
    const tab0X = Math.floor(s0.dxs[0]! / 3);
    // a point on the canvas, below the strip
    const away = clientToScreen(tabs, tab0X, cr.bottom + 100);

    // a click takes and releases capture on the strip
    await hover(tabs, tab0X, y);
    sendMessage(tabs, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(tab0X, y));
    sendMessage(tabs, WM_LBUTTONUP, 0, packCoords(tab0X, y));
    const s1 = await strip(client);
    if (s1.hover !== 0) throw new Error(`e103: clicked tab not hovered: ${JSON.stringify(s1)}`);
    await moveTestCursor(away.x, away.y);
    await waitLeft(client, "after a tab click");

    // a click, then a middle-click close: widths freeze until the mouse leaves
    await hover(tabs, tab0X, y);
    sendMessage(tabs, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(tab0X, y));
    sendMessage(tabs, WM_LBUTTONUP, 0, packCoords(tab0X, y));
    sendMessage(tabs, WM_MBUTTONDOWN, MK_MBUTTON, packCoords(tab0X, y));
    const s2 = await strip(client);
    if (s2.dxs.length !== 2 || !s2.frozen) throw new Error(`e103: middle-click close: ${JSON.stringify(s2)}`);
    await moveTestCursor(away.x, away.y);
    await waitLeft(client, "after a middle-click close");
    console.log("e103: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
