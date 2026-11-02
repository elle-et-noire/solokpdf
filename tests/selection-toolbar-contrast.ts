// The floating selection toolbar stands out from the page under it. In dark
// themes its background was the theme's BackgroundColor, which themed pages
// take too, so the card vanished into the page (Solarized Dark).
//
// Run: bun tests/selection-toolbar-contrast.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { cmdId, contrastRatio, makeTextPdf, runStandalone, SETTINGS_FILE, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, pressVKey, sendCommandSync } from "./win-automation.ts";
import {
  enumWindows,
  getClassName,
  getClientRect,
  getWindowPid,
  getWindowRect,
  findChildWindow,
  isWindowVisible,
  postChar,
  readWindowDCRow,
  setProcessDpiAware,
  sleep,
} from "./winapi.ts";

const VK_END = 0x23;
const LINE = "The quick brown fox jumps over the lazy dog";
const THEMES = ["Solarized Dark", "Light"];
// a card has to separate from the page at least this much (the app aims at 1.15)
const MIN_CONTRAST = 1.12;

const rgbOf = (c: number) => [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
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

// selects the line with the keyboard (v, End) and waits for the toolbar
async function selectLine(client: ControlClient, frame: number): Promise<void> {
  sendCommandSync(frame, cmdId("CmdSelectTextViaKeyboard"));
  const dump = async () => String((await client.request(ControlCommand.TestSelectTextKeyboard, []))[1] ?? "");
  await waitFor("keyboard selection did not start", async () => /active=1/.test(await dump()));
  await postChar(frame, "v");
  await waitFor("visual mode did not start", async () => /visual=1/.test(await dump()));
  pressVKey(frame, VK_END);
  const toolbar = async () => String((await client.request(ControlCommand.TestSelectionToolbar, []))[1] ?? "");
  await waitFor("selection toolbar did not appear", async () => /^visible=1$/m.test(await toolbar()));
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

// the most common color of a canvas row: the page (or the canvas around it, the same color when themed)
function pageColor(canvas: number, y: number): number[] {
  const row = readWindowDCRow(canvas, 0, y, getClientRect(canvas).right);
  const counts = new Map<number, number>();
  for (const c of row) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return rgbOf([...counts].sort((a, b) => b[1] - a[1])[0]![0]);
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
    await selectLine(client, frame);

    const toolbar = findToolbar(proc.pid!);
    if (!toolbar) {
      throw new Error("selection-toolbar-contrast: no toolbar window");
    }
    // left edge, past the 1px border, halfway down: card background, no button
    const tr = getClientRect(toolbar);
    const card = rgbOf(readWindowDCRow(toolbar, 3, Math.floor(tr.bottom / 2), 1)[0]!);

    // the canvas row level with the card's middle
    const canvas = findChildWindow(frame, "SUMATRA_PDF_CANVAS");
    const tw = getWindowRect(toolbar);
    const cw = getWindowRect(canvas);
    const page = pageColor(canvas, Math.floor((tw.top + tw.bottom) / 2) - cw.top);

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
