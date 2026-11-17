// E120: a hover over a link shows its tip, and over an internal link the
// citation popup, even when a render held the page's lock as the cursor got
// there. The lookup then can't tell, so the hover looks again once the lock is
// free, without another mouse move and without the UI thread waiting.
//
// A test hook holds the lock (PDFium's global lock, or MuPDF's document lock)
// on another thread, as a render does, on both engines.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e120-busy-hover.ts --no-build

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { popupState, waitFor as waitPopup } from "./issue-6252.ts";
import { assemblePdf, pollUntil, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
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
import { findCanvas, killAndWait, launchControlled, moveTestCursor } from "./win-automation.ts";

const TIP_CLASS = "tooltips_class32";
const WM_SETCURSOR = 0x0020;
const HTCLIENT = 1;
const HOLD_MS = 800;
// a message the UI thread handles while the lock is held must not wait for it
const MAX_HANDLE_MS = HOLD_MS / 2;
const WAIT_MS = 3000;

type Engine = "pdfium" | "mupdf";

// page 1: a web link over the top half, a link to page 2 over the bottom half
function makePdf(): string {
  const text = "BT /F1 10 Tf 72 700 Td (Reference entry) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [7 0 R 8 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [0 396 612 792] /Border [0 0 0] /A << /S /URI /URI (https://example.com/e120) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [0 0 612 396] /Border [0 0 0] /Dest [4 0 R /XYZ 72 720 null] >>",
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
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nCitationHoverDelay = 100\n");
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

    // the internal link's citation popup
    start = await holdLock(client, engine);
    await hoverAt(client, canvas, x, Math.floor((cr.bottom * 3) / 4), `${engine} citation`);
    if (Date.now() - start >= HOLD_MS) throw new Error(`${engine} citation: the lock was released too early`);
    if ((await popupState(client)).visible) throw new Error(`${engine} citation: shown while the lock was held`);
    await waitPopup(client, `${engine} citation: not shown after the lock was released`, (p) => p.visible);
    console.log(`${engine}: citation popup OK`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  await check("pdfium");
  await check("mupdf");
}

if (import.meta.main) await runStandalone(testit);
