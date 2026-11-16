// The bookmarks tree's overlay scrollbars go away and move with the tree.
// Switching a panel from Bookmarks back to Thumbnails, or closing the sidebar,
// left them over the thumbnails / the canvas (E96); moving the window left
// them behind (E97): as popups, they followed only the paths that re-synced
// them by hand. Each step below hides or moves the tree another way.
//
// Run: bun tests/ad-hoc-sidebar-tree-bars.ts [--no-build]

import { writeFileSync } from "node:fs";
import { type ControlClient, ControlCommand } from "./control.ts";
import { assemblePdf, cmdId, makePdf, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import {
  killAndWait,
  launchControlled,
  moveTestCursor,
  overlayScrollbarWindows,
  sendCommandSync,
} from "./win-automation.ts";
import {
  clientToScreen,
  getRootWindow,
  getWindowLong,
  getWindowRect,
  GWL_EXSTYLE,
  isIconic,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  sendMessage,
  setProcessDpiAware,
  setWindowPos,
  showWindow,
  sleep,
  SW_SHOWMINNOACTIVE,
  SW_SHOWNOACTIVATE,
  SWP_NOACTIVATE,
  SWP_NOZORDER,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
} from "./winapi.ts";

// a hidden overlay bar stays a visible, fully transparent, click-through window
const WS_EX_TRANSPARENT = 0x20;
const SWP_NOSIZE = 0x0001;
const BOOKMARKS = 0;
const THUMBNAILS = 1;

const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`sidebar-tree-bars: ${what}`);
}

// a step's failure is recorded and the next step still runs
async function step(what: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
    console.log(`  ok: ${what}`);
  } catch (e) {
    failures.push(`${what}: ${(e as Error).message}`);
    console.log(`  FAILED: ${what}: ${(e as Error).message}`);
  }
}

// enough bookmarks too wide and too many for the sidebar: both tree bars show
function makeTocPdf(): string {
  const n = 40;
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>";
  objs[2] = "<< /Type /Pages /Count 1 /Kids [4 0 R] >>";
  objs[3] = `<< /Type /Outlines /First 5 0 R /Last ${4 + n} 0 R /Count ${n} >>`;
  objs[4] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>";
  for (let i = 0; i < n; i++) {
    const id = 5 + i;
    const prev = i > 0 ? ` /Prev ${id - 1} 0 R` : "";
    const next = i < n - 1 ? ` /Next ${id + 1} 0 R` : "";
    const title = `Chapter ${i + 1} with a title far too long to fit into the sidebar`;
    objs[id] = `<< /Title (${title}) /Parent 3 0 R${prev}${next} /Dest [4 0 R /Fit] >>`;
  }
  return assemblePdf(objs.slice(1));
}

function onScreen(h: number): boolean {
  return isWindowVisible(h) && !isIconic(getRootWindow(h)) && (getWindowLong(h, GWL_EXSTYLE) & WS_EX_TRANSPARENT) === 0;
}

// overlay bars on screen: visible with their parents, not minimized, not made transparent
function shownBars(pid: number): Set<number> {
  return new Set(overlayScrollbarWindows(pid).filter(onScreen));
}

function describe(bars: Iterable<number>): string {
  return [...bars]
    .map((h) => {
      const r = getWindowRect(h);
      return `${h}@${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}`;
    })
    .join(" ");
}

// every bar, shown or not, for a failure message
function describeAll(pid: number): string {
  const all = overlayScrollbarWindows(pid);
  return all
    .map((h) => `${describe([h])}${onScreen(h) ? "" : isWindowVisible(h) ? " (transparent)" : " (hidden)"}`)
    .join("; ");
}

async function waitFor(what: string | (() => string), f: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await f())) {
    check(Date.now() < deadline, typeof what === "string" ? what : what());
    await sleep(50);
  }
}

async function sidebarRaw(client: ControlClient): Promise<string> {
  return String((await client.request(ControlCommand.TestSidebarThumbnails, []))[1] ?? "");
}

// the top panel's view, e.g. "thumbnails"
async function topView(client: ControlClient): Promise<string> {
  return /top=\d+,\d,(\w+),/.exec(await sidebarRaw(client))?.[1] ?? "";
}

// clicks a view icon in the top panel's header
async function clickTopIcon(client: ControlClient, view: number): Promise<void> {
  const raw = await sidebarRaw(client);
  const m = /top=(\d+),\d,\w+,\d+,\d+:(\S+)/.exec(raw);
  check(!!m, `no top panel: ${raw}`);
  const hwnd = +m![1]!;
  const [x, y, dx, dy] = m![2]!.split(";")[view]!.split(",").map(Number);
  check(dx! > 0, `view icon ${view} not shown: ${raw}`);
  const pt = { x: x! + (dx! >> 1), y: y! + (dy! >> 1) };
  const screen = clientToScreen(hwnd, pt.x, pt.y);
  await moveTestCursor(screen.x, screen.y, client);
  sendMessage(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(pt.x, pt.y));
  sendMessage(hwnd, WM_LBUTTONUP, 0, packCoords(pt.x, pt.y));
}

// no bar of the tree is left on screen, after the relayout settles
async function expectGone(pid: number, treeBars: Set<number>, what: string): Promise<void> {
  await sleep(300);
  const left = [...shownBars(pid)].filter((h) => treeBars.has(h));
  check(left.length === 0, `${what}: the bookmarks tree's bars still shown: ${describe(left)}`);
}

// each shown bar's place relative to the frame
type Places = Map<number, string>;

function barPlaces(frame: number, bars: Iterable<number>): Places {
  const f = getWindowRect(frame);
  const res: Places = new Map();
  for (const h of bars) {
    const r = getWindowRect(h);
    res.set(h, `${r.left - f.left},${r.top - f.top} ${r.right - r.left}x${r.bottom - r.top}`);
  }
  return res;
}

// the bars shown before are shown again, at the same place in the frame
async function expectPlaces(pid: number, frame: number, before: Places, what: string): Promise<void> {
  let wrong: string[] = [];
  const ok = () => {
    const now = barPlaces(frame, shownBars(pid));
    wrong = [...before].filter(([h, p]) => now.get(h) !== p).map(([h, p]) => `${h} ${p} -> ${now.get(h) ?? "hidden"}`);
    return wrong.length === 0;
  };
  const deadline = Date.now() + 3000;
  while (!ok() && Date.now() < deadline) await sleep(50);
  check(wrong.length === 0, `${what}: bars not where their windows are: ${wrong.join("; ")}`);
}

// Bookmarks shown with both tree bars; returns them (switching tabs makes new ones)
async function showBookmarks(client: ControlClient, pid: number, canvasBars: Set<number>, what: string) {
  if ((await topView(client)) !== "bookmarks") await clickTopIcon(client, BOOKMARKS);
  await waitFor(`${what}: bookmarks didn't show`, async () => (await topView(client)) === "bookmarks");
  let treeBars = new Set<number>();
  await waitFor(
    () => `${what}: the tree's bars didn't come back: ${describeAll(pid)}`,
    () => {
      treeBars = new Set([...shownBars(pid)].filter((h) => !canvasBars.has(h)));
      return treeBars.size === 2;
    },
  );
  return treeBars;
}

export async function testit(): Promise<void> {
  failures.length = 0;
  setProcessDpiAware();
  const pdf = tmpPath("sidebar-tree-bars.pdf");
  writeFileSync(pdf, makeTocPdf(), "latin1");
  const plain = tmpPath("sidebar-tree-bars-plain.pdf");
  writeFileSync(plain, makePdf(3, 0, 0, 0), "latin1");
  const appdata = writeAppdata(
    "sidebar-tree-bars",
    "Theme = Light\nShowToc = false\nNoHomeTab = true\nScrollbars = overlay\n",
  );
  // the bookmarks document is the active tab, the plain one is next to it
  const args = ["-appdata", appdata, "-window-pos", "900x700@20x0", plain, pdf];
  const { proc, client, frame } = await launchControlled(args);
  const pid = proc.pid!;
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    await waitFor("thumbnails didn't show", async () => (await topView(client)) === "thumbnails");
    await sleep(300);
    const canvasBars = shownBars(pid);

    // Bookmarks in the same panel: the tree shows its bars
    let treeBars = await showBookmarks(client, pid, canvasBars, "bookmarks");

    // the view switch back to Thumbnails is what left them (owner's repro)
    await step("back to thumbnails", async () => {
      await clickTopIcon(client, THUMBNAILS);
      await waitFor("thumbnails didn't show again", async () => (await topView(client)) === "thumbnails");
      await expectGone(pid, treeBars, "back to thumbnails");
      treeBars = await showBookmarks(client, pid, canvasBars, "bookmarks again");
    });

    await step("window moved", async () => {
      const before = barPlaces(frame, shownBars(pid));
      const r = getWindowRect(frame);
      setWindowPos(frame, r.left + 70, r.top + 50, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
      await expectPlaces(pid, frame, before, "window moved");
    });

    await step("minimized and restored", async () => {
      const before = barPlaces(frame, shownBars(pid));
      showWindow(frame, SW_SHOWMINNOACTIVE);
      await sleep(300);
      const left = shownBars(pid);
      check(left.size === 0, `minimized: bars still shown: ${describe(left)}`);
      showWindow(frame, SW_SHOWNOACTIVATE);
      await expectPlaces(pid, frame, before, "restored");
    });

    await step("tab switch", async () => {
      sendCommandSync(frame, cmdId("CmdPrevTab"));
      await expectGone(pid, treeBars, "plain document's tab");
      sendCommandSync(frame, cmdId("CmdNextTab"));
      treeBars = await showBookmarks(client, pid, canvasBars, "bookmarks tab again");
    });

    await step("presentation", async () => {
      sendCommandSync(frame, cmdId("CmdTogglePresentationMode"));
      await expectGone(pid, treeBars, "presentation");
      sendCommandSync(frame, cmdId("CmdTogglePresentationMode"));
      treeBars = await showBookmarks(client, pid, canvasBars, "after presentation");
    });

    await step("sidebar closed", async () => {
      sendCommandSync(frame, cmdId("CmdToggleBookmarks"));
      await waitFor("sidebar didn't close", async () => /top=\d+,0,/.test(await sidebarRaw(client)));
      await expectGone(pid, treeBars, "sidebar closed");
    });
    check(failures.length === 0, failures.join("\n"));
    console.log("sidebar-tree-bars: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
