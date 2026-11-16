// The bookmarks tree's overlay scrollbars are popups over the sidebar: they go
// away with the tree. Switching a panel from Bookmarks back to Thumbnails, or
// closing the sidebar, left them over the thumbnails / the canvas (E96).
//
// Run: bun tests/ad-hoc-sidebar-tree-bars.ts [--no-build]

import { writeFileSync } from "node:fs";
import { type ControlClient, ControlCommand } from "./control.ts";
import { assemblePdf, cmdId, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled, moveTestCursor, sendCommandSync } from "./win-automation.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getWindowLong,
  getWindowPid,
  getWindowRect,
  GWL_EXSTYLE,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  sendMessage,
  setProcessDpiAware,
  sleep,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
} from "./winapi.ts";

// a hidden overlay bar stays a visible, fully transparent, click-through window
const WS_EX_TRANSPARENT = 0x20;
const BAR_CLASS = "SUMATRA_OVERLAY_SCROLLBAR";
const BOOKMARKS = 0;
const THUMBNAILS = 1;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`sidebar-tree-bars: ${what}`);
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

// overlay bars on screen: visible and not made transparent
function shownBars(pid: number): Set<number> {
  const res = new Set<number>();
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) !== pid || getClassName(hwnd) !== BAR_CLASS || !isWindowVisible(hwnd)) return true;
    if ((getWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TRANSPARENT) === 0) res.add(hwnd);
    return true;
  });
  return res;
}

function describe(bars: Iterable<number>): string {
  return [...bars]
    .map((h) => {
      const r = getWindowRect(h);
      return `${h}@${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}`;
    })
    .join(" ");
}

async function waitFor(what: string, f: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await f())) {
    check(Date.now() < deadline, what);
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

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const pdf = tmpPath("sidebar-tree-bars.pdf");
  writeFileSync(pdf, makeTocPdf(), "latin1");
  const appdata = writeAppdata(
    "sidebar-tree-bars",
    "Theme = Light\nShowToc = false\nNoHomeTab = true\nScrollbars = overlay\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, "-window-pos", "900x700@20x0", pdf]);
  const pid = proc.pid!;
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    await waitFor("thumbnails didn't show", async () => (await topView(client)) === "thumbnails");
    await sleep(300);
    const canvasBars = shownBars(pid);

    // Bookmarks in the same panel: the tree shows its bars
    await clickTopIcon(client, BOOKMARKS);
    await waitFor("bookmarks didn't show", async () => (await topView(client)) === "bookmarks");
    let treeBars = new Set<number>();
    await waitFor(`the bookmarks tree shows no bars: ${describe(shownBars(pid))}`, () => {
      treeBars = new Set([...shownBars(pid)].filter((h) => !canvasBars.has(h)));
      return treeBars.size === 2;
    });

    // the view switch back to Thumbnails is what left them (owner's repro)
    await clickTopIcon(client, THUMBNAILS);
    await waitFor("thumbnails didn't show again", async () => (await topView(client)) === "thumbnails");
    await expectGone(pid, treeBars, "back to thumbnails");

    // shown again with the tree
    await clickTopIcon(client, BOOKMARKS);
    await waitFor("bookmarks didn't show again", async () => (await topView(client)) === "bookmarks");
    await waitFor(`the tree's bars didn't come back: ${describe(shownBars(pid))}`, () => {
      const shown = shownBars(pid);
      return [...treeBars].every((h) => shown.has(h));
    });

    // closing the sidebar from Bookmarks
    sendCommandSync(frame, cmdId("CmdToggleBookmarks"));
    await waitFor("sidebar didn't close", async () => /top=\d+,0,/.test(await sidebarRaw(client)));
    await expectGone(pid, treeBars, "sidebar closed");
    console.log("sidebar-tree-bars: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
