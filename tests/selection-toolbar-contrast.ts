// The floating selection toolbar is a raised surface, as the command palette:
// lighter than the canvas, which themed pages take, and set apart from the page
// by a drop shadow and its border (E91). The shadow is painted on the canvas,
// so it has to go when the toolbar does.
//
// Run: bun tests/selection-toolbar-contrast.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import {
  cmdId,
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
  isWindowVisible,
  postChar,
  setProcessDpiAware,
  sleep,
} from "./winapi.ts";

const VK_ESCAPE = 0x1b;
const VK_END = 0x23;
const LINE = "The quick brown fox jumps over the lazy dog";
const THEMES = ["Solarized Dark", "Dark", "Light"];

const hex = (c: number[]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const sum = (c: number[]) => c[0]! + c[1]! + c[2]!;

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

// the frame, PrintWindow as for the card: another window may cover it.
// Returns its pixel at a screen point
function shootFrame(frame: number): (x: number, y: number) => number[] {
  const shot = tmpPath("selection-toolbar-contrast-frame.png");
  if (!captureWindowToPng(frame, shot)) {
    throw new Error("selection-toolbar-contrast: can't capture the frame");
  }
  const img = loadPng(shot);
  const fw = getWindowRect(frame);
  return (x, y) => pngPixel(img, x - fw.left, y - fw.top);
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
    const before = shootFrame(frame);
    const want = await selectLine(client, frame);

    const toolbar = findToolbar(proc.pid!);
    if (!toolbar) {
      throw new Error("selection-toolbar-contrast: no toolbar window");
    }
    // left edge, past the 1px border, halfway down: card background, no
    // button. Polled: right after it shows, it may not be painted yet
    const tr = getClientRect(toolbar);
    const shot = tmpPath("selection-toolbar-contrast.png");
    await waitFor(`${theme}: card isn't painted in ${hex(want)}`, async () => {
      if (!captureWindowToPng(toolbar, shot)) {
        return false;
      }
      return hex(pngPixel(loadPng(shot), 3, Math.floor(tr.bottom / 2))) === hex(want);
    });

    // just below the card's middle: darker than the page there while the
    // toolbar shows, the page again once it hides
    const tw = getWindowRect(toolbar);
    const x = Math.floor((tw.left + tw.right) / 2);
    const y = tw.bottom + 1;
    const page = before(x, y);
    // themed pages take the canvas color, which the card rises above
    if (sum(want) <= sum(page)) {
      throw new Error(`selection-toolbar-contrast: ${theme}: card ${hex(want)} isn't lighter than page ${hex(page)}`);
    }
    // on a black page no shadow can show: the border sets the card apart
    if (sum(page) > 0) {
      await waitFor(
        `${theme}: no shadow under the card on ${hex(page)}`,
        async () => sum(shootFrame(frame)(x, y)) < sum(page),
      );
    }

    pressVKey(frame, VK_ESCAPE);
    pressVKey(frame, VK_ESCAPE);
    await waitFor(`${theme}: the toolbar did not hide`, async () => !isWindowVisible(toolbar));
    let left = page;
    try {
      await waitFor(`${theme}: shadow left behind`, async () => hex((left = shootFrame(frame)(x, y))) === hex(page));
    } catch (err) {
      throw new Error(`${(err as Error).message}: ${hex(left)}, page ${hex(page)}`);
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
