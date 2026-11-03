import { writeFileSync } from "node:fs";
import { ControlCommand, type ControlClient } from "./control.ts";
import { makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import {
  clientToScreen,
  getCursorPos,
  packCoords,
  sendMessage,
  setCursorPos,
  trackMouseLeave,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
  MK_LBUTTON,
} from "./winapi.ts";
import { clickAt, findCanvas, killAndWait, launchControlled, moveTestCursor } from "./win-automation.ts";

function same(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

async function scroll(client: ControlClient): Promise<string> {
  const res = await client.request(ControlCommand.TestScrollState);
  if (res[0] !== 0) throw new Error(`scroll state: ${res}`);
  return String(res[1]);
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("ad-hoc-b59-cursor.pdf");
  writeFileSync(pdf, makeTextPdf("test cursor"));
  const { proc, client, frame } = await launchControlled(["-zoom", "200", pdf]);
  try {
    await client.waitForRenderIdle();
    const real = getCursorPos();
    const wanted = { x: real.x + 17, y: real.y + 23 };
    const moved = await client.request(ControlCommand.TestCursorPosition, [wanted.x, wanted.y]);
    if (moved[0] !== wanted.x || moved[1] !== wanted.y) throw new Error(`test cursor: ${moved}`);
    if (!same(getCursorPos(), real)) throw new Error("setting override moved real cursor");
    const canvas = findCanvas(frame);
    if (!canvas) throw new Error("canvas missing");
    const beforeClick = getCursorPos();
    await clickAt(canvas, 100, 100, 0);
    if (!same(getCursorPos(), beforeClick)) throw new Error("clickAt moved real cursor");

    const original = getCursorPos();
    const near = { x: 100, y: 100 };
    const distant = { x: 400, y: 400 };
    const nearScreen = clientToScreen(canvas, near.x, near.y);
    const distantScreen = clientToScreen(canvas, distant.x, distant.y);
    const distance = (p: { x: number; y: number }): number => (p.x - original.x) ** 2 + (p.y - original.y) ** 2;
    const target = distance(nearScreen) > distance(distantScreen) ? near : distant;
    const targetScreen = clientToScreen(canvas, target.x, target.y);
    if (distance(targetScreen) < 200 ** 2) throw new Error("real cursor is too close to click target");
    try {
      const origin = clientToScreen(canvas, 0, 0);
      const far = { x: original.x - origin.x, y: original.y - origin.y };
      await moveTestCursor(targetScreen.x, targetScreen.y);
      const before = await scroll(client);
      await clickAt(canvas, target.x, target.y, 0);
      const afterClick = await scroll(client);
      if (afterClick !== before) throw new Error(`clickAt became drag: ${before} -> ${afterClick}`);
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(target.x, target.y));
      sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(far.x, far.y));
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(target.x, target.y));
      const after = await scroll(client);
      if (after !== before) throw new Error(`capture move turned click into drag: ${before} -> ${after}`);

      const tabs = (await client.virtTree()).find((c) => c.kind === "tabs");
      if (!tabs) throw new Error("tab bar missing");
      const inside = clientToScreen(tabs.hwnd, tabs.rect.x + 5, tabs.rect.y + 5);
      await client.request(ControlCommand.TestCursorPosition);
      if (setCursorPos(inside.x, inside.y) && same(getCursorPos(), inside)) {
        sendMessage(tabs.hwnd, WM_MOUSEMOVE, 0, packCoords(tabs.rect.x + 5, tabs.rect.y + 5));
        if (!trackMouseLeave(tabs.hwnd)) {
          throw new Error("could not arm mouse leave tracking");
        }
        await client.request(ControlCommand.TestCursorPosition, [targetScreen.x, targetScreen.y]);
        if (trackMouseLeave(tabs.hwnd)) throw new Error("override left mouse leave tracking armed");
      } else {
        console.log("SKIP mouse leave transition: real pointer unavailable");
      }
    } finally {
      setCursorPos(original.x, original.y);
    }

    const realBeforeClear = getCursorPos();
    const cleared = await client.request(ControlCommand.TestCursorPosition);
    const realAfterClear = getCursorPos();
    if (!same(realAfterClear, realBeforeClear)) throw new Error("clearing override moved real cursor");
    if (cleared[0] !== realAfterClear.x || cleared[1] !== realAfterClear.y)
      throw new Error(`test cursor did not clear: real ${realAfterClear.x},${realAfterClear.y}, app ${cleared}`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
