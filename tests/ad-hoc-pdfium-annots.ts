// Opt-in PDFium annotation check: a PDFium document lists its annotations, a text selection
// becomes a highlight that is drawn, saved incrementally, kept across the reload, and read
// back by MuPDF. Then a note, square, circle and ink are created, drawn, moved and resized,
// saved, and read back the same way. Build with solok-build.ts, then use --no-build.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, loadPng, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  findCanvas,
  killAndWait,
  launchControlled,
  pressEscape,
  sendCommand,
  sendCommandSync,
} from "./win-automation.ts";
import {
  captureWindowToPng,
  getClientRect,
  MK_LBUTTON,
  packCoords,
  postChar,
  postMessage,
  sendMessage,
  setProcessDpiAware,
  sleep,
  WM_COMMAND,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi.ts";

const VK_END = 0x23;
const kTimeoutMs = 10000;
// yellow highlight pixels expected over the selected line
const kMinYellow = 500;

// a line to highlight, and a blue highlight already in the file
function makePdf(): string {
  const text = "BT /F1 18 Tf 72 700 Td (Mark this line with a PDFium highlight) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Annot /Subtype /Highlight /P 3 0 R /Rect [72 400 300 430] /QuadPoints [72 430 300 430 72 400 300 400] /C [0 0 1] /Contents (existing) >>",
  ]);
}

type Annots = { n: number; quads: number[]; raw: string };

async function annots(client: ControlClient): Promise<Annots> {
  const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
  const n = Number(/^n=(\d+)/m.exec(raw)?.[1] ?? -1);
  const quads = [...raw.matchAll(/type=Highlight page=\d+ quads=(\d+)/g)].map((m) => Number(m[1]));
  return { n, quads, raw };
}

async function waitAnnots(client: ControlClient, want: number, what: string): Promise<Annots> {
  let a = await annots(client);
  for (const deadline = Date.now() + kTimeoutMs; a.n !== want && Date.now() < deadline; await sleep(50)) {
    a = await annots(client);
  }
  if (a.n !== want) throw new Error(`${what}: want ${want} annotations\n${a.raw}`);
  return a;
}

// injected mouse input is dropped on this machine: select the line with the keyboard caret
async function selectFirstLine(client: ControlClient, frame: number): Promise<void> {
  sendCommandSync(frame, cmdId("CmdSelectTextViaKeyboard"));
  const active = async (re: RegExp) => {
    for (const deadline = Date.now() + kTimeoutMs; Date.now() < deadline; await sleep(25)) {
      const dump = String((await client.request(ControlCommand.TestSelectTextKeyboard, []))[1] ?? "");
      if (re.test(dump)) return;
    }
    throw new Error(`keyboard selection: no ${re}`);
  };
  await active(/active=1/);
  await postChar(frame, "v");
  await active(/visual=1/);
  postMessage(frame, WM_KEYDOWN, VK_END, 0);
  postMessage(frame, WM_KEYUP, VK_END, 0);
  await sleep(200);
}

function countPixels(png: string, match: (r: number, g: number, b: number) => boolean): number {
  const img = loadPng(png);
  let n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * img.nComp;
    if (match(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!)) n++;
  }
  return n;
}

function yellowPixels(png: string): number {
  return countPixels(png, (r, g, b) => r > 200 && g > 200 && b < 140);
}

async function launch(dir: string, pdf: string, engine: string) {
  return await launchControlled(["-appdata", dir, "-view", "single page", "-zoom", "fit page", pdf], {
    saveSettings: true,
    env: { SOLOKPDF_ENGINE: engine },
  });
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath("pdfium-annots");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\n");
  const pdf = join(dir, "annots.pdf");
  writeFileSync(pdf, makePdf(), "latin1");

  const s = await launch(dir, pdf, "pdfium");
  try {
    await s.client.setNotificationsEnabled(false);
    await s.client.waitForRenderIdle();
    await waitAnnots(s.client, 1, "existing highlight");

    await selectFirstLine(s.client, s.frame);
    sendCommand(s.frame, cmdId("CmdCreateAnnotHighlight"));
    const created = await waitAnnots(s.client, 2, "new highlight");
    if (!created.quads.every((q) => q > 0)) throw new Error(`highlight without quads\n${created.raw}`);

    await s.client.waitForRenderIdle();
    const png = join(dir, "highlight.png");
    captureWindowToPng(findCanvas(s.frame), png);
    const yellow = yellowPixels(png);
    if (yellow < kMinYellow) throw new Error(`highlight not drawn: ${yellow} yellow pixels, ${png}`);

    sendCommand(s.frame, cmdId("CmdSaveAnnotations"));
    let saved = "";
    for (const deadline = Date.now() + kTimeoutMs; Date.now() < deadline; await sleep(100)) {
      saved = readFileSync(pdf, "latin1");
      if ((saved.match(/\/Highlight/g) ?? []).length >= 2) break;
    }
    if ((saved.match(/\/Highlight/g) ?? []).length < 2) throw new Error("highlight not saved");
    if (!saved.startsWith(makePdf())) throw new Error("save was not an incremental update");
    await s.client.waitForRenderIdle();
    await waitAnnots(s.client, 2, "after save and reload");
    console.log(`PDFium highlight created (${yellow} yellow pixels), saved incrementally and reloaded`);
    await s.client.quit();
  } finally {
    s.client.close();
    await killAndWait(s.proc).catch(() => {});
  }

  const m = await launch(dir, pdf, "mupdf");
  try {
    await m.client.waitForRenderIdle();
    await waitAnnots(m.client, 2, "MuPDF reading the saved file");
    console.log("MuPDF reads both highlights");
    await m.client.quit();
  } finally {
    m.client.close();
    await killAndWait(m.proc).catch(() => {});
  }

  await testShapes(dir);
}

// --- notes, shapes and ink; moving and resizing

type Box = { x: number; y: number; dx: number; dy: number };
type Pt = { x: number; y: number };
// red pixels of the square's and circle's 1pt borders; the default ink is yellow
const kMinRed = 100;
const kNum = "(-?[\\d.e+-]+)";

function blankPdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ]);
}

async function dump(client: ControlClient): Promise<string> {
  return String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
}

function count(raw: string): number {
  return Number(/annotations=(\d+)/.exec(raw)?.[1] ?? -1);
}

// the annotation's page rect and its canvas rect
function shape(raw: string, type: string): { rect: Box; screen: Box } {
  const re = new RegExp(
    `type=${type} page=\\d+ rect=${kNum},${kNum},${kNum},${kNum} screen=${kNum},${kNum},${kNum},${kNum}`,
  );
  const m = re.exec(raw);
  if (!m) throw new Error(`no ${type} annotation\n${raw}`);
  const v = m.slice(1).map(Number);
  return { rect: { x: v[0]!, y: v[1]!, dx: v[2]!, dy: v[3]! }, screen: { x: v[4]!, y: v[5]!, dx: v[6]!, dy: v[7]! } };
}

function inkExtent(raw: string): Box {
  const m = new RegExp(`inkRect=${kNum},${kNum},${kNum},${kNum}`).exec(raw);
  if (!m) throw new Error(`no ink points\n${raw}`);
  return { x: +m[1]!, y: +m[2]!, dx: +m[3]!, dy: +m[4]! };
}

function near(a: Box, b: Box, tolerance: number): boolean {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.dx - b.dx), Math.abs(a.dy - b.dy)) <= tolerance;
}

async function waitFor(client: ControlClient, pred: (raw: string) => boolean, what: string): Promise<string> {
  let raw = await dump(client);
  for (const deadline = Date.now() + kTimeoutMs; !pred(raw) && Date.now() < deadline; await sleep(50)) {
    raw = await dump(client);
  }
  if (!pred(raw)) throw new Error(`${what}\n${raw}`);
  return raw;
}

// window messages, not injected input: a press, moves to each point, a release
async function drag(canvas: number, points: Pt[]): Promise<void> {
  const first = points[0]!;
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(first.x, first.y));
  sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(first.x, first.y));
  await sleep(50);
  for (const p of points.slice(1)) sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(p.x, p.y));
  const last = points[points.length - 1]!;
  sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(last.x, last.y));
  await sleep(150);
}

function center(b: Box): Pt {
  return { x: Math.round(b.x + b.dx / 2), y: Math.round(b.y + b.dy / 2) };
}

// the ink's /Rect hugs its strokes: their extent plus the line width
function checkInkBounds(raw: string, what: string): void {
  const width = Number(/ink strokes=\d+ points=\d+ opacity=\d+ width=(\d+)/.exec(raw)?.[1] ?? -1);
  const pts = inkExtent(raw);
  const want = { x: pts.x - width / 2, y: pts.y - width / 2, dx: pts.dx + width, dy: pts.dy + width };
  const got = shape(raw, "Ink").rect;
  if (width < 0 || !near(got, want, 1)) {
    throw new Error(`${what}: ink bounds ${JSON.stringify(got)}, want ${JSON.stringify(want)}\n${raw}`);
  }
}

async function testShapes(dir: string): Promise<void> {
  const pdf = join(dir, "shapes.pdf");
  writeFileSync(pdf, blankPdf(), "latin1");
  let square: Box;
  let ink: Box;

  const s = await launch(dir, pdf, "pdfium");
  try {
    await s.client.setNotificationsEnabled(false);
    await s.client.waitForRenderIdle();
    const canvas = findCanvas(s.frame);
    const cr = getClientRect(canvas);
    const cx = Math.floor(cr.right / 2);
    const cy = Math.floor(cr.bottom / 2);
    sendCommandSync(s.frame, cmdId("CmdToggleEditPDF"));

    // a command with a canvas point (as from the context menu) creates the default there
    const create = async (cmd: string, x: number, y: number, n: number) => {
      sendMessage(s.frame, WM_COMMAND, cmdId(cmd), packCoords(x, y));
      await waitFor(s.client, (raw) => count(raw) === n, `${cmd} created nothing`);
    };
    await create("CmdCreateAnnotText", cx - 150, cy - 200, 1);
    await create("CmdCreateAnnotSquare", cx - 120, cy - 120, 2);
    await create("CmdCreateAnnotCircle", cx - 120, cy + 120, 3);
    let raw = await dump(s.client);
    const defaultSquare = shape(raw, "Square").rect;
    if (Math.abs(defaultSquare.dx - 100) > 1 || Math.abs(defaultSquare.dy - 50) > 1) {
      throw new Error(`default square is not 100x50: ${JSON.stringify(defaultSquare)}`);
    }

    sendCommandSync(s.frame, cmdId("CmdCreateAnnotInk"));
    await sleep(200);
    const stroke = [
      { x: cx + 20, y: cy + 40 },
      { x: cx + 60, y: cy + 70 },
      { x: cx + 100, y: cy + 40 },
      { x: cx + 140, y: cy + 70 },
    ];
    await drag(canvas, stroke);
    raw = await waitFor(s.client, (r) => count(r) === 4 && /inkRect=/.test(r), "ink stroke was not committed");
    await pressEscape(s.frame);
    checkInkBounds(raw, "new ink");

    await s.client.waitForRenderIdle();
    const png = join(dir, "shapes.png");
    captureWindowToPng(canvas, png);
    const red = countPixels(png, (r, g, b) => r > 180 && g < 90 && b < 90);
    // the highlighter-like ink is a pale, translucent yellow
    const yellow = countPixels(png, (r, g, b) => r > 200 && g > 200 && b < 200);
    if (red < kMinRed || yellow < kMinYellow) throw new Error(`shapes not drawn: ${red} red, ${yellow} yellow, ${png}`);

    // move the square: select it, then drag it
    const sq = shape(raw, "Square");
    const scale = sq.screen.dx / sq.rect.dx;
    const from = center(sq.screen);
    await drag(canvas, [from, from]);
    await drag(canvas, [from, { x: from.x + 20, y: from.y }, { x: from.x + 40, y: from.y + 30 }]);
    raw = await waitFor(s.client, (r) => shape(r, "Square").rect.x > sq.rect.x + 10, "square did not move");
    const moved = shape(raw, "Square");
    const want = { x: sq.rect.x + 40 / scale, y: sq.rect.y + 30 / scale, dx: sq.rect.dx, dy: sq.rect.dy };
    if (!near(moved.rect, want, 2)) {
      throw new Error(`moved square ${JSON.stringify(moved.rect)}, want ${JSON.stringify(want)}`);
    }

    // resize it from the bottom-right handle
    const corner = { x: moved.screen.x + moved.screen.dx, y: moved.screen.y + moved.screen.dy };
    await drag(canvas, [corner, { x: corner.x + 15, y: corner.y + 10 }, { x: corner.x + 30, y: corner.y + 20 }]);
    raw = await waitFor(s.client, (r) => shape(r, "Square").rect.dx > moved.rect.dx + 10, "square did not resize");
    square = shape(raw, "Square").rect;
    if (Math.abs(square.x - moved.rect.x) > 1 || Math.abs(square.dy - (moved.rect.dy + 20 / scale)) > 2) {
      throw new Error(`resized square ${JSON.stringify(square)} from ${JSON.stringify(moved.rect)}`);
    }

    // move the ink: its strokes follow
    const inkBefore = inkExtent(raw);
    const inkAt = stroke[1]!;
    await drag(canvas, [inkAt, inkAt]);
    await drag(canvas, [inkAt, { x: inkAt.x, y: inkAt.y - 20 }, { x: inkAt.x, y: inkAt.y - 40 }]);
    raw = await waitFor(s.client, (r) => inkExtent(r).y < inkBefore.y - 10, "ink did not move");
    checkInkBounds(raw, "moved ink");
    ink = shape(raw, "Ink").rect;
    const inkMoved = inkExtent(raw);
    if (Math.abs(inkMoved.dx - inkBefore.dx) > 0.5 || Math.abs(inkMoved.y - (inkBefore.y - 40 / scale)) > 2) {
      throw new Error(`moved ink ${JSON.stringify(inkMoved)} from ${JSON.stringify(inkBefore)}`);
    }

    sendCommand(s.frame, cmdId("CmdSaveAnnotations"));
    let saved = "";
    for (const deadline = Date.now() + kTimeoutMs; Date.now() < deadline; await sleep(100)) {
      saved = readFileSync(pdf, "latin1");
      if (saved.includes("/Ink")) break;
    }
    for (const type of ["/Text", "/Square", "/Circle", "/Ink"]) {
      if (!saved.includes(type)) throw new Error(`${type} not saved`);
    }
    if (!saved.startsWith(blankPdf())) throw new Error("save was not an incremental update");
    raw = await waitFor(s.client, (r) => count(r) === 4 && /type=Ink/.test(r), "annotations lost on reload");
    if (!near(shape(raw, "Square").rect, square, 0.5)) throw new Error(`square changed on reload\n${raw}`);
    console.log(`PDFium note, square, circle and ink created (${red} red pixels), moved, resized and saved`);
    await s.client.quit();
  } finally {
    s.client.close();
    await killAndWait(s.proc).catch(() => {});
  }

  const m = await launch(dir, pdf, "mupdf");
  try {
    await m.client.waitForRenderIdle();
    const raw = await waitFor(m.client, (r) => count(r) === 4 && /type=Ink/.test(r), "MuPDF reading the shapes");
    const got = { square: shape(raw, "Square").rect, ink: shape(raw, "Ink").rect };
    if (!near(got.square, square, 1.5) || !near(got.ink, ink, 1.5)) {
      throw new Error(`MuPDF reads ${JSON.stringify(got)}, want ${JSON.stringify({ square, ink })}`);
    }
    console.log("MuPDF reads the note, square, circle and ink in place");
    await m.client.quit();
  } finally {
    m.client.close();
    await killAndWait(m.proc).catch(() => {});
  }
}

if (import.meta.main) await runStandalone(testit);
