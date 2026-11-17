// B76: with DocumentColorsFollowTheme = smart a stencil image mask (dvips/Ghostscript rules: 1x1 /ImageMask
// scaled to a bar) is paint, so it takes the theme text color like a path, while an RGB photo keeps its pixels.
// Checks the view and the Home thumbnail on PDFium and MuPDF tabs. Build with solok-build.ts, then use --no-build.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, loadPng, runStandalone, tmpPath, type PngImage } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { captureWindowToPng, setProcessDpiAware, sleep } from "./winapi.ts";

const kTolerance = 8;
const kBlack = [0, 0, 0];
const kRed = [255, 0, 0];
// Solarized Dark text color, which black paint maps to
const kThemeText = [131, 148, 150];
// rule pixels left black; anti-aliased edges never reach pure black
const kMaxBlackPixels = 40;
const kMinViewInkPixels = 2000;
const kMinViewPhotoPixels = 1000;
const kMinThumbPhotoPixels = 50;

function count(img: PngImage, rgb: number[]): number {
  let n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const p = i * img.nComp;
    if (rgb.every((c, k) => Math.abs(img.data[p + k]! - c) <= kTolerance)) n++;
  }
  return n;
}

// 32x32 RGB photo: a red square on varied colors kept away from black
function photoObject(): string {
  let pixels = "";
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const red = x >= 8 && x < 24 && y >= 8 && y < 24;
      const rgb = red ? kRed : [60 + ((x * 7 + y * 3) % 150), 60 + ((x * 5 + y * 9) % 150), 80 + ((x * 11 + y) % 100)];
      pixels += String.fromCharCode(...rgb);
    }
  }
  return `<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`;
}

// black rules as dvips + Ghostscript write them: a 1x1 stencil mask (sample 0 paints) scaled to the bar,
// as an XObject and inline, thin and thick, next to a photo; all in the top part a Home thumbnail shows
function stencilPdf(): string {
  const page = [
    "0 g",
    "q 300 0 0 6 250 700 cm /Rule Do Q",
    "q 300 0 0 70 250 600 cm /Rule Do Q",
    `q 300 0 0 6 250 570 cm BI /W 1 /H 1 /IM true /BPC 1 ID\n\x00\nEI Q`,
    "q 150 0 0 150 60 560 cm /Photo Do Q",
  ].join("\n");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /XObject << /Rule 5 0 R /Photo 6 0 R >> >> >>",
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 1 /Length 1 >>\nstream\n\x00\nendstream",
    photoObject(),
  ]);
}

async function checkEngine(engine: string): Promise<string[]> {
  const failures: string[] = [];
  const dir = tmpPath(`theme-stencil-mask/${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "stencil.pdf");
  writeFileSync(pdf, stencilPdf(), "latin1");
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = true\nNoHomeTab = false\nRememberOpenedFiles = true\n" +
      "HomePageViewMode = thumbnails\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const shot = (hwnd: number, name: string) => {
    const path = join(dir, `${name}.png`);
    if (!captureWindowToPng(hwnd, path)) throw new Error(`${engine} ${name}: capture failed`);
    const img = loadPng(path);
    const counts = { black: count(img, kBlack), ink: count(img, kThemeText), red: count(img, kRed), path };
    console.log(`${engine} ${name}: black=${counts.black} ink=${counts.ink} red=${counts.red} ${path}`);
    return counts;
  };

  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle(30000);
    const canvas = findCanvas(frame);
    const view = shot(canvas, "view");
    if (view.black > kMaxBlackPixels) failures.push(`${engine} view: stencil rule kept its black (${view.path})`);
    if (view.ink < kMinViewInkPixels) failures.push(`${engine} view: rule missing theme text color (${view.path})`);
    if (view.red < kMinViewPhotoPixels) failures.push(`${engine} view: photo recolored (${view.path})`);

    // Home recolors the theme-neutral thumbnail, sparing the engine's photo rects
    sendCommandSync(frame, cmdId("CmdClose"));
    let entries = 0;
    for (let i = 0; i < 40 && entries < 1; i++) {
      const home = await client.homeSelection("thumbnails");
      entries = home.ready ? home.entries : 0;
      if (entries < 1) await sleep(50);
    }
    if (entries < 1) throw new Error(`${engine}: Home thumbnail missing`);
    await sleep(150);
    const home = shot(findCanvas(frame), "home");
    if (home.black > kMaxBlackPixels) failures.push(`${engine} Home: stencil rule kept its black (${home.path})`);
    if (home.red < kMinThumbPhotoPixels) failures.push(`${engine} Home: photo recolored (${home.path})`);
  } finally {
    await killAndWait(proc);
  }
  return failures;
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const failures: string[] = [];
  for (const engine of ["pdfium", "mupdf"]) {
    failures.push(...(await checkEngine(engine)));
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
