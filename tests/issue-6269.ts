// #6269: focusing the no-activate About popup on Copy mouse-down closes it
// before mouse-up, so the report is not copied.

import { ControlCommand, type ControlClient, type LayoutRect } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { APP_NAME, runStandalone, USE_NG } from "./util.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getForegroundWindow,
  getWindowPid,
  getWindowRect,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  sendMessage,
  sleep,
  WA_INACTIVE,
  WM_ACTIVATE,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import { findCanvas, killAndWait, launchControlled, moveTestCursor } from "./win-automation.ts";

const kCanvasClass = "SUMATRA_PDF_CANVAS";
const kAboutHoverClass = "SUMATRA_ABOUT_HOVER";

function centerOf(r: LayoutRect): { x: number; y: number } {
  return { x: r.x + Math.floor(r.dx / 2), y: r.y + Math.floor(r.dy / 2) };
}

async function waitNamed(client: ControlClient, className: string, name: string): Promise<LayoutRect> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const rows = await client.virtTree(className);
    const hit = rows.find((r) => r.name === name && r.rect.dx > 0 && r.rect.dy > 0);
    if (hit) return hit.rect;
    if (Date.now() > deadline) throw new Error(`issue-6269: no ${name} in ${className}`);
    await sleep(40);
  }
}

function findHover(pid: number): number {
  let found = 0;
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) === pid && getClassName(hwnd) === kAboutHoverClass && isWindowVisible(hwnd)) {
      found = hwnd;
      return false;
    }
    return true;
  });
  return found;
}

async function showByHover(client: ControlClient, canvas: number, pid: number): Promise<number> {
  const logo = centerOf(await waitNamed(client, kCanvasClass, "homeLogo"));
  const screen = clientToScreen(canvas, logo.x, logo.y);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(0, 0));
  await moveTestCursor(screen.x, screen.y, client);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(logo.x, logo.y));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const hover = findHover(pid);
    if (hover) return hover;
    await sleep(40);
  }
  throw new Error("issue-6269: About popup did not appear on hover");
}

async function walkTo(
  client: ControlClient,
  canvas: number,
  hover: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const popup = getWindowRect(hover);
  for (let i = 1; i <= 8; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / 8);
    const y = Math.round(from.y + ((to.y - from.y) * i) / 8);
    const target = x >= popup.left && x < popup.right && y >= popup.top && y < popup.bottom ? hover : canvas;
    const origin = clientToScreen(target, 0, 0);
    await moveTestCursor(x, y, client);
    sendMessage(target, WM_MOUSEMOVE, 0, packCoords(x - origin.x, y - origin.y));
    if (!isWindowVisible(hover)) throw new Error("issue-6269: About popup closed while moving onto Copy");
  }
}

function checkPopup(hover: number, stage: string): void {
  if (!isWindowVisible(hover)) throw new Error(`issue-6269: About popup closed ${stage}`);
}

async function focusState(client: ControlClient): Promise<string> {
  const state = String((await client.request(ControlCommand.TestFocusState))[1] ?? "");
  if (!/^focus=(none|frame|canvas|about|other) active=(none|frame|canvas|about|other)$/.test(state)) {
    throw new Error(`issue-6269: invalid focus state ${JSON.stringify(state)}`);
  }
  return state;
}

async function checkFocus(client: ControlClient, before: string, stage: string): Promise<void> {
  const after = await focusState(client);
  if (after !== before) throw new Error(`issue-6269: focus changed ${stage}: ${before} -> ${after}`);
}

async function clickCopy(
  client: ControlClient,
  frame: number,
  canvas: number,
  hover: number,
  mode: "background" | "foreground",
): Promise<void> {
  const { x, y } = centerOf(await waitNamed(client, kAboutHoverClass, "aboutCopy"));
  const logo = centerOf(await waitNamed(client, kCanvasClass, "homeLogo"));
  await walkTo(client, canvas, hover, clientToScreen(canvas, logo.x, logo.y), clientToScreen(hover, x, y));
  checkPopup(hover, "before Copy mouse-down");
  const before = await focusState(client);
  const lp = packCoords(x, y);
  sendMessage(hover, WM_LBUTTONDOWN, MK_LBUTTON, lp);
  await checkFocus(client, before, "on Copy mouse-down");
  checkPopup(hover, "on Copy mouse-down");
  if (mode === "foreground") sendMessage(frame, WM_ACTIVATE, WA_INACTIVE, 0);
  await sleep(120);
  checkPopup(hover, "before Copy mouse-up");
  sendMessage(hover, WM_LBUTTONUP, 0, lp);
  await checkFocus(client, before, "after Copy mouse-up");
  checkPopup(hover, "after Copy mouse-up");
  await sleep(100);
  const text = String((await client.request(ControlCommand.TestClipboardText, ["get"]))[1] ?? "");
  if (!text.startsWith(APP_NAME)) {
    throw new Error(`issue-6269: Copy did not record the report: ${JSON.stringify(text.slice(0, 80))}`);
  }
}

export async function testit(): Promise<void> {
  if (!IS_WIN || USE_NG) {
    console.log("SKIP issue-6269: About hover is a Win32 no-activate popup");
    return;
  }
  let app: Awaited<ReturnType<typeof launchControlled>> | undefined;
  let second: Awaited<ReturnType<typeof launchControlled>> | undefined;
  try {
    app = await launchControlled([]);
    second = await launchControlled([]);
    await app.client.request(ControlCommand.TestClipboardText, ["enable"]);
    const canvas = findCanvas(app.frame);
    const hover = await showByHover(app.client, canvas, app.proc.pid!);
    if (getForegroundWindow() === app.frame) throw new Error("issue-6269: background frame became foreground");
    await clickCopy(app.client, app.frame, canvas, hover, "background");

    if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.SOLOKPDF_REAL_DESKTOP === "1") {
      await app.client.request(ControlCommand.TestFocusState, ["activate"]);
      if (getForegroundWindow() !== app.frame) throw new Error("issue-6269: could not activate the test frame");
      await app.client.request(ControlCommand.TestClipboardText, ["enable"]);
      const foregroundHover = await showByHover(app.client, canvas, app.proc.pid!);
      await clickCopy(app.client, app.frame, canvas, foregroundHover, "foreground");
    } else {
      console.log("SKIP issue-6269 foreground: CI or SOLOKPDF_REAL_DESKTOP=1 required");
    }
  } finally {
    try {
      if (second) {
        second.client.close();
        await killAndWait(second.proc);
      }
    } finally {
      if (app) {
        app.client.close();
        await killAndWait(app.proc);
      }
    }
  }
}

if (import.meta.main) await runStandalone(testit);
