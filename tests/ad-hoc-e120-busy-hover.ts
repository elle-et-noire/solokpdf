// E120: a hover over a link shows its tip, and over an internal link the
// citation popup, even when a render held the page's lock as the cursor got
// there. The lookup then can't tell, so the hover looks again once the lock is
// free, without another mouse move and without the UI thread waiting.
// E122: the same for the I-beam over text, a form field's cursor, a plain-text
// citation's popup and an annotation's Edit PDF hover.
//
// A test hook holds the lock (PDFium's global lock, or MuPDF's document lock)
// on another thread, as a render does, on both engines.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e120-busy-hover.ts --no-build

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goToPage } from "./ad-hoc-e123-busy-actions.ts";
import { ControlCommand, type ControlClient } from "./control.ts";
import { popupState, waitFor as waitPopup } from "./issue-6252.ts";
import { assemblePdf, cmdId, pollUntil, runStandalone, SETTINGS_FILE, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getClientRect,
  getWindowPid,
  isWindowVisible,
  packCoords,
  sendMessage,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import { findCanvas, killAndWait, launchControlled, moveTestCursor, sendCommandSync } from "./win-automation.ts";

const TIP_CLASS = "tooltips_class32";
const WM_SETCURSOR = 0x0020;
const WM_TIMER = 0x0113;
const REF_HOVER_TIMER = 9; // kRefHoverTimerID
const LINK_DEST_PAGE = 4;
const HTCLIENT = 1;
const HOLD_MS = 800;
// a message the UI thread handles while the lock is held must not wait for it
const MAX_HANDLE_MS = HOLD_MS / 2;
const WAIT_MS = 3000;

type Engine = "pdfium" | "mupdf";

// Leave the internal link's destination outside the initial render range.
function makePdf(): string {
  const text = "BT /F1 10 Tf 72 700 Td (Reference entry) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 9 0 R 10 0 R 4 0 R] /Count 4 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [7 0 R 8 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [0 396 612 792] /Border [0 0 0] /A << /S /URI /URI (https://example.com/e120) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [0 0 612 396] /Border [0 0 0] /Dest [4 0 R /XYZ 72 720 null] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ]);
}

function shownTip(pid: number): number {
  let found = 0;
  enumWindows((h) => {
    if (getWindowPid(h) === pid && getClassName(h) === TIP_CLASS && isWindowVisible(h)) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

// another thread holds the lock the hover's lookup tries, as a render does
async function holdLock(client: ControlClient, engine: Engine): Promise<number> {
  const hook = engine === "pdfium" ? "hold-pdfium-lock" : "hold-editor-lock";
  const res = await client.request(ControlCommand.TestCurrentPdf, [hook, HOLD_MS]);
  if (res[0] !== 0) throw new Error(`${engine}: ${hook}: ${res[1]}`);
  return Date.now();
}

// the cursor arrives at canvas point (x, y): Windows sends WM_SETCURSOR, then WM_MOUSEMOVE
async function hoverAt(client: ControlClient, canvas: number, x: number, y: number, what: string): Promise<void> {
  const s = clientToScreen(canvas, x, y);
  await moveTestCursor(s.x, s.y, client);
  for (const [msg, wp, lp] of [
    [WM_SETCURSOR, canvas, packCoords(HTCLIENT, WM_MOUSEMOVE)],
    [WM_MOUSEMOVE, 0, packCoords(x, y)],
  ] as const) {
    const t = Date.now();
    sendMessage(canvas, msg, wp, lp);
    const ms = Date.now() - t;
    if (ms > MAX_HANDLE_MS)
      throw new Error(`${what}: the UI thread waited ${ms} ms for the lock (message 0x${msg.toString(16)})`);
  }
}

async function check(engine: Engine): Promise<void> {
  const dir = tmpPath(`ad-hoc-e120-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nCitationHoverDelay = 300\n");
  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-view", "single page", "-zoom", "fit page", pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } as Record<string, string> },
  );
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const cr = getClientRect(canvas);
    const x = Math.floor(cr.right / 2);

    // the web link's tip
    let start = await holdLock(client, engine);
    await hoverAt(client, canvas, x, Math.floor(cr.bottom / 3), `${engine} link tip`);
    if (Date.now() - start >= HOLD_MS) throw new Error(`${engine} link tip: the lock was released too early`);
    if (shownTip(proc.pid!)) throw new Error(`${engine} link tip: shown while the lock was held`);
    await pollUntil(
      () => shownTip(proc.pid!),
      (h) => h !== 0,
      { timeoutMs: WAIT_MS, error: () => `${engine} link tip: not shown after the lock was released` },
    );
    console.log(`${engine}: link tip OK`);

    // Look up the link before taking the lock. Fire the show timer while the
    // destination's first text extraction would block on that lock.
    const citationY = Math.floor((cr.bottom * 3) / 4);
    await hoverAt(client, canvas, x, citationY, `${engine} citation timer`);
    start = await holdLock(client, engine);
    const beforeTimer = performance.now();
    sendMessage(canvas, WM_TIMER, REF_HOVER_TIMER, 0);
    const timerMs = performance.now() - beforeTimer;
    if (timerMs > MAX_HANDLE_MS) throw new Error(`${engine}: citation timer waited ${timerMs.toFixed(0)} ms`);
    checkHeld(start, `${engine} citation timer`);
    if ((await popupState(client)).visible) throw new Error(`${engine}: popup shown before extraction`);
    await waitPopup(client, `${engine}: popup missing after timer retry`, (p) => p.visible);
    if (engine === "pdfium" && (await testQuery(client, ["editor"])) !== "editor=none") {
      throw new Error("citation timer loaded the editor");
    }
    console.log(`${engine}: cold citation timer returned in ${timerMs.toFixed(1)} ms`);
    await hoverAt(client, canvas, 1, 1, `${engine} move away from citation`);
    await waitPopup(client, `${engine}: popup stayed after moving away`, (p) => !p.visible);

    // the internal link's citation popup
    start = await holdLock(client, engine);
    await hoverAt(client, canvas, x, citationY, `${engine} citation`);
    if (Date.now() - start >= HOLD_MS) throw new Error(`${engine} citation: the lock was released too early`);
    if ((await popupState(client)).visible) throw new Error(`${engine} citation: shown while the lock was held`);
    await waitPopup(client, `${engine} citation: not shown after the lock was released`, (p) => p.visible);
    console.log(`${engine}: citation popup OK`);

    for (const command of ["CmdNewTab", "CmdClose"]) {
      await hoverAt(client, canvas, 1, 1, `${engine} ${command}: move away`);
      await waitPopup(client, `${engine} ${command}: previous popup stayed visible`, (p) => !p.visible);
      await testQuery(client, ["reset-cached-text", LINK_DEST_PAGE]);
      await hoverAt(client, canvas, x, citationY, `${engine} ${command}: schedule citation`);
      const heldAt = await holdLock(client, engine);
      sendMessage(canvas, WM_TIMER, REF_HOVER_TIMER, 0);
      checkHeld(heldAt, `${engine} ${command}: extraction pending`);
      sendCommandSync(frame, cmdId(command));
      const watchUntil = Date.now() + HOLD_MS;
      while (Date.now() < watchUntil) {
        if ((await popupState(client)).visible) throw new Error(`${engine} ${command}: stale citation popup`);
        await Bun.sleep(25);
      }
      if (command === "CmdNewTab") sendCommandSync(frame, cmdId("CmdPrevTab"));
    }
    console.log(`${engine}: pending citation stayed hidden after tab switch and document close`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// E122 fixture. Page 1, in PDF points: a plain-text citation "[7]", lines of
// text, a square annotation with a comment and a text field. The reference
// "[7]" is on page 2 and the pages after it are dense text: the lookup walks
// from the last page back, so finding it means extracting all of them.
const FILLER = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";
const DENSE = `${FILLER} et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi`;
const PAGES = 50;
const REFERENCE_PAGE = 2;
const COLD_TEXT_PAGE = 3;
const DENSE_TOP = 780;
const PAGE_H = 792;
const CITE = { x: 103, y: 700 };
const TEXT = { x: 80, y: 640 };
const SQUARE = { x0: 72, y0: 250, x1: 280, y1: 350 };
const FIELD = { x0: 330, y0: 250, x1: 540, y1: 300 };
const EMPTY = { x: 450, y: 120 };
// the plain-text citation reads every page's text: allow for extracting them all
const CITE_WAIT_MS = 20_000 * SLOW_BUILD_FACTOR;

function lines(top: number, n: number, size = 11, text = FILLER, x = 72): string {
  return `BT /F1 ${size} Tf ${size + 1} TL ${x} ${top} Td (${text}) Tj ${`(${text}) ' `.repeat(n - 1)}ET`;
}

function stream(content: string): string {
  return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

function makeE122Pdf(): string {
  const page = (contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${PAGE_H}] /Resources << /Font << /F1 4 0 R >> >> /Contents ${contents} 0 R >>`;
  const first = 10;
  const kids = ["3 0 R", `${first} 0 R`];
  const pages = [page(7)];
  for (let i = 2; i < PAGES; i++) {
    kids.push(`${first + i - 1} 0 R`);
    pages.push(page(6));
  }
  const page1 = `BT /F1 12 Tf 72 ${CITE.y} Td (See [7] for details.) Tj ET ${lines(TEXT.y, 20)}`;
  const ref = `BT /F1 12 Tf 72 700 Td ([7] Author A. A title. 2020.) Tj ET ${lines(TEXT.y, 40)}`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [9 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >> >>",
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${PAGES} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${PAGE_H}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [8 0 R 9 0 R] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(page1),
    stream(lines(DENSE_TOP, 125, 5, DENSE, 20)),
    stream(ref),
    `<< /Type /Annot /Subtype /Square /Rect [${SQUARE.x0} ${SQUARE.y0} ${SQUARE.x1} ${SQUARE.y1}] /C [0 0 1] /Contents (E122 note) >>`,
    `<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g) /FT /Tx /T (name) /Rect [${FIELD.x0} ${FIELD.y0} ${FIELD.x1} ${FIELD.y1}] >>`,
    ...pages,
  ]);
}

async function testQuery(client: ControlClient, args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(`${args.join(" ")}: ${String(res[1])}`);
  return String(res[1]);
}

async function cursorShape(client: ControlClient): Promise<string> {
  return /cursor=(\w+)/.exec(await testQuery(client, ["cursor-shape"]))?.[1] ?? "";
}

// canvas point of point (x, y) on a page, PDF points with y up
async function toCanvas(client: ControlClient, x: number, y: number, pageNo = 1): Promise<{ x: number; y: number }> {
  const m = /pt=(-?\d+),(-?\d+)/.exec(await testQuery(client, ["widget-cursor", pageNo, x, PAGE_H - y]));
  if (!m) throw new Error("widget-cursor: no point");
  return { x: +m[1]!, y: +m[2]! };
}

async function waitCursor(client: ControlClient, want: string, what: string): Promise<void> {
  await pollUntil(
    () => cursorShape(client),
    (c) => c === want,
    { timeoutMs: WAIT_MS, error: (c) => `${what}: cursor ${c}, not ${want}, with no further input` },
  );
}

function checkHeld(start: number, what: string): void {
  if (Date.now() - start >= HOLD_MS) throw new Error(`${what}: the lock was released too early`);
}

async function checkE122(engine: Engine, failures: string[]): Promise<void> {
  const dir = tmpPath(`ad-hoc-e122-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makeE122Pdf(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nCitationHoverDelay = 100\n");
  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-view", "single page", "-zoom", "fit page", pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } as Record<string, string> },
  );
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const text = await toCanvas(client, TEXT.x, TEXT.y + 4);
    const field = await toCanvas(client, (FIELD.x0 + FIELD.x1) / 2, (FIELD.y0 + FIELD.y1) / 2);
    const cite = await toCanvas(client, CITE.x, CITE.y + 4);
    const square = await toCanvas(client, (SQUARE.x0 + SQUARE.x1) / 2, (SQUARE.y0 + SQUARE.y1) / 2);
    const empty = await toCanvas(client, EMPTY.x, EMPTY.y);

    const step = async (what: string, run: () => Promise<void>) => {
      await client.waitForRenderIdle();
      try {
        await run();
        console.log(`${engine} ${what}: OK`);
      } catch (e) {
        failures.push(`${engine} ${what}: ${(e as Error).message}`);
        console.log(`${engine} ${what}: FAILED`);
      }
    };
    // an arrow first, so the expected cursor can't be left over from a step before
    const arrowAt = async (what: string) => {
      await hoverAt(client, canvas, empty.x, empty.y, what);
      await waitCursor(client, "arrow", `${what}: away from text`);
    };

    // the page's text isn't extracted yet: extraction waits for the lock too
    await step("I-beam while locked", async () => {
      const start = await holdLock(client, engine);
      await hoverAt(client, canvas, text.x, text.y, "I-beam while locked");
      checkHeld(start, "I-beam while locked");
      await waitCursor(client, "ibeam", "I-beam while locked");
    });

    // the first hover over a page whose text isn't extracted yet
    await step("I-beam before extraction", async () => {
      await arrowAt("I-beam before extraction");
      await goToPage(client, COLD_TEXT_PAGE);
      // a render of a page next to it would make the hover busy and look again anyway
      await pollUntil(
        () => client.waitForRenderIdle(),
        (info) => /\bq=0\b/.test(info) && !/ t\d+=/.test(info),
        { timeoutMs: WAIT_MS, error: (info) => `renders don't stop: ${info}` },
      );
      try {
        const pt = await toCanvas(client, 24, DENSE_TOP + 2, COLD_TEXT_PAGE);
        await hoverAt(client, canvas, pt.x, pt.y, "I-beam before extraction");
        await waitCursor(client, "ibeam", "I-beam before extraction");
      } finally {
        await goToPage(client, 1);
      }
    });

    await step("form field cursor", async () => {
      await arrowAt("form field cursor");
      const start = await holdLock(client, engine);
      await hoverAt(client, canvas, field.x, field.y, "form field cursor");
      const q = await testQuery(client, [
        "widget-cursor",
        1,
        (FIELD.x0 + FIELD.x1) / 2,
        PAGE_H - (FIELD.y0 + FIELD.y1) / 2,
      ]);
      checkHeld(start, "form field cursor");
      if (!q.startsWith("cursor=busy ")) throw new Error(`the field's lookup answered ${q} while the lock was held`);
      await waitCursor(client, "ibeam", "form field cursor");
    });

    await step("plain-text citation", async () => {
      const referenceReady = async () => (await testQuery(client, ["has-cached-text", REFERENCE_PAGE])) === "ready=1";
      if (await referenceReady()) throw new Error("reference text was already cached");
      const start = await holdLock(client, engine);
      await hoverAt(client, canvas, cite.x, cite.y, "plain-text citation");
      checkHeld(start, "plain-text citation");
      if ((await popupState(client)).visible) throw new Error("shown while the lock was held");
      // the popup comes once the pages' text is read; the UI thread never waits for it
      let maxMs = 0;
      let readyAt = 0;
      await pollUntil(
        async () => {
          const t = Date.now();
          sendMessage(canvas, 0, 0, 0);
          maxMs = Math.max(maxMs, Date.now() - t);
          if (maxMs > MAX_HANDLE_MS) throw new Error(`the UI thread was busy for ${maxMs} ms`);
          if (!readyAt && (await referenceReady())) readyAt = Date.now();
          return (await popupState(client)).visible;
        },
        (v) => v,
        {
          timeoutMs: CITE_WAIT_MS,
          intervalMs: 25,
          error: () => `popup missing after ${CITE_WAIT_MS} ms (reference text ${readyAt ? "cached" : "pending"})`,
        },
      );
      if (!readyAt) throw new Error("popup was shown before the reference text was cached");
      console.log(
        `${engine} plain-text citation: ${Date.now() - readyAt} ms after text was cached, UI busy ${maxMs} ms at most`,
      );
      if (engine === "pdfium") {
        const editor = await testQuery(client, ["editor"]);
        if (editor !== "editor=none") throw new Error(`hover loaded the MuPDF editor (${editor})`);
      }
    });

    // Edit PDF loads the editor: the annotation's lookup is the editor's
    await step("Edit PDF annotation hover", async () => {
      sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
      await client.waitForRenderIdle();
      await arrowAt("Edit PDF annotation hover");
      const start = await holdLock(client, "mupdf");
      await hoverAt(client, canvas, square.x, square.y, "Edit PDF annotation hover");
      checkHeld(start, "Edit PDF annotation hover");
      await pollUntil(
        async () => String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? ""),
        (raw) => /state selected=\d hover=1/.test(raw),
        { timeoutMs: WAIT_MS, error: "the annotation got no hover with no further input" },
      );
      await waitCursor(client, "hand", "Edit PDF annotation hover");
    });
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  await check("pdfium");
  await check("mupdf");
  const failures: string[] = [];
  await checkE122("pdfium", failures);
  await checkE122("mupdf", failures);
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
