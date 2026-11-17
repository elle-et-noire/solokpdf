// E101: while a test drives the app's test cursor, a WM_MOUSEMOVE that Windows
// posts at the physical pointer must not move any window's hover. The app
// input layer drops it once for all windows; none of the windows checked here
// has test code of its own. Each check hovers A through the test cursor, posts
// a move at B (off the test cursor) and expects the hover unchanged, then
// moves the test cursor to B and expects the hover to follow.
//
// Run: bun tests/ad-hoc-e101-physical-moves.ts [--no-build]

import { writeFileSync } from "node:fs";
import { ControlCommand, type ControlClient, waitForHome } from "./control.ts";
import { findSidebarTree, sidebarItemHeight } from "./sidebar-tree.ts";
import { assemblePdf, cmdId, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import {
  clientToScreen,
  findChildWindow,
  getClientRect,
  packCoords,
  postMessage,
  readWindowDCRow,
  sendMessage,
  sleep,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import { findCanvas, killAndWait, launchControlled, moveTestCursor, sendCommandSync } from "./win-automation.ts";

type Pt = { x: number; y: number };
type State = () => Promise<string>;

const SETTLE_MS = 3000;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`e101: ${what}`);
}

function makePdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [9 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 3 >>",
    "<< /Title (Chapter one) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>",
    "<< /Title (Chapter two) /Parent 5 0 R /Prev 6 0 R /Next 8 0 R /Dest [4 0 R /Fit] >>",
    "<< /Title (Chapter three) /Parent 5 0 R /Prev 7 0 R /Dest [3 0 R /Fit] >>",
    "<< /Type /Annot /Subtype /Highlight /P 3 0 R /Rect [72 560 300 620] /QuadPoints [72 620 300 620 72 560 300 560] /C [1 1 0] >>",
  ]);
}

// pixels read off a window's DC, once two reads agree
async function pixels(hwnd: number, pts: Pt[]): Promise<string> {
  let prev = "";
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const cur = pts.map((p) => readWindowDCRow(hwnd, p.x, p.y, 1)[0]!.toString(16)).join(",");
    if (cur === prev || Date.now() > deadline) return cur;
    prev = cur;
    await sleep(100);
  }
}

async function waitState(state: State, ok: (s: string) => boolean): Promise<string> {
  const deadline = Date.now() + SETTLE_MS;
  let s = await state();
  while (!ok(s) && Date.now() < deadline) {
    await sleep(50);
    s = await state();
  }
  return s;
}

const errors: string[] = [];

// hover a, post a physical-looking move at b, then really move to b
async function checkWindow(client: ControlClient, name: string, hwnd: number, a: Pt, b: Pt, state: State) {
  const sa = clientToScreen(hwnd, a.x, a.y);
  await moveTestCursor(sa.x, sa.y, client);
  sendMessage(hwnd, WM_MOUSEMOVE, 0, packCoords(a.x, a.y));
  await sleep(200);
  const hovered = await state();

  postMessage(hwnd, WM_MOUSEMOVE, 0, packCoords(b.x, b.y));
  // a control request is handled after the posted move: both are posted to the UI thread
  await client.request(ControlCommand.TestFocusState, []);
  await sleep(300);
  const after = await state();
  if (after !== hovered) errors.push(`${name}: a move off the test cursor changed the hover`);

  const sb = clientToScreen(hwnd, b.x, b.y);
  await moveTestCursor(sb.x, sb.y, client);
  postMessage(hwnd, WM_MOUSEMOVE, 0, packCoords(b.x, b.y));
  const moved = await waitState(state, (s) => s !== hovered);
  if (moved === hovered) errors.push(`${name}: a move at the test cursor did not change the hover`);
}

async function markupHover(client: ControlClient): Promise<string> {
  const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1]);
  return /hover=(\d)/.exec(raw)?.[1] ?? raw;
}

async function thumbs(client: ControlClient): Promise<{ hwnd: number; hover: number; rects: Pt[] }> {
  const raw = String((await client.request(ControlCommand.TestSidebarThumbnails, []))[1] ?? "");
  const m = /hwnd=(\d+) thumbnails=1 .* hover=(-?\d+)/.exec(raw);
  check(!!m, `no thumbnails: ${raw}`);
  const rects: Pt[] = [];
  for (const r of (/ rects=(\S*)/.exec(raw)?.[1] ?? "").matchAll(/(\d+):(-?\d+),(-?\d+),(\d+),(\d+);/g)) {
    rects[+r[1]!] = { x: +r[2]! + Math.floor(+r[4]! / 2), y: +r[3]! + Math.floor(+r[5]! / 2) };
  }
  return { hwnd: +m![1]!, hover: +m![2]!, rects };
}

export async function testit(): Promise<void> {
  errors.length = 0;
  const pdf = tmpPath("e101-physical-moves.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const appdata = writeAppdata(
    "e101-physical-moves",
    "Theme = Light\nShowToc = true\nShowFavorites = false\nShowStartPage = true\nRememberOpenedFiles = true\n" +
      "HomePageViewMode = list\n",
  );
  const { proc, client, frame } = await launchControlled([
    "-appdata",
    appdata,
    "-view",
    "single page",
    "-zoom",
    "fit page",
    pdf,
  ]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);

    // document canvas: the highlight's hover
    const canvas = findCanvas(frame);
    const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1]);
    const r = /screen=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(raw);
    check(!!r, `no highlight: ${raw}`);
    const onAnnot = { x: +r![1]! + Math.floor(+r![3]! / 2), y: +r![2]! + Math.floor(+r![4]! / 2) };
    const offAnnot = { x: onAnnot.x, y: +r![2]! + +r![4]! + 80 };
    await checkWindow(client, "canvas", canvas, onAnnot, offAnnot, () => markupHover(client));

    // bookmarks tree: the hovered row's fill
    const tree = findSidebarTree(frame);
    check(!!tree?.virtual, "no virtual bookmarks tree");
    const rowDy = sidebarItemHeight(tree!);
    const row = (i: number) => ({ x: 20, y: i * rowDy + Math.floor(rowDy / 2) });
    const rowEdges = [0, 1, 2].map((i) => ({ x: 2, y: row(i).y }));
    await checkWindow(client, "bookmarks tree", tree!.hwnd, row(1), row(5), () => pixels(tree!.hwnd, rowEdges));

    // toolbar: the hovered button's face
    const toolbar = findChildWindow(frame, "SUMATRA_VIRT_TOOLBAR");
    check(!!toolbar, "no toolbar");
    const tbDy = getClientRect(toolbar).bottom;
    const buttons = (await client.virtTree("SUMATRA_VIRT_TOOLBAR"))
      .filter((c) => c.hwnd === toolbar && c.rect.dx > 0 && c.rect.dx < 3 * tbDy && c.rect.dy > tbDy / 2)
      .sort((p, q) => p.rect.x - q.rect.x);
    check(buttons.length >= 2, `toolbar buttons: ${JSON.stringify(buttons)}`);
    const center = (c: (typeof buttons)[number]) => ({
      x: c.rect.x + Math.floor(c.rect.dx / 2),
      y: c.rect.y + Math.floor(c.rect.dy / 2),
    });
    // a row across both faces, their icons included
    const faceRow: Pt[] = [];
    for (let x = buttons[0]!.rect.x; x < buttons[1]!.rect.x + buttons[1]!.rect.dx; x += 2) {
      faceRow.push({ x, y: center(buttons[0]!).y });
    }
    await checkWindow(client, "toolbar", toolbar, center(buttons[0]!), center(buttons[1]!), () =>
      pixels(toolbar, faceRow),
    );

    // page thumbnails: the hovered page
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    let t = await thumbs(client);
    const deadline = Date.now() + SETTLE_MS;
    while ((!t.rects[1] || !t.rects[2]) && Date.now() < deadline) {
      await sleep(50);
      t = await thumbs(client);
    }
    check(!!t.rects[1] && !!t.rects[2], "page thumbnails not laid out");
    await checkWindow(client, "thumbnails", t.hwnd, t.rects[1]!, t.rects[2]!, async () =>
      String((await thumbs(client)).hover),
    );

    // Home: the hovered history entry
    sendCommandSync(frame, cmdId("CmdClose"));
    const home = await waitForHome(client, (h) => h.entries >= 1, "Home did not show the closed document");
    sendMessage(canvas, 0x0100 /* WM_KEYDOWN */, 0x28 /* VK_DOWN */, 0);
    const sel = await waitForHome(client, (h) => h.sel === 0, `no Home selection: ${home.raw}`);
    const [ex, ey, edx, edy] = sel.selRect;
    const entry = { x: ex! + Math.floor(edx! / 2), y: ey! + Math.floor(edy! / 2) };
    await checkWindow(client, "Home", canvas, entry, { x: 2, y: 2 }, async () =>
      String((await client.homeSelection()).hover),
    );
    check(errors.length === 0, errors.join("; "));
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
