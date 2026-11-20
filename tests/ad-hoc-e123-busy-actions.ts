// E123: a user action while a render holds the page's lock finds what is under
// the pointer as it would with no render running: the context menu has the
// link's and the image's items, a press on an image starts its drag, an Edit
// PDF click selects the annotation and a click on a link follows it.
// E127: a press-drag on text selects it, a double-click selects the word, a
// click on a form field edits it and Tab moves the edit to the next field.
//
// Test hooks hold the lock (PDFium's global lock, or MuPDF's document or render
// lock) on another thread, as a render does, on both engines.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e123-busy-actions.ts --no-build

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { APP_NAME, assemblePdf, cmdId, pollUntil, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  clientToScreen,
  getControlText,
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
  VK_TAB,
  WM_KEYDOWN,
  WM_LBUTTONDBLCLK,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import {
  clickAt,
  findCanvas,
  findFormEditor,
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

export type Engine = "pdfium" | "mupdf";
export type Pt = { x: number; y: number };

// page 1, in PDF points: a web link and a link to page 2 side by side at the
// top, an image and a square annotation side by side below them
export const SQUARE = { x0: 330, y0: 340, x1: 556, y1: 560 };
export const WEB_LINK = { x: 150, y: 700 };
export const PAGE_LINK = { x: 460, y: 700 };
const IMAGE = { x: 173, y: 450 };
// pages 3 and 4: "Select these words" in 36pt Helvetica, baseline at y=400; each
// text step uses a page whose text no lookup has read yet
const TEXT = "BT /F1 36 Tf 72 400 Td (Select these words) Tj ET";
export const DRAG_PAGE = 3;
export const WORD_PAGE = 4;
export const SELECT = { x: 80, y: 410 };
export const THESE = { x: 225, y: 410 };
// a form page: two text fields, "alpha" above "beta"
export const ALPHA = { x: 300, y: 530 };

export function makePdf(): string {
  const content = "q 234 0 0 220 56 340 cm /Im0 Do Q";
  const hex = "ff0000".repeat(4);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 10 0 R 11 0 R] /Count 4 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 6 0 R >> >> " +
      "/Contents 5 0 R /Annots [7 0 R 8 0 R 9 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${hex.length + 1} >>\nstream\n${hex}>\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [0 600 306 792] /Border [0 0 0] /A << /S /URI /URI (https://example.com/e123) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [306 600 612 792] /Border [0 0 0] /Dest [4 0 R /XYZ 0 792 null] >>",
    `<< /Type /Annot /Subtype /Square /Rect [${SQUARE.x0} ${SQUARE.y0} ${SQUARE.x1} ${SQUARE.y1}] /C [0 0 1] >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 12 0 R >> >> /Contents 13 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 12 0 R >> >> /Contents 13 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${TEXT.length} >>\nstream\n${TEXT}\nendstream`,
  ]);
}

export function makeFormPdf(): string {
  const field = (name: string, y0: number, value: string) =>
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${name}) /V (${value}) /Rect [100 ${y0} 500 ${y0 + 60}] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] /DR << /Font << /Helv 6 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R] >>",
    field("first", ALPHA.y - 30, "alpha"),
    field("second", 300, "beta"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

async function markupState(client: ControlClient): Promise<string> {
  return String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
}

// canvas point of page-1 point p, from where the square is on screen
export async function pageToCanvas(client: ControlClient): Promise<(p: Pt) => Pt> {
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

export function menuText(items: MenuItem[]): string {
  return items.map((it) => it.text).join(", ");
}

export async function selectedText(client: ControlClient): Promise<string> {
  const res = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
  return /^expanded=(.*)$/m.exec(res)?.[1] ?? "";
}

export async function goToPage(client: ControlClient, page: number): Promise<void> {
  const { chapter } = await client.chapterInfo();
  const at = await client.goToLocation(chapter, page);
  if (at.page !== page) throw new Error(`on page ${at.page}, not ${page}`);
  await client.waitForRenderIdle();
}

// canvas point of page-1 point p, as the app maps it
export async function pagePoint(client: ControlClient, p: Pt, page = 1): Promise<Pt> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["widget-cursor", page, p.x, 792 - p.y]);
  const m = /pt=(-?\d+),(-?\d+)/.exec(String(res[1] ?? ""));
  if (!m) throw new Error(`no canvas point: ${res[1]}`);
  return { x: +m[1]!, y: +m[2]! };
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
      if (APP_NAME === "SolokPDF") {
        return items[0]?.text === "Copy Image" && items[1]?.text === "Save Image..."
          ? null
          : `no direct image copy and save in ${menuText(items)}`;
      }
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

    await step("text press-drag", async () => {
      await goToPage(client, DRAG_PAGE);
      const from = toCanvas(SELECT);
      const to = toCanvas(THESE);
      const s = clientToScreen(canvas, from.x, from.y);
      await moveTestCursor(s.x, s.y, client);
      checkHeld(await holdLock(client, elementLock), "text press-drag");
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(from.x, from.y));
      sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(to.x, to.y));
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(to.x, to.y));
      const text = await selectedText(client);
      return text.startsWith("Select th") ? null : `selected '${text}'`;
    });

    await step("text double-click", async () => {
      await goToPage(client, WORD_PAGE);
      const at = toCanvas(THESE);
      const s = clientToScreen(canvas, at.x, at.y);
      await moveTestCursor(s.x, s.y, client);
      checkHeld(await holdLock(client, elementLock), "text double-click");
      sendMessage(canvas, WM_LBUTTONDBLCLK, MK_LBUTTON, packCoords(at.x, at.y));
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(at.x, at.y));
      const text = await selectedText(client);
      return text === "these" ? null : `selected '${text}'`;
    });
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// a click on a form field edits it; Tab moves the edit to the next field
async function checkForm(engine: Engine, failures: string[]): Promise<void> {
  const dir = tmpPath(`ad-hoc-e127-form-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "form.pdf");
  writeFileSync(pdf, makeFormPdf(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\n");
  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-view", "single page", "-zoom", "fit page", pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } as Record<string, string> },
  );
  const fieldLock = engine === "pdfium" ? "hold-pdfium-lock" : "hold-editor-lock";
  const step = (what: string, err: string | null) => {
    if (err) failures.push(`${engine} ${what}: ${err}`);
    console.log(`${engine} ${what}: ${err ? "FAILED" : "OK"}`);
  };
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const alpha = await pagePoint(client, ALPHA);
    await client.waitForRenderIdle();

    checkHeld(await holdLock(client, fieldLock), "form click");
    await clickAt(canvas, alpha.x, alpha.y, 0, 0, client);
    const edit = findFormEditor(canvas);
    const first = edit ? getControlText(edit) : "";
    step("form click", first === "alpha" ? null : `editing '${first}' (editor=${edit})`);
    if (!edit) return;

    // the commit's re-render holds the editor's render lock as Tab looks for the next field
    await client.waitForRenderIdle();
    checkHeld(await holdLock(client, "hold-render-lock"), "form Tab");
    sendMessage(edit, WM_KEYDOWN, VK_TAB, 0);
    const next = findFormEditor(canvas);
    const second = next ? getControlText(next) : "";
    step("form Tab", second === "beta" ? null : `editing '${second}' (editor=${next})`);
    if (next) sendMessage(next, WM_KEYDOWN, VK_ESCAPE, 0);
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
  await checkForm("pdfium", failures);
  await checkForm("mupdf", failures);
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
