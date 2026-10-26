// Opt-in PDFium check: at fractional zooms a page's tiles must line up, so 45-degree
// lines continue across tile edges, as with MuPDF. Build with solok-build.ts, then use --no-build.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, loadPng, runStandalone, tmpPath, type PngImage } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng, setProcessDpiAware } from "./winapi.ts";

// fractional, and high enough that a letter page is split into tiles
const kZooms = ["237.3", "313.7", "451.9", "666.6", "1234.5"];
// pixels darker than this belong to a line
const kInk = 200;
// a line's center moves the same amount on every row; a tile off by a pixel breaks that
const kMaxStepError = 0.5;
// the canvas edge holds scrollbars and the page border; scan the middle only
const kMargin = 0.1;

// 45-degree hairlines (one device pixel wide at any zoom, so a shift shows on a single row) every 12 pt
function diagonalPdf(): string {
  const ops = ["0 w"];
  for (let x = -792; x <= 612; x += 12) ops.push(`${x} 0 m ${x + 792} 792 l S`);
  const content = ops.join("\n");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

// history entry that opens the page at `zoom`, scrolled so its center (a tile corner) is in view
function seedSettings(path: string, pdf: string, zoom: string): void {
  writeFileSync(
    path,
    `UiLanguage = en
CheckForUpdates = false
RestoreSession = false
RememberOpenedFiles = true
RememberStatePerDocument = true
ShowStartPage = false
FileStates [
  [
    FilePath = ${pdf}
    DisplayMode = single page
    PageNo = 1
    Zoom = ${zoom}
    Rotation = 0
    ScrollPos = 250 340
    ShowToc = false
    UseDefaultState = false
  ]
]
`,
  );
}

// ink-weighted centers of the lines crossing row y, skipping runs cut by the scan edges
function lineCenters(img: PngImage, y: number, x0: number, x1: number): number[] {
  const centers: number[] = [];
  let sum = 0;
  let weight = 0;
  let start = -1;
  for (let x = x0; x < x1; x++) {
    const v = img.data[(y * img.w + x) * img.nComp]!;
    if (v < kInk) {
      if (start < 0) start = x;
      sum += x * (255 - v);
      weight += 255 - v;
      continue;
    }
    if (start > x0) centers.push(sum / weight);
    start = -1;
    sum = 0;
    weight = 0;
  }
  return centers;
}

// Rows where a line's center doesn't move by the step every other row shows.
function findBreaks(png: string): { rows: number; breaks: number[] } {
  const img = loadPng(png);
  const x0 = Math.floor(img.w * kMargin);
  const x1 = img.w - x0;
  const y0 = Math.floor(img.h * kMargin);
  const rows: number[][] = [];
  for (let y = y0; y < img.h - y0; y++) rows.push(lineCenters(img, y, x0, x1));

  // per row pair, each center's move from its nearest predecessor; the median is the line slope
  const moves: { y: number; d: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    for (const c of rows[i]!) {
      let best = Infinity;
      for (const p of rows[i - 1]!) if (Math.abs(c - p) < Math.abs(best)) best = c - p;
      if (Math.abs(best) < 3) moves.push({ y: y0 + i, d: best });
    }
  }
  const sorted = moves.map((m) => m.d).sort((a, b) => a - b);
  const step = sorted[sorted.length >> 1] ?? 0;
  const breaks = [...new Set(moves.filter((m) => Math.abs(m.d - step) > kMaxStepError).map((m) => m.y))];
  return { rows: rows.length, breaks };
}

async function breaksAt(engine: string, zoom: string): Promise<string> {
  const dir = tmpPath(`pdfium-tiles/${engine}-${zoom}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "diagonal.pdf");
  writeFileSync(pdf, diagonalPdf(), "latin1");
  seedSettings(join(dir, "SolokPDF-settings.txt"), pdf, zoom);

  const args = ["-appdata", dir, "-log-to-file", join(dir, "log.txt"), pdf];
  const { proc, client, frame } = await launchControlled(args, { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    const idle = await client.waitForRenderIdle(30000);
    const png = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
    await client.quit();
    await proc.exited;
    const { rows, breaks } = findBreaks(png);
    const res = /res=\d+/.exec(idle)?.[0] ?? "res=?";
    const line = `${engine} ${zoom}% ${res}: ${breaks.length} broken rows of ${rows} [${breaks.slice(0, 6).join(" ")}] ${png}`;
    console.log(line);
    return breaks.length === 0 ? "" : line;
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const failures: string[] = [];
  for (const zoom of kZooms) {
    for (const engine of ["pdfium", "mupdf"]) {
      const failure = await breaksAt(engine, zoom);
      if (failure) failures.push(failure);
    }
  }
  if (failures.length > 0) throw new Error(`tiles out of line:\n${failures.join("\n")}`);
}

if (import.meta.main) await runStandalone(testit);
