import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

function makePdf(alpha: number, mask: boolean): string {
  const page = "q /GS gs BT /F 100 Tf 0 0 Td (ABC) Tj ET Q";
  const glyphA = "1000 0 d0 0 g 0 0 1000 1000 re f";
  const glyphB = "1000 0 d0 1 0 0 rg q 1000 0 0 1000 0 0 cm /Im Do Q";
  const glyphC = "1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f";
  const image = mask ? "\x00".repeat(8) : String.fromCharCode(255, 0, 0).repeat(64);
  const imageParams = mask ? "/ImageMask true /BitsPerComponent 1" : "/ColorSpace /DeviceRGB /BitsPerComponent 8";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F 6 0 R >> /ExtGState << /GS 10 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F 6 0 R >> /ExtGState << /GS 10 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A 7 0 R /B 8 0 R /C 11 0 R >> /Encoding << /Type /Encoding /Differences [65 /A /B /C] >> /FirstChar 65 /LastChar 67 /Widths [1000 1000 1000] /Resources << /XObject << /Im 9 0 R >> >> >>",
    `<< /Length ${glyphA.length} >>\nstream\n${glyphA}\nendstream`,
    `<< /Length ${glyphB.length} >>\nstream\n${glyphB}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 ${imageParams} /Length ${image.length} >>\nstream\n${image}\nendstream`,
    `<< /Type /ExtGState /ca ${alpha} >>`,
    `<< /Length ${glyphC.length} >>\nstream\n${glyphC}\nendstream`,
  ]);
}

async function check(alpha: number, mask: boolean): Promise<void> {
  const engine = process.env.SOLOKPDF_ENGINE || "pdfium";
  const dir = tmpPath(`theme-type3-${USE_NG ? "ng" : engine}-${alpha}-${mask}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "type3.pdf");
  writeFileSync(pdf, makePdf(alpha, mask), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nDefaultDisplayMode = single page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    for (const theme of ["Solarized Dark", "Light", "Solarized Dark"]) {
      const result = await client.request(ControlCommand.TestInvokeCommand, [`CmdSetTheme ${theme}`]);
      if (result[0] !== 0) throw new Error(`theme change: ${result}`);
      for (const rotated of [false, true]) {
        if (rotated) {
          const rotate = await client.request(ControlCommand.TestInvokeCommand, ["CmdRotateRight"]);
          if (rotate[0] !== 0) throw new Error(`rotate: ${rotate}`);
        }
        for (let page = 1; page <= 2; page++) {
          const location = await client.goToLocation(1, page);
          if (location.page !== page) throw new Error(`wrong page: ${JSON.stringify(location)}`);
          await client.waitForRenderIdle();
          const path = join(dir, `page-${page}.png`);
          if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
          const img = loadPng(path);
          const themedColor =
            theme === "Light"
              ? alpha === 1
                ? [0, 0, 0]
                : [121, 121, 121]
              : alpha === 1
                ? [131, 148, 150]
                : [66, 96, 102];
          const imageColor =
            theme === "Light" && alpha !== 1 ? [249, 121, 121] : alpha === 1 ? [255, 0, 0] : [128, 22, 27];
          let themed = 0,
            red = 0,
            left = img.w,
            right = -1,
            top = img.h,
            bottom = -1;
          for (let i = 0; i < img.w * img.h; i++) {
            const p = i * img.nComp;
            if (themedColor.every((v, c) => Math.abs(img.data[p + c]! - v) < 8)) themed++;
            if (imageColor.every((v, c) => Math.abs(img.data[p + c]! - v) < 8)) {
              red++;
              const x = i % img.w;
              left = Math.min(left, x);
              right = Math.max(right, x);
              top = Math.min(top, Math.floor(i / img.w));
              bottom = Math.max(bottom, Math.floor(i / img.w));
            }
          }
          if (themed < 500 || red < 500)
            throw new Error(`${USE_NG ? "ng" : engine} page ${page}: themed=${themed}, red=${red}`);
          const width = right - left + 1;
          const height = bottom - top + 1;
          const centerX = left + Math.floor(width / 2);
          const centerY = top + Math.floor(height / 2);
          const samples = rotated
            ? [
                [centerX, top - Math.floor(height / 2)],
                [centerX, bottom + Math.floor(height / 2)],
              ]
            : [
                [left - Math.floor(width / 2), centerY],
                [right + Math.floor(width / 2), centerY],
              ];
          for (const [x, y] of samples) {
            if (x! < 0 || x! >= img.w || y! < 0 || y! >= img.h) throw new Error(`sample outside canvas: ${x},${y}`);
            const offset = (y! * img.w + x!) * img.nComp;
            const actual = Array.from(img.data.subarray(offset, offset + 3));
            if (actual.some((v, c) => Math.abs(v - themedColor[c]!) >= 8))
              throw new Error(`page ${page}: glyph at ${x},${y} is ${actual}`);
          }
        }
        if (rotated) {
          const rotate = await client.request(ControlCommand.TestInvokeCommand, ["CmdRotateLeft"]);
          if (rotate[0] !== 0) throw new Error(`rotate: ${rotate}`);
        }
      }
    }
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

// colored Type 3 glyphs keep the surrounding fill alpha with theme colors off
async function checkPdfiumOpacity(mask: boolean): Promise<void> {
  const dir = tmpPath(`theme-type3-pdfium-original-${mask}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "type3.pdf");
  writeFileSync(pdf, makePdf(0.5, mask), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = off\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
    env: { SOLOKPDF_ENGINE: "pdfium" },
  });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const path = join(dir, "original.png");
    if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
    const img = loadPng(path);
    const expected = [
      [127, 127, 127],
      [255, 127, 127],
    ];
    const counts = expected.map(() => 0);
    for (let i = 0; i < img.w * img.h; i++) {
      const p = i * img.nComp;
      for (const [index, rgb] of expected.entries()) {
        if (rgb.every((value, c) => Math.abs(img.data[p + c]! - value) < 8)) counts[index]!++;
      }
    }
    if (counts.some((count) => count < 500)) throw new Error(`PDFium Type 3 opacity: ${counts}`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (!USE_NG && (!process.env.SOLOKPDF_ENGINE || process.env.SOLOKPDF_ENGINE === "pdfium")) {
    await checkPdfiumOpacity(false);
    await checkPdfiumOpacity(true);
  }
  await check(1, false);
  await check(0.5, false);
  await check(1, true);
  await check(0.5, true);
}

if (import.meta.main) {
  await runStandalone(testit);
}
