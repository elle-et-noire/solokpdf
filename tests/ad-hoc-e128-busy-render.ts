// E128: a user action during a real render waits only until the render's next
// cancellation check, and every tile canceled for it renders again with no input.
//
// A test hook parks a real render of the page at its cancellation check, still
// holding its locks (PDFium's process-wide lock, MuPDF's renderLock, or the
// editor's locks while it draws annotations over a PDFium tile). The park lasts
// PARK_MS unless the render is canceled, so an action that doesn't cancel it
// waits that long and the park reports "expired".
//
// Also: a press on a PDFium page whose text needs the unloaded editor, with no
// render running, doesn't cancel renders it doesn't wait for.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e128-busy-render.ts --no-build

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import {
  ALPHA,
  menuText,
  DRAG_PAGE,
  type Engine,
  goToPage,
  makeFormPdf,
  makePdf,
  PAGE_LINK,
  pagePoint,
  pageToCanvas,
  type Pt,
  SELECT,
  selectedText,
  THESE,
  WEB_LINK,
  WORD_PAGE,
} from "./ad-hoc-e123-busy-actions.ts";
import { assemblePdf, cmdId, pollUntil, runStandalone, SETTINGS_FILE, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";
import {
  clientToScreen,
  getControlText,
  getPopupMenuHandle,
  MK_LBUTTON,
  packCoords,
  postMessage,
  readMenuTree,
  sendMessage,
  setProcessDpiAware,
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
  killAndWait,
  launchControlled,
  moveTestCursor,
  openContextMenu,
  sendCommandSync,
  waitForContextMenu,
} from "./win-automation.ts";

// a parked render that isn't canceled holds the page this long
const PARK_MS = 30000 * SLOW_BUILD_FACTOR;
// an action that cancels it is done long before: the park checks every millisecond
const BOUND_MS = 5000 * SLOW_BUILD_FACTOR;
const WAIT_MS = 10000 * SLOW_BUILD_FACTOR;

type Stage = "contents" | "annotations";

// page 1: no link, image, annotation or text
const EMPTY = { x: 300, y: 100 };

async function testPdf(client: ControlClient, args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(`${args[0]}: ${res[1]}`);
  return String(res[1] ?? "");
}

function field(state: string, name: string): number {
  const m = new RegExp(`\\b${name}=(-?\\d+)`).exec(state);
  if (!m) throw new Error(`no ${name} in ${state}`);
  return Number(m[1]);
}

// renders the current page again and waits until the render is parked holding its locks
async function parkRender(client: ControlClient, stage: Stage = "contents", window = 0): Promise<void> {
  await testPdf(client, ["park-render", PARK_MS, stage, window]);
  await pollUntil(
    () => testPdf(client, ["park-state"]),
    (s) => field(s, "parked") === 1,
    { timeoutMs: WAIT_MS, error: `no render parked at ${stage}` },
  );
}

// the action took less than the bound, canceled the parked render, and the tiles of the
// window it rendered for then render again with no input (park-state doesn't paint)
async function checkCanceled(client: ControlClient, elapsed: number, window = 0): Promise<string | null> {
  const state = await testPdf(client, ["park-state"]);
  console.log(`  action took ${elapsed} ms`);
  if (elapsed >= BOUND_MS) return `took ${elapsed} ms (${state})`;
  if (field(state, "canceled") !== 1) return `the render wasn't canceled (${state})`;
  try {
    await pollUntil(
      () => testPdf(client, ["park-state", window]),
      (s) => field(s, "tiles") === 1,
      { timeoutMs: WAIT_MS, error: "the canceled tiles didn't render again" },
    );
  } catch (e) {
    return `${(e as Error).message} (${await testPdf(client, ["park-state", window])})`;
  }
  return null;
}

async function launch(engine: Engine, name: string, files: { file: string; pdf: string }[]) {
  const dir = tmpPath(`ad-hoc-e128-${name}-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const paths = files.map(({ file, pdf }) => {
    const path = join(dir, file);
    writeFileSync(path, pdf, "latin1");
    return path;
  });
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\n");
  const app = await launchControlled(["-appdata", dir, "-view", "single page", "-zoom", "fit page", ...paths], {
    env: { ...process.env, SOLOKPDF_ENGINE: engine } as Record<string, string>,
  });
  return { ...app, dir };
}

function report(failures: string[], what: string, err: string | null): void {
  if (err) failures.push(`${what}: ${err}`);
  console.log(`${what}: ${err ? `FAILED ${err}` : "OK"}`);
}

async function checkActions(engine: Engine, failures: string[]): Promise<void> {
  const { proc, client, frame } = await launch(engine, "actions", [{ file: "doc.pdf", pdf: makePdf() }]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const toCanvas = await pageToCanvas(client);
    const step = async (what: string, run: () => Promise<string | null>) => {
      await client.waitForRenderIdle();
      report(failures, `${engine} ${what}`, await run());
    };
    const moveTo = async (pt: Pt) => {
      const s = clientToScreen(canvas, pt.x, pt.y);
      await moveTestCursor(s.x, s.y, client);
    };

    await step("link menu", async () => {
      const at = toCanvas(WEB_LINK);
      const s = clientToScreen(canvas, at.x, at.y);
      await moveTo(at);
      await parkRender(client);
      const start = Date.now();
      openContextMenu(canvas, s.x, s.y);
      const popup = await waitForContextMenu(WAIT_MS);
      const elapsed = Date.now() - start;
      const hmenu = popup ? getPopupMenuHandle(popup) : 0;
      const items = hmenu ? readMenuTree(hmenu) : [];
      if (popup) postMessage(popup, WM_KEYDOWN, VK_ESCAPE, 0);
      if (!items.some((it) => it.text === "Copy Link Address")) return `no Copy Link Address in ${menuText(items)}`;
      return checkCanceled(client, elapsed);
    });

    // nothing there: only the action's own repaint renders the canceled tiles again
    await step("empty click", async () => {
      const at = toCanvas(EMPTY);
      await moveTo(at);
      await parkRender(client);
      const start = Date.now();
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(at.x, at.y));
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(at.x, at.y));
      return checkCanceled(client, Date.now() - start);
    });

    await step("link click", async () => {
      const link = toCanvas(PAGE_LINK);
      await moveTo(link);
      await parkRender(client);
      const start = Date.now();
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(link.x, link.y));
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(link.x, link.y));
      const elapsed = Date.now() - start;
      const page = (await client.chapterInfo()).page;
      if (page !== 2) return `on page ${page}, not 2`;
      return checkCanceled(client, elapsed);
    });

    // the press reads text no lookup has read yet: the render holds the page before the
    // pointer gets there
    await step("text press-drag", async () => {
      await goToPage(client, DRAG_PAGE);
      const from = toCanvas(SELECT);
      const to = toCanvas(THESE);
      await parkRender(client);
      await moveTo(from);
      const start = Date.now();
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(from.x, from.y));
      const elapsed = Date.now() - start;
      sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(to.x, to.y));
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(to.x, to.y));
      const text = await selectedText(client);
      if (!text.startsWith("Select th")) return `selected '${text}'`;
      return checkCanceled(client, elapsed);
    });

    await step("text double-click", async () => {
      await goToPage(client, WORD_PAGE);
      const at = toCanvas(THESE);
      await parkRender(client);
      await moveTo(at);
      const start = Date.now();
      sendMessage(canvas, WM_LBUTTONDBLCLK, MK_LBUTTON, packCoords(at.x, at.y));
      const elapsed = Date.now() - start;
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(at.x, at.y));
      const text = await selectedText(client);
      if (text !== "these") return `selected '${text}'`;
      return checkCanceled(client, elapsed);
    });
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// Tab moves the edit to the next field while the field commit's re-render holds the
// next-field lookup's locks: MuPDF's renderLock, or on PDFium the editor's, drawing the
// annotations over PDFium's tile
async function checkFormTab(engine: Engine, failures: string[]): Promise<void> {
  const { proc, client, frame } = await launch(engine, "form", [{ file: "form.pdf", pdf: makeFormPdf() }]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const alpha = await pagePoint(client, ALPHA);
    await client.waitForRenderIdle();
    await clickAt(canvas, alpha.x, alpha.y, 0, 0, client);
    const edit = findFormEditor(canvas);
    if (!edit || getControlText(edit) !== "alpha") {
      report(failures, `${engine} form click`, `editor=${edit}`);
      return;
    }
    await client.waitForRenderIdle();

    await parkRender(client, engine === "pdfium" ? "annotations" : "contents");
    const start = Date.now();
    sendMessage(edit, WM_KEYDOWN, VK_TAB, 0);
    const elapsed = Date.now() - start;
    const next = findFormEditor(canvas);
    const second = next ? getControlText(next) : "";
    let err = second === "beta" ? null : `editing '${second}' (editor=${next})`;
    err ??= await checkCanceled(client, elapsed);
    report(failures, `${engine} form Tab`, err);
    if (next) sendMessage(next, WM_KEYDOWN, VK_ESCAPE, 0);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// PDFium's lock is process-wide: a click in one window cancels the render of a document in
// another window that holds it, and that window renders its tiles again (a background tab
// renders nothing: switching tabs cancels its renders)
async function checkOtherWindow(failures: string[]): Promise<void> {
  const what = "pdfium other window's render";
  const { proc, client, frame } = await launch("pdfium", "other-window", [{ file: "a.pdf", pdf: makePdf() }]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    sendCommandSync(frame, cmdId("CmdDuplicateInNewWindow"));
    await pollUntil(
      () => testPdf(client, ["park-state", 1]).catch(() => ""),
      (s) => s !== "" && field(s, "tiles") === 1,
      { timeoutMs: WAIT_MS, error: "the second window didn't render" },
    );

    const link = (await pageToCanvas(client))(PAGE_LINK);
    const screen = clientToScreen(canvas, link.x, link.y);
    await moveTestCursor(screen.x, screen.y, client);
    await parkRender(client, "contents", 1);
    const start = Date.now();
    sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(link.x, link.y));
    // An unrelated Windows mouse move during the click must leave the link pressed.
    postMessage(canvas, WM_MOUSEMOVE, 0, packCoords(0, 0));
    const state = await testPdf(client, ["park-state", 1]);
    sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(link.x, link.y));
    const elapsed = Date.now() - start;
    const page = (await client.chapterInfo()).page;
    let err = page === 2 ? null : `on page ${page}, not 2 (${state})`;
    err ??= await checkCanceled(client, elapsed, 1);
    report(failures, what, err);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// a page whose text MuPDF must supply: Type3 glyphs of character code 0, which PDFium gives no Unicode
function makeNeedsEditorPdf(): string {
  const text = "BT /F1 36 Tf 72 400 Td (Select these words) Tj ET BT /F2 36 Tf 72 300 Td (\\000\\000) Tj ET";
  const glyph = "1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] " +
      "/CharProcs << /g1 6 0 R >> /Encoding << /Type /Encoding /Differences [0 /g1] >> " +
      "/FirstChar 0 /LastChar 0 /Widths [1000] /Resources << >> >>",
    `<< /Length ${glyph.length} >>\nstream\n${glyph}\nendstream`,
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ]);
}

// with no render running, a press on such a page doesn't cancel renders: PDFium's partial
// text answers it, as a prefetch would (the selection then reads the full text)
async function checkNeedsEditorText(failures: string[]): Promise<void> {
  const { proc, client, frame } = await launch("pdfium", "needs-editor", [
    { file: "n.pdf", pdf: makeNeedsEditorPdf() },
  ]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const from = await pagePoint(client, SELECT);
    const to = await pagePoint(client, THESE);
    await client.waitForRenderIdle();
    // Try reads don't store text
    const read = await testPdf(client, ["try-text", 1]);
    const before = await testPdf(client, ["park-state"]);
    if (field(read, "use-editor") !== 1 || field(before, "text") !== 0) {
      report(
        failures,
        "pdfium needs-editor press",
        `not a page of unread text only the editor has (${read}, ${before})`,
      );
      return;
    }
    sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(from.x, from.y));
    const state = await testPdf(client, ["park-state"]);
    sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(to.x, to.y));
    sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(to.x, to.y));
    const text = await selectedText(client);
    let err: string | null = null;
    if (!text.startsWith("Select th")) err = `selected '${text}'`;
    else if (field(state, "frees") !== 0) err = `the press canceled renders (${state})`;
    report(failures, "pdfium needs-editor press", err);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const failures: string[] = [];
  for (const engine of ["pdfium", "mupdf"] as Engine[]) {
    await checkActions(engine, failures);
    await checkFormTab(engine, failures);
  }
  await checkOtherWindow(failures);
  await checkNeedsEditorText(failures);
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
