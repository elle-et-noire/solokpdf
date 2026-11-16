// F12 page thumbnails: the page under the mouse gets an outline where the
// selection's goes, in its hue at about half its strength and with no fill
// (E95); the current page keeps its selection look, and leaving the sidebar or
// scrolling another page under the mouse moves the hover (E92).
//
// Run: bun tests/ad-hoc-f12-thumb-hover.ts [--no-build]

import { writeFileSync } from "node:fs";
import { type ControlClient, ControlCommand } from "./control.ts";
import { cmdId, contrastRatio, makePdf, runStandalone, selectionLookError, tmpPath, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled, moveTestCursor, sendCommandSync } from "./win-automation.ts";
import { captureWindowPixels, clientToScreen, packCoords, sendMessage, setProcessDpiAware, sleep } from "./winapi.ts";

const WM_MOUSEMOVE = 0x0200;
const WM_MOUSEWHEEL = 0x020a;
const WM_MOUSELEAVE = 0x02a3;
const WHEEL_DELTA = 120;

type Rc = { x: number; y: number; dx: number; dy: number };
type Thumbs = { hwnd: number; hover: number; rects: Map<number, Rc>; raw: string };

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`f12-thumb-hover: ${what}`);
}

async function thumbs(client: ControlClient): Promise<Thumbs> {
  const res = await client.request(ControlCommand.TestSidebarThumbnails, []);
  const raw = String(res[1] ?? "");
  const m = /hwnd=(\d+) thumbnails=1 .* hover=(-?\d+)/.exec(raw);
  check(res[0] === 0 && !!m, `no thumbnails or hover state: ${raw}`);
  const rects = new Map<number, Rc>();
  for (const r of (/ rects=(\S*)/.exec(raw)?.[1] ?? "").matchAll(/(\d+):(-?\d+),(-?\d+),(\d+),(\d+);/g)) {
    rects.set(+r[1]!, { x: +r[2]!, y: +r[3]!, dx: +r[4]!, dy: +r[5]! });
  }
  return { hwnd: +m![1]!, hover: +m![2]!, rects, raw };
}

async function waitFor(what: string, f: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await f())) {
    check(Date.now() < deadline, what);
    await sleep(50);
  }
}

function pageRect(t: Thumbs, pageNo: number): Rc {
  const r = t.rects.get(pageNo);
  check(!!r && r.dy > 1, `page ${pageNo} not visible: ${t.raw}`);
  return r!;
}

// rgb column above the page's middle, from `above` px over it down to its top
type Cap = { w: number; data: Uint8Array };
function columnAbove(cap: Cap, r: Rc, above: number): number[][] {
  const x = r.x + Math.floor(r.dx / 2);
  const out: number[][] = [];
  for (let y = r.y - above; y < r.y; y++) {
    const o = (y * cap.w + x) * 4;
    out.push([cap.data[o + 2]!, cap.data[o + 1]!, cap.data[o]!]);
  }
  return out;
}

// one capture: the columns above page 1 (current) and page 2
type Look = { cur: number[][]; p2: number[][] };
function look(hwnd: number, p1: Rc, p2: Rc): Look {
  const cap = captureWindowPixels(hwnd);
  check(!!cap, "capture failed");
  return { cur: columnAbove(cap!, p1, 12), p2: columnAbove(cap!, p2, 10) };
}

async function hoverAt(client: ControlClient, hwnd: number, r: Rc): Promise<void> {
  const x = r.x + Math.floor(r.dx / 2);
  const y = r.y + Math.floor(r.dy / 2);
  const pt = clientToScreen(hwnd, x, y);
  await moveTestCursor(pt.x, pt.y, client);
  sendMessage(hwnd, WM_MOUSEMOVE, 0, packCoords(x, y));
}

// the current page: selection fill, its same-hue outline at 3:1
function currentPageError(col: number[][]): string {
  const bg = col[0]!;
  const fill = col[col.length - 1]!;
  let edge = fill;
  for (const c of col) {
    if (contrastRatio(c, bg) > contrastRatio(edge, bg)) edge = c;
  }
  return selectionLookError(bg, fill, edge);
}

// the most contrasting pixel of a column against its first (the sidebar)
function strongest(col: number[][]): number {
  let best = 0;
  for (let i = 1; i < col.length; i++) {
    if (contrastRatio(col[i]!, col[0]!) > contrastRatio(col[best]!, col[0]!)) best = i;
  }
  return best;
}

// what is wrong with page 2's hover ring, "" when right: an outline in the
// selection outline's hue, fainter than it but at least ~1.5:1, and no fill
// between it and the page (E95)
function hoverError(col: number[][], selCol: number[][]): string {
  const bg = col[0]!;
  const ringAt = strongest(col);
  const ring = col[ringAt]!;
  const selEdge = selCol[strongest(selCol)]!;
  const ringK = contrastRatio(ring, bg);
  const selK = contrastRatio(selEdge, bg);
  const what = `bg ${bg} ring ${ring} (${ringK.toFixed(2)}) selection outline ${selEdge} (${selK.toFixed(2)})`;
  if (ringK < 1.5) return `no hover ring above page 2: ${what}`;
  if (ringK >= selK - 0.3) return `hover ring not fainter than the selection outline: ${what}`;

  // same hue: the ring moves from the sidebar the way the selection outline does
  const d = ring.map((v, i) => v - bg[i]!);
  const e = selEdge.map((v, i) => v - bg[i]!);
  const dot = d.reduce((a, v, i) => a + v * e[i]!, 0);
  const cos = dot / Math.sqrt(d.reduce((a, v) => a + v * v, 0) * e.reduce((a, v) => a + v * v, 0));
  if (!(cos > 0.97)) return `hover ring off the selection hue (cos ${cos.toFixed(3)}): ${what}`;

  // the band inside the ring, up to the page frame, stays the sidebar color
  let i = ringAt + 1;
  while (i < col.length && contrastRatio(col[i]!, bg) > 1.3) i++;
  for (; i < col.length; i++) {
    if (contrastRatio(col[i]!, bg) > 1.03) return `fill inside the hover ring: ${col[i]} at ${i}: ${what}`;
  }
  return "";
}

// polls a capture until it holds or 2 s pass; returns the last error
async function settleLook(hwnd: number, p1: Rc, p2: Rc, err: (l: Look) => string): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const e = err(look(hwnd, p1, p2));
    if (e === "" || Date.now() > deadline) return e;
    await sleep(50);
  }
}

async function checkTheme(client: ControlClient, theme: string): Promise<void> {
  // a settled layout and frame to compare against: the sidebar can still be
  // laying out right after it shows
  let t = await thumbs(client);
  let prev = "";
  let base: Look | null = null;
  await waitFor(`${theme}: thumbnails didn't settle: ${t.raw}`, async () => {
    t = await thumbs(client);
    const rects = `${JSON.stringify(t.rects.get(1))}${JSON.stringify(t.rects.get(2))}`;
    const same = rects === prev;
    prev = rects;
    const shown = (t.rects.get(1)?.dy ?? 0) > 1 && (t.rects.get(2)?.dy ?? 0) > 1;
    if (!same || !shown) return false;
    base = look(t.hwnd, pageRect(t, 1), pageRect(t, 2));
    return currentPageError(base.cur) === "";
  });
  const hwnd = t.hwnd;
  const p1 = pageRect(t, 1);
  const p2 = pageRect(t, 2);
  const before = base!.p2;
  const unhovered = (l: Look) => (l.p2.join() === before.join() ? "" : `page 2 still hovered: ${l.p2[8]}`);

  // a non-current page: the hover ring around it, no fill; page 1 unchanged
  await hoverAt(client, hwnd, p2);
  await waitFor(`${theme}: hover not reported on page 2`, async () => (await thumbs(client)).hover === 2);
  let hov: Look = base!;
  let err = await settleLook(hwnd, p1, p2, (l) => {
    hov = l;
    const e = hoverError(l.p2, l.cur);
    return e || currentPageError(l.cur);
  });
  check(err === "", `${theme}: hovering page 2: ${err}`);
  const ringK = contrastRatio(hov.p2[strongest(hov.p2)]!, hov.p2[0]!);
  const selK = contrastRatio(hov.cur[strongest(hov.cur)]!, hov.cur[0]!);
  console.log(`${theme}: hover ring ${ringK.toFixed(2)}:1, selection outline ${selK.toFixed(2)}:1`);

  // the current page hovered keeps the selection look
  await hoverAt(client, hwnd, p1);
  await waitFor(`${theme}: hover not reported on page 1`, async () => (await thumbs(client)).hover === 1);
  err = await settleLook(hwnd, p1, p2, (l) => unhovered(l) || currentPageError(l.cur));
  check(err === "", `${theme}: hovered current page: ${err}`);

  // leaving the sidebar clears it
  await hoverAt(client, hwnd, p2);
  await waitFor(`${theme}: hover not back on page 2`, async () => (await thumbs(client)).hover === 2);
  await moveTestCursor(-10000, -10000, client);
  sendMessage(hwnd, WM_MOUSELEAVE, 0, 0);
  await waitFor(`${theme}: mouse leave kept the hover`, async () => (await thumbs(client)).hover === 0);
  err = await settleLook(hwnd, p1, p2, unhovered);
  check(err === "", `${theme}: after leave: ${err}`);

  // a scroll that brings another page under the mouse moves the hover
  await hoverAt(client, hwnd, p2);
  await waitFor(`${theme}: hover not on page 2 before scrolling`, async () => (await thumbs(client)).hover === 2);
  const x = p2.x + Math.floor(p2.dx / 2);
  const y = p2.y + Math.floor(p2.dy / 2);
  const pt = clientToScreen(hwnd, x, y);
  sendMessage(hwnd, WM_MOUSEWHEEL, BigInt((-WHEEL_DELTA & 0xffff) << 16), packCoords(pt.x, pt.y));
  await waitFor(`${theme}: hover stayed on page 2 after scrolling`, async () => {
    t = await thumbs(client);
    return t.hover !== 2;
  });
  check(t.hover > 2, `${theme}: scrolled hover should be a later page: ${t.raw}`);

  // back to the top, the mouse away, for the next theme
  sendMessage(hwnd, WM_MOUSEWHEEL, BigInt((WHEEL_DELTA * 10) << 16), packCoords(pt.x, pt.y));
  await moveTestCursor(-10000, -10000, client);
  sendMessage(hwnd, WM_MOUSELEAVE, 0, 0);
  await waitFor(`${theme}: no reset`, async () => (await thumbs(client)).hover === 0);
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const pdf = tmpPath("f12-thumb-hover.pdf");
  writeFileSync(pdf, makePdf(12, 400, 0, 0), "latin1");
  const appdata = writeAppdata("f12-thumb-hover", "Theme = Light\nShowToc = false\nNoHomeTab = true\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    await waitFor("thumbnails didn't render", async () => {
      const res = await client.request(ControlCommand.TestSidebarThumbnails, []);
      return /thumbnails=1 .*rendered=[1-9]/.test(String(res[1] ?? ""));
    });
    await checkTheme(client, "Light");
    const t = await thumbs(client);
    const p1 = pageRect(t, 1);
    const p2 = pageRect(t, 2);
    const light = look(t.hwnd, p1, p2).p2.join();
    sendCommandSync(frame, cmdId("CmdToggleLightDarkTheme"));
    await waitFor("theme didn't change", async () => look(t.hwnd, p1, p2).p2.join() !== light);
    await checkTheme(client, "Dark");
    console.log("f12-thumb-hover: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
