// The floating selection toolbar stands out from the page under it. In dark
// themes its background was the theme's BackgroundColor, which themed pages
// take too, so the card vanished into the page (Solarized Dark).
//
// Run: bun tests/selection-toolbar-contrast.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import {
  cmdId,
  contrastRatio,
  loadPng,
  makeTextPdf,
  pngPixel,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
} from "./util.ts";
import { killAndWait, launchControlled, pressVKey, sendCommandSync } from "./win-automation.ts";
import {
  captureWindowToPng,
  enumWindows,
  getClassName,
  getClientRect,
  getWindowPid,
  getWindowRect,
  findChildWindow,
  isWindowVisible,
  postChar,
  setProcessDpiAware,
  sleep,
} from "./winapi.ts";

const VK_END = 0x23;
const LINE = "The quick brown fox jumps over the lazy dog";
const THEMES = ["Solarized Dark", "Dark", "Light"];
// a card has to separate from the page at least this much (the app aims at 1.5)
const MIN_CONTRAST = 1.45;

const hex = (c: number[]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`selection-toolbar-contrast: ${what}`);
}

// selects the line with the keyboard (v, End), waits for the toolbar and
// returns the card color the app chose
async function selectLine(client: ControlClient, frame: number): Promise<number[]> {
  sendCommandSync(frame, cmdId("CmdSelectTextViaKeyboard"));
  const dump = async () => String((await client.request(ControlCommand.TestSelectTextKeyboard, []))[1] ?? "");
  await waitFor("keyboard selection did not start", async () => /active=1/.test(await dump()));
  await postChar(frame, "v");
  await waitFor("visual mode did not start", async () => /visual=1/.test(await dump()));
  pressVKey(frame, VK_END);
  const toolbar = async () => String((await client.request(ControlCommand.TestSelectionToolbar, []))[1] ?? "");
  let raw = "";
  await waitFor("selection toolbar did not appear", async () => /^visible=1$/m.test((raw = await toolbar())));
  const m = /^bg=(\d+),(\d+),(\d+)$/m.exec(raw);
  if (!m) {
    throw new Error(`selection-toolbar-contrast: no bg= in:\n${raw}`);
  }
  return m.slice(1).map(Number);
}

function findToolbar(pid: number): number {
  let res = 0;
  enumWindows((h: number) => {
    if (getWindowPid(h) === pid && getClassName(h) === "SumatraSelectionToolbar" && isWindowVisible(h)) {
      res = h;
      return false;
    }
    return true;
  });
  return res;
}

// the most common color along the canvas row at screen y: the page (or the
// canvas around it, the same color when themed). PrintWindow, as for the card
function pageColor(frame: number, canvas: number, screenY: number): number[] {
  const shot = tmpPath("selection-toolbar-contrast-frame.png");
  if (!captureWindowToPng(frame, shot)) {
    throw new Error("selection-toolbar-contrast: can't capture the frame");
  }
  const img = loadPng(shot);
  const fw = getWindowRect(frame);
  const cw = getWindowRect(canvas);
  const counts = new Map<string, number>();
  for (let x = cw.left - fw.left; x < cw.right - fw.left; x++) {
    const k = pngPixel(img, x, screenY - fw.top).join(",");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])[0]![0]
    .split(",")
    .map(Number);
}

async function checkTheme(theme: string, pdf: string): Promise<void> {
  const dir = tmpPath("selection-toolbar-contrast-appdata");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `Theme = ${theme}\nRestoreSession = false\nCheckForUpdates = false\nShowToc = false\nSelectionToolbar = true\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const want = await selectLine(client, frame);

    const toolbar = findToolbar(proc.pid!);
    if (!toolbar) {
      throw new Error("selection-toolbar-contrast: no toolbar window");
    }
    // left edge, past the 1px border, halfway down: card background, no
    // button. PrintWindow, not the screen: another window may cover the
    // popup. Polled: right after it shows, it may not be painted yet
    const tr = getClientRect(toolbar);
    const shot = tmpPath("selection-toolbar-contrast.png");
    let card: number[] = [];
    await waitFor(`${theme}: card isn't painted in ${hex(want)}`, async () => {
      if (!captureWindowToPng(toolbar, shot)) {
        return false;
      }
      card = pngPixel(loadPng(shot), 3, Math.floor(tr.bottom / 2));
      return hex(card) === hex(want);
    });

    // the canvas row level with the card's middle
    const canvas = findChildWindow(frame, "SUMATRA_PDF_CANVAS");
    const tw = getWindowRect(toolbar);
    const page = pageColor(frame, canvas, Math.floor((tw.top + tw.bottom) / 2));

    const k = contrastRatio(card, page);
    if (k < MIN_CONTRAST) {
      throw new Error(
        `selection-toolbar-contrast: ${theme}: card ${hex(card)} on page ${hex(page)}, contrast ${k.toFixed(2)}`,
      );
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const pdf = tmpPath("selection-toolbar-contrast.pdf");
  writeFileSync(pdf, makeTextPdf(LINE));
  for (const theme of THEMES) {
    await checkTheme(theme, pdf);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
