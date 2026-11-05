import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const patternStrokes = process.env.SOLOKPDF_TEST_PATTERN_STROKES === "1";
  const dir = tmpPath("theme-transparent-fallback");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "transparent.pdf");
  const stream =
    "q /Half gs 100 0 0 100 50 0 cm /Im Do Q" +
    (patternStrokes ? " q /PCS CS .2 .4 .8 /P SCN 1 w 5 5 185 90 re S Q" : "");
  const pattern = "0 0 10 10 re f";
  const image = String.fromCharCode(255, 0, 0).repeat(64);
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> /ExtGState << /Half 6 0 R >> ${patternStrokes ? "/ColorSpace << /PCS [/Pattern /DeviceRGB] >> /Pattern << /P 7 0 R >>" : ""} >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
      "<< /Type /ExtGState /ca 0.5 >>",
      `<< /Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Length ${pattern.length} >>\nstream\n${pattern}\nendstream`,
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = ${patternStrokes ? "off" : "smart"}\n`,
  );
  const captures = [];
  for (const fallback of [false, true]) {
    const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
      env: {
        SOLOKPDF_ENGINE: patternStrokes && !fallback ? "mupdf" : "pdfium",
        SOLOKPDF_TEST_THEME_FALLBACK: fallback ? "1" : "",
      },
    });
    try {
      await client.setNotificationsEnabled(false);
      await client.request(ControlCommand.TestInvokeCommand, ["CmdToggleTransparencyGrid"]);
      await client.waitForRenderIdle();
      const png = join(dir, fallback ? "fallback.png" : "pdfium.png");
      if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
      captures.push(loadPng(png));
      await client.quit();
      await proc.exited;
    } finally {
      await killAndWait(proc);
    }
  }
  const [normal, fallback] = captures;
  if (!normal || !fallback || normal.w !== fallback.w || normal.h !== fallback.h || normal.nComp !== fallback.nComp) {
    throw new Error("capture dimensions differ");
  }
  let redPixels = 0;
  let different = 0;
  let patternPixels = 0;
  let differentPattern = 0;
  for (let i = 0; i < normal.w * normal.h; i++) {
    const p = i * normal.nComp;
    const red = normal.data[p]!;
    const green = normal.data[p + 1]!;
    const blue = normal.data[p + 2]!;
    if (patternStrokes && blue > red + 40 && blue > green + 40) {
      const x = i % normal.w;
      const y = Math.floor(i / normal.w);
      const uniform =
        x > 0 &&
        x + 1 < normal.w &&
        y > 0 &&
        y + 1 < normal.h &&
        [-normal.w, normal.w, -1, 1].every((offset) =>
          [0, 1, 2].every((c) => Math.abs(normal.data[p + offset * normal.nComp + c]! - normal.data[p + c]!) < 2),
        );
      if (uniform) {
        patternPixels++;
        if ([red, green, blue].some((value, c) => Math.abs(value - fallback.data[p + c]!) > 6)) differentPattern++;
      }
    }
    if (red > green + 40 && red > blue + 40 && green > 20 && blue > 20) {
      redPixels++;
      if ([red, green, blue].some((value, c) => Math.abs(value - fallback.data[p + c]!) > 6)) different++;
    }
  }
  if (redPixels < 500 || different > redPixels * 0.01) {
    throw new Error(`transparent image differs: ${different}/${redPixels} pixels`);
  }
  if (patternStrokes && (patternPixels < 200 || differentPattern > patternPixels * 0.05)) {
    throw new Error(`transparent-page pattern stroke differs: ${differentPattern}/${patternPixels}`);
  }
  if (patternStrokes) {
    const bounds = (img: ReturnType<typeof loadPng>) => {
      const box = { x0: img.w, y0: img.h, x1: -1, y1: -1, count: 0 };
      for (let i = 0; i < img.w * img.h; i++) {
        const p = i * img.nComp;
        if (img.data[p + 2]! <= img.data[p]! + 40 || img.data[p + 2]! <= img.data[p + 1]! + 40) continue;
        const x = i % img.w,
          y = Math.floor(i / img.w);
        box.x0 = Math.min(box.x0, x);
        box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x);
        box.y1 = Math.max(box.y1, y);
        box.count++;
      }
      return box;
    };
    const a = bounds(normal),
      b = bounds(fallback);
    if (
      ["x0", "y0", "x1", "y1"].some((key) => Math.abs(a[key as keyof typeof a] - b[key as keyof typeof b]) > 2) ||
      Math.abs(a.count - b.count) > a.count * 0.1
    ) {
      throw new Error(`transparent-page pattern geometry differs: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
