// Opt-in PDFium annotation check: a PDFium document lists its annotations, a text selection
// becomes a highlight that is drawn, saved incrementally, kept across the reload, and read
// back by MuPDF. Build with solok-build.ts, then use --no-build.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, loadPng, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, sendCommand, sendCommandSync } from "./win-automation.ts";
import {
  captureWindowToPng,
  postChar,
  postMessage,
  setProcessDpiAware,
  sleep,
  WM_KEYDOWN,
  WM_KEYUP,
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

function yellowPixels(png: string): number {
  const img = loadPng(png);
  let n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * img.nComp;
    if (img.data[o]! > 200 && img.data[o + 1]! > 200 && img.data[o + 2]! < 140) n++;
  }
  return n;
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
}

if (import.meta.main) await runStandalone(testit);
