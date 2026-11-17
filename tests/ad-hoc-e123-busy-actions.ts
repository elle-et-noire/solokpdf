// E123: a user action while a render holds the page's lock finds what is under
// the pointer as it would with no render running: the context menu has the
// link's and the image's items, a press on an image starts its drag, an Edit
// PDF click selects the annotation and a click on a link follows it.
//
// Test hooks hold the lock (PDFium's global lock, or MuPDF's document lock) on
// another thread, as a render does, on both engines.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e123-busy-actions.ts --no-build

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, pollUntil, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  clientToScreen,
  getPopupMenuHandle,
  MK_LBUTTON,
  type MenuItem,
  packCoords,
  postMessage,
  readMenuTree,
  sendMessage,
  setProcessDpiAware,
  sleep,
  VK_ESCAPE,
  WM_KEYDOWN,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
} from "./winapi.ts";
import {
  clickAt,
  findCanvas,
  findSubMenu,
  killAndWait,
  launchControlled,
  moveTestCursor,
  openContextMenu,
  sendCommandSync,
  waitForContextMenu,
} from "./win-automation.ts";

const HOLD_MS = 1000;
const WAIT_MS = 5000;

type Engine = "pdfium" | "mupdf";
type Pt = { x: number; y: number };

// page 1, in PDF points: a web link and a link to page 2 side by side at the
// top, an image and a square annotation side by side below them
const SQUARE = { x0: 330, y0: 340, x1: 556, y1: 560 };
const WEB_LINK = { x: 150, y: 700 };
const PAGE_LINK = { x: 460, y: 700 };
const IMAGE = { x: 173, y: 450 };

function makePdf(): string {
  const content = "q 234 0 0 220 56 340 cm /Im0 Do Q";
  const hex = "ff0000".repeat(4);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 6 0 R >> >> " +
      "/Contents 5 0 R /Annots [7 0 R 8 0 R 9 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${hex.length + 1} >>\nstream\n${hex}>\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [0 600 306 792] /Border [0 0 0] /A << /S /URI /URI (https://example.com/e123) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [306 600 612 792] /Border [0 0 0] /Dest [4 0 R /XYZ 0 792 null] >>",
    `<< /Type /Annot /Subtype /Square /Rect [${SQUARE.x0} ${SQUARE.y0} ${SQUARE.x1} ${SQUARE.y1}] /C [0 0 1] >>`,
  ]);
}

async function markupState(client: ControlClient): Promise<string> {
  return String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
}

// canvas point of page-1 point p, from where the square is on screen
async function pageToCanvas(client: ControlClient): Promise<(p: Pt) => Pt> {
  const re = /type=Square(?:(?!type=)[\s\S])*?screen=(-?\d+),(-?\d+),(\d+),(\d+)/;
  const m = await pollUntil(
    async () => re.exec(await markupState(client)),
    (r) => !!r && +r[3]! > 0,
    { timeoutMs: WAIT_MS, error: "the square is not on screen" },
  );
  const scale = +m![3]! / (SQUARE.x1 - SQUARE.x0);
  const left = +m![1]!;
  const top = +m![2]!;
  return (p) => ({
    x: Math.round(left + (p.x - SQUARE.x0) * scale),
    y: Math.round(top + (SQUARE.y1 - p.y) * scale),
  });
}

// another thread holds the lock the action's lookup needs, as a render does
async function holdLock(client: ControlClient, hook: string): Promise<number> {
  const res = await client.request(ControlCommand.TestCurrentPdf, [hook, HOLD_MS]);
  if (res[0] !== 0) throw new Error(`${hook}: ${res[1]}`);
  return Date.now();
}

function checkHeld(start: number, what: string): void {
  if (Date.now() - start >= HOLD_MS) throw new Error(`${what}: the lock was released before the action`);
}

async function contextMenuAt(canvas: number, pt: Pt, client: ControlClient): Promise<MenuItem[]> {
  const s = clientToScreen(canvas, pt.x, pt.y);
  await moveTestCursor(s.x, s.y, client);
  openContextMenu(canvas, s.x, s.y);
  const popup = await waitForContextMenu(WAIT_MS);
  if (!popup) return [];
  const hmenu = getPopupMenuHandle(popup);
  const items = hmenu ? readMenuTree(hmenu) : [];
  postMessage(popup, WM_KEYDOWN, VK_ESCAPE, 0);
  await sleep(150);
  return items;
}

function menuText(items: MenuItem[]): string {
  return items.map((it) => it.text).join(", ");
}

async function check(engine: Engine, failures: string[]): Promise<void> {
  const dir = tmpPath(`ad-hoc-e123-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\n");
  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-view", "single page", "-zoom", "fit page", pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } as Record<string, string> },
  );
  // the page's elements: PDFium's own lock, or MuPDF's document lock
  const elementLock = engine === "pdfium" ? "hold-pdfium-lock" : "hold-editor-lock";
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const toCanvas = await pageToCanvas(client);

    // each action runs while another thread holds the lock; all are reported
    const step = async (what: string, run: () => Promise<string | null>) => {
      await client.waitForRenderIdle();
      const err = await run();
      if (err) failures.push(`${engine} ${what}: ${err}`);
      console.log(`${engine} ${what}: ${err ? "FAILED" : "OK"}`);
    };

    await step("link menu", async () => {
      checkHeld(await holdLock(client, elementLock), "link menu");
      const items = await contextMenuAt(canvas, toCanvas(WEB_LINK), client);
      return items.some((it) => it.text === "Copy Link Address") ? null : `no Copy Link Address in ${menuText(items)}`;
    });

    await step("image menu", async () => {
      checkHeld(await holdLock(client, elementLock), "image menu");
      const items = await contextMenuAt(canvas, toCanvas(IMAGE), client);
      const image = findSubMenu(items, "Selected Image");
      if (image?.items?.some((it) => it.text === "Copy To Clipboard")) return null;
      return `no Selected Image > Copy To Clipboard in ${menuText(items)}`;
    });

    await step("image drag", async () => {
      const img = toCanvas(IMAGE);
      const s = clientToScreen(canvas, img.x, img.y);
      await moveTestCursor(s.x, s.y, client);
      checkHeld(await holdLock(client, elementLock), "image drag");
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(img.x, img.y));
      const press = String((await client.request(ControlCommand.TestCurrentPdf, ["press"]))[1] ?? "");
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(img.x, img.y));
      return press.includes("image=1") ? null : `the press found no image (${press})`;
    });

    // the square's lookup is the editor's
    await step("Edit PDF click", async () => {
      sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
      await client.waitForRenderIdle();
      checkHeld(await holdLock(client, "hold-editor-lock"), "Edit PDF click");
      const sq = toCanvas({ x: (SQUARE.x0 + SQUARE.x1) / 2, y: (SQUARE.y0 + SQUARE.y1) / 2 });
      await clickAt(canvas, sq.x, sq.y, 0, 0, client);
      const state = /state selected=(\d)/.exec(await markupState(client));
      sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
      return state?.[1] === "1" ? null : `the square is not selected (${state?.[0]})`;
    });

    await step("link click", async () => {
      const link = toCanvas(PAGE_LINK);
      checkHeld(await holdLock(client, elementLock), "link click");
      await clickAt(canvas, link.x, link.y, 0, 0, client);
      const page = (await client.chapterInfo()).page;
      return page === 2 ? null : `on page ${page}, not 2`;
    });
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const failures: string[] = [];
  await check("pdfium", failures);
  await check("mupdf", failures);
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
