// E88: opening Home leaves the keyboard focus out of its search box. E93: a
// hovered history entry gets a fill of its own, also while the search box has
// the focus, and the selection outline stays where the keys put it (list and
// thumbnails, Light and Dark). E90: plain keys on Home run their shortcuts;
// Ctrl+F, or / with Vim keys, starts a search. E94: the selected entry takes
// the selection color with a same-hue outline at 3:1; hover is half of it.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient, type HomeSelection, waitForHome } from "./control.ts";
import { ROOT, SETTINGS_FILE, cmdId, colorRefRgb, runStandalone, selectionLookError, tmpPath } from "./util.ts";
import {
  clientToScreen,
  getControlText,
  packCoords,
  getClientRect,
  postMessage,
  readWindowDCRow,
  sendMessage,
  sleep,
  VK_ESCAPE,
  WM_KEYDOWN,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import {
  activateTestFrame,
  findCanvas,
  findChildByClass,
  killAndWait,
  launchControlled,
  moveTestCursor,
  sendCommand,
} from "./win-automation.ts";

const N_FILES = 6;
const VK_LEFT = 0x25;
const VK_UP = 0x26;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const VK_4 = 0x34;
const SCAN_4 = 0x05;
const VK_T = 0x54;
const SCAN_T = 0x14;
const VK_SLASH = 0xbf;
const SCAN_SLASH = 0x35;
const THEME_WAIT_MS = 3000;
// focus must not move to the search box once Home is up
const SETTLE_MS = 400;

function check(cond: boolean, what: string): void {
  if (!cond) throw new Error(`ad-hoc-e88: ${what}`);
}

function makeAppDir(name: string, extra = ""): string {
  const dir = tmpPath(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "sub"), { recursive: true });
  const src = join(ROOT, "ext", "a-zlib", "zlib.3.pdf");
  const states: string[] = [];
  for (let i = 0; i < N_FILES; i++) {
    const p = join(dir, "sub", `doc-${String(i).padStart(2, "0")}.pdf`);
    copyFileSync(src, p);
    states.push(`\t[\n\t\tFilePath = ${p}\n\t\tOpenCount = ${N_FILES - i}\n\t]`);
  }
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = true\n` +
      `HomePageViewMode = thumbnails\n${extra}FileStates [\n${states.join("\n")}\n]\n`,
  );
  return dir;
}

async function expectNoSearchFocus(client: ControlClient, what: string): Promise<void> {
  await waitForHome(client, (h) => h.entries === N_FILES && h.searchBox, `${what}: Home not ready`);
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const h = await client.homeSelection();
    check(!h.searchFocus, `${what}: the search box took the focus`);
    await sleep(50);
  }
}

function pixel(canvas: number, x: number, y: number): number {
  return readWindowDCRow(canvas, x, y, 1)[0] ?? 0;
}

const hex = (c: number) => c.toString(16).padStart(6, "0");

// the selected view button's fill, the selection color on Home's background:
// its most common pixel other than the background
function selectedButtonFill(canvas: number, h: HomeSelection, bg: number): number {
  const [lx, y, dx, dy] = h.listIcon;
  const x = h.listView ? lx! : h.views[0]!;
  const counts = new Map<number, number>();
  for (let yy = y! + 1; yy < y! + dy! - 1; yy++) {
    for (const c of readWindowDCRow(canvas, x + 1, yy, dx! - 2)) {
      if (c !== bg) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  check(!!best, `no selected view button at ${x},${y}`);
  return best![0];
}

// the pixel at x, y once it satisfies ok, or after a repaint's time
async function settledPixel(canvas: number, x: number, y: number, ok: (c: number) => boolean): Promise<number> {
  const deadline = Date.now() + 1000;
  let c = pixel(canvas, x, y);
  while (!ok(c) && Date.now() < deadline) {
    await sleep(30);
    c = pixel(canvas, x, y);
  }
  return c;
}

// the selection look of the entry whose outline rect is r (E94)
async function checkSelected(
  canvas: number,
  r: number[],
  mode: "list" | "thumbnails",
  bg: number,
  sel: number,
  what: string,
): Promise<void> {
  const [fx, fy] = fillPoint(r, mode);
  const fill = await settledPixel(canvas, fx, fy, (c) => c === sel);
  check(fill === sel, `${what}: selection fill ${hex(fill)} is not the selection color ${hex(sel)}`);
  const edge = pixel(canvas, r[0]! + 1, fy);
  const err = selectionLookError(colorRefRgb(bg), colorRefRgb(fill), colorRefRgb(edge));
  check(err === "", `${what}: ${err}`);
}

// hover is halfway from the background to the selection color
function checkHoverFill(fill: number, bg: number, sel: number, what: string) {
  for (let shift = 0; shift < 24; shift += 8) {
    const want = (((bg >> shift) & 0xff) + ((sel >> shift) & 0xff)) / 2;
    const got = (fill >> shift) & 0xff;
    check(Math.abs(got - want) <= 1, `${what}: hover fill ${hex(fill)} is not halfway from ${hex(bg)} to ${hex(sel)}`);
  }
}

// a point inside an entry's hover fill but outside its page / row content and
// its selection ring (r is the entry's selection outline rect)
function fillPoint(r: number[], mode: "list" | "thumbnails"): [number, number] {
  const y = r[1]! + Math.floor(r[3]! / 2);
  // list: the outline's side padding; thumbnails: just outside the ring
  return [mode === "list" ? r[0]! + 4 : r[0]! - 2, y];
}

// Arrow keys select entry A, the mouse moves onto entry B: the selection stays
// on A, B is hovered and filled with half the selection step, not over its
// thumbnail image. Hovering A keeps its selection look. Then the search box
// takes the focus: the selection hides (Enter there opens nothing) and B keeps
// its fill.
async function checkHover(
  client: ControlClient,
  frame: number,
  canvas: number,
  mode: "list" | "thumbnails",
  theme: string,
): Promise<void> {
  const what = `${theme} ${mode}`;
  await client.homeSelection(mode);
  await waitForHome(client, (s) => s.listView === (mode === "list") && s.entries === N_FILES, `${what}: no layout`);
  await moveTestCursor(0, 0);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(1, 1));
  await activateTestFrame(client);
  const next = mode === "list" ? VK_DOWN : VK_RIGHT;
  const prev = mode === "list" ? VK_UP : VK_LEFT;
  sendMessage(canvas, WM_KEYDOWN, next, 0);
  const ha = await waitForHome(client, (s) => s.sel >= 0 && s.selShown && s.hover < 0, `${what}: no selection`);
  const a = ha.sel;
  const ra = ha.selRect;
  sendMessage(canvas, WM_KEYDOWN, next, 0);
  const hb = await waitForHome(client, (s) => s.sel === a + 1, `${what}: arrow did not move the selection`);
  const b = hb.sel;
  const rb = hb.selRect;
  sendMessage(canvas, WM_KEYDOWN, prev, 0);
  await waitForHome(client, (s) => s.sel === a, `${what}: arrow did not move the selection back`);

  const bg = backgroundPixel(canvas);
  const sel = selectedButtonFill(canvas, ha, bg);
  await checkSelected(canvas, ra, mode, bg, sel, `${what}: selected entry ${a}`);
  const [ax, ay] = fillPoint(ra, mode);
  const [bx, by] = fillPoint(rb, mode);
  const cx = rb[0]! + Math.floor(rb[2]! / 2);
  const cy = rb[1]! + Math.floor(rb[3]! / 2);
  const pageBefore = pixel(canvas, cx, cy);
  check(pixel(canvas, bx, by) === bg, `${what}: entry ${b} is filled before hover`);

  const screen = clientToScreen(canvas, cx, cy);
  await moveTestCursor(screen.x, screen.y);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(cx, cy));
  const h = await waitForHome(client, (s) => s.hover === b, `${what}: entry ${b} is not hovered`);
  check(h.sel === a && h.selShown, `${what}: hover moved the selection from ${a} to ${h.sel}`);

  const fill = await settledPixel(canvas, bx, by, (c) => c !== bg);
  checkHoverFill(fill, bg, sel, `${what}: entry ${b}`);
  check(pixel(canvas, bx + 1, by) === fill, `${what}: hovered entry ${b} is outlined`);
  await checkSelected(canvas, ra, mode, bg, sel, `${what}: selected entry ${a} next to hover`);
  if (mode === "thumbnails") {
    check(pixel(canvas, cx, cy) === pageBefore, `${what}: hover tinted the thumbnail image`);
  }

  // selected and hovered: the selection look, unchanged
  const acx = ra[0]! + Math.floor(ra[2]! / 2);
  const acy = ra[1]! + Math.floor(ra[3]! / 2);
  const sa = clientToScreen(canvas, acx, acy);
  await moveTestCursor(sa.x, sa.y);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(acx, acy));
  await waitForHome(client, (s) => s.hover === a && s.sel === a, `${what}: entry ${a} is not hovered`);
  await checkSelected(canvas, ra, mode, bg, sel, `${what}: selected and hovered entry ${a}`);
  if (mode === "thumbnails") {
    // every entry is the same document
    check(pixel(canvas, acx, acy) === pageBefore, `${what}: the selection tinted the thumbnail image`);
  }
  await moveTestCursor(screen.x, screen.y);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(cx, cy));
  await waitForHome(client, (s) => s.hover === b && s.sel === a, `${what}: entry ${b} is not hovered again`);

  sendCommand(frame, cmdId("CmdFindFirst"));
  const f = await waitForHome(client, (s) => s.searchFocus, `${what}: CmdFindFirst did not focus the search box`);
  check(f.sel === a && !f.selShown && f.hover === b, `${what}: search focus state ${f.raw}`);
  check(pixel(canvas, bx, by) === fill, `${what}: hover fill gone while the search box has the focus`);
  const hidden = await settledPixel(canvas, ax, ay, (c) => c === bg);
  check(hidden === bg, `${what}: selection fill shown while the search box has the focus`);
}

async function checkHoverViews(client: ControlClient, frame: number, canvas: number, theme: string): Promise<void> {
  await checkHover(client, frame, canvas, "thumbnails", theme);
  await checkHover(client, frame, canvas, "list", theme);
}

// a canvas pixel below the entries: the Home background
function backgroundPixel(canvas: number): number {
  const r = getClientRect(canvas);
  return readWindowDCRow(canvas, 3, r.bottom - 5, 1)[0] ?? 0;
}

export async function testit(): Promise<void> {
  const { proc, client, frame } = await launchControlled(["-appdata", makeAppDir("ad-hoc-e88", "Theme = Light\n")]);
  try {
    const canvas = findCanvas(frame);
    check(canvas !== 0, "canvas not found");
    await expectNoSearchFocus(client, "startup Home");

    const pressed = await client.request(ControlCommand.TestShortcutsDialog, ["press", "", "Ctrl+T"]);
    check(pressed[1] === "CmdNewTab", `Ctrl+T ran ${pressed[1]}`);
    await expectNoSearchFocus(client, "Home from Ctrl+T");

    await checkHoverViews(client, frame, canvas, "Light");
    const light = backgroundPixel(canvas);
    sendCommand(frame, cmdId("CmdToggleLightDarkTheme"));
    const themeDeadline = Date.now() + THEME_WAIT_MS;
    while (backgroundPixel(canvas) === light && Date.now() < themeDeadline) await sleep(50);
    check(backgroundPixel(canvas) !== light, "CmdToggleLightDarkTheme did not change the theme");
    await checkHoverViews(client, frame, canvas, "Dark");

    // Esc leaves the search box; a plain key then runs its shortcut (T: next
    // theme) instead of starting a search
    const edit = findChildByClass(canvas, "Edit");
    check(edit !== 0, "search edit not found");
    sendMessage(edit, WM_KEYDOWN, VK_ESCAPE, 0);
    await waitForHome(client, (s) => !s.searchFocus && s.entries === N_FILES, "Esc did not leave the search box");
    const before = backgroundPixel(canvas);
    postMessage(canvas, WM_KEYDOWN, VK_T, 1 | (SCAN_T << 16));
    const deadline = Date.now() + THEME_WAIT_MS;
    while (backgroundPixel(canvas) === before && Date.now() < deadline) await sleep(50);
    check(backgroundPixel(canvas) !== before, "T on Home did not change the theme");
    await expectNoSearchFocus(client, "after T");

    // without Vim keys / has no binding and stays out of the search box
    postMessage(canvas, WM_KEYDOWN, VK_SLASH, 1 | (SCAN_SLASH << 16));
    await expectNoSearchFocus(client, "after / without Vim keys");

    // Ctrl+F focuses the box, and typing there filters the list
    const found = await client.request(ControlCommand.TestShortcutsDialog, ["press", "", "Ctrl+F"]);
    check(found[1] === "CmdFindFirst", `Ctrl+F ran ${found[1]}`);
    await waitForHome(client, (s) => s.searchFocus, "Ctrl+F did not focus the search box");
    postMessage(edit, WM_KEYDOWN, VK_4, 1 | (SCAN_4 << 16));
    await waitForHome(
      client,
      (s) => s.searchFocus && s.entries === 1 && s.path.includes("doc-04.pdf"),
      "typing in the search box did not filter",
    );
  } finally {
    client.close();
    await killAndWait(proc);
  }
  await checkVimSlash();
}

// with Vim keys on, / on Home focuses the search box (CmdFindFirst)
async function checkVimSlash(): Promise<void> {
  const { proc, client, frame } = await launchControlled([
    "-appdata",
    makeAppDir("ad-hoc-e90-vim", "VimKeys = true\n"),
  ]);
  try {
    await activateTestFrame(client);
    const canvas = findCanvas(frame);
    check(canvas !== 0, "vim: canvas not found");
    await expectNoSearchFocus(client, "vim: startup Home");
    postMessage(canvas, WM_KEYDOWN, VK_SLASH, 1 | (SCAN_SLASH << 16));
    await waitForHome(client, (s) => s.searchFocus && s.entries === N_FILES, "vim: / did not focus the search box");
    const text = getControlText(findChildByClass(canvas, "Edit"));
    check(text === "", `vim: / typed "${text}" instead of running CmdFindFirst`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
