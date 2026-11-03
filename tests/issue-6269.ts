// #6269: focusing the no-activate About popup on Copy mouse-down closes it
// before mouse-up, so the report is not copied.

import type { ControlClient, LayoutRect } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { APP_NAME, runStandalone, USE_NG } from "./util.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getForegroundWindow,
  getWindowPid,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  sendMessage,
  sleep,
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

function clipboardText(): string {
  const res = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard -Raw"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) throw new Error(`issue-6269: Get-Clipboard failed: ${res.stderr.toString()}`);
  return res.stdout.toString().replace(/\r?\n$/, "");
}

function setClipboard(value: string): void {
  const command =
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())";
  const res = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", command], {
    stdin: Buffer.from(value, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) throw new Error(`issue-6269: Set-Clipboard failed: ${res.stderr.toString()}`);
}

async function clickCopy(client: ControlClient, hover: number): Promise<void> {
  const { x, y } = centerOf(await waitNamed(client, kAboutHoverClass, "aboutCopy"));
  const screen = clientToScreen(hover, x, y);
  await moveTestCursor(screen.x, screen.y, client);
  sendMessage(hover, WM_MOUSEMOVE, 0, packCoords(x, y));
  const lp = packCoords(x, y);
  sendMessage(hover, WM_LBUTTONDOWN, MK_LBUTTON, lp);
  if (!isWindowVisible(hover)) throw new Error("issue-6269: About popup closed on Copy mouse-down");
  await sleep(120);
  if (!isWindowVisible(hover)) throw new Error("issue-6269: About popup closed before Copy mouse-up");
  sendMessage(hover, WM_LBUTTONUP, 0, lp);
  await sleep(100);
  const text = clipboardText();
  if (!text.startsWith(APP_NAME)) {
    throw new Error(`issue-6269: Copy did not put the report on the clipboard: ${JSON.stringify(text.slice(0, 80))}`);
  }
}

export async function testit(): Promise<void> {
  if (!IS_WIN || USE_NG) {
    console.log("SKIP issue-6269: About hover is a Win32 no-activate popup");
    return;
  }
  const originalClipboard = clipboardText();
  let background: Awaited<ReturnType<typeof launchControlled>> | undefined;
  let front: Awaited<ReturnType<typeof launchControlled>> | undefined;
  try {
    setClipboard("issue-6269-sentinel");
    background = await launchControlled([]);
    front = await launchControlled([]);
    if (getForegroundWindow() === background.frame) throw new Error("issue-6269: frame stayed foreground");
    const canvas = findCanvas(background.frame);
    const hover = await showByHover(background.client, canvas, background.proc.pid!);
    await clickCopy(background.client, hover);
  } finally {
    if (front) {
      front.client.close();
      await killAndWait(front.proc);
    }
    if (background) {
      background.client.close();
      await killAndWait(background.proc);
    }
    setClipboard(originalClipboard);
  }
}

if (import.meta.main) await runStandalone(testit);
