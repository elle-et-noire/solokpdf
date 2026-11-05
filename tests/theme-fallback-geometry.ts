import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

type Box = { x0: number; y0: number; x1: number; y1: number; count: number };

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const patternStrokes = process.env.SOLOKPDF_TEST_PATTERN_STROKES === "1";
  const dir = tmpPath("theme-fallback-geometry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nDefaultDisplayMode = single page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = ${patternStrokes ? "off" : "smart"}\n`,
  );
  const image = String.fromCharCode(255, 0, 0).repeat(64);
  const content =
    "q 40 0 0 30 110 160 cm /Im Do Q" + (patternStrokes ? " q /PCS CS .4 .2 .8 /P SCN 2 w 80 110 120 50 re S Q" : "");
  const pattern = "0 0 10 10 re f";
  for (const [name, options] of [
    ["origin", ""],
    ["crop", "/CropBox [70 90 250 350]"],
    ["rotate", "/CropBox [70 90 250 350] /Rotate 90"],
    ["user-unit", "/CropBox [70 90 250 350] /UserUnit 2"],
  ]) {
    const pdf = join(dir, `${name}.pdf`);
    writeFileSync(
      pdf,
      assemblePdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [40 60 280 380] ${options} /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> ${patternStrokes ? "/ColorSpace << /PCS [/Pattern /DeviceRGB] >> /Pattern << /P 6 0 R >>" : ""} >> >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
        `<< /Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Length ${pattern.length} >>\nstream\n${pattern}\nendstream`,
      ]),
      "latin1",
    );
    const results: Box[][] = [];
    const patternResults: Box[][] = [];
    for (const fallback of [false, true]) {
      const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
        env: {
          SOLOKPDF_ENGINE: patternStrokes && !fallback ? "mupdf" : "pdfium",
          SOLOKPDF_TEST_THEME_FALLBACK: fallback ? "1" : "",
        },
      });
      try {
        await client.setNotificationsEnabled(false);
        const boxes: Box[] = [];
        const patternBoxes: Box[] = [];
        for (const rotation of [0, 90]) {
          if (rotation) await client.request(ControlCommand.TestInvokeCommand, ["CmdRotateRight"]);
          await client.waitForRenderIdle();
          const png = join(dir, `${name}-${fallback}-${rotation}.png`);
          if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
          const bitmap = loadPng(png);
          const box: Box = { x0: bitmap.w, y0: bitmap.h, x1: -1, y1: -1, count: 0 };
          const patternBox: Box = { ...box };
          for (let i = 0; i < bitmap.w * bitmap.h; i++) {
            const p = i * bitmap.nComp;
            if (patternStrokes && [102, 51, 204].every((value, c) => Math.abs(bitmap.data[p + c]! - value) < 6)) {
              const x = i % bitmap.w;
              const y = Math.floor(i / bitmap.w);
              patternBox.x0 = Math.min(patternBox.x0, x);
              patternBox.y0 = Math.min(patternBox.y0, y);
              patternBox.x1 = Math.max(patternBox.x1, x);
              patternBox.y1 = Math.max(patternBox.y1, y);
              patternBox.count++;
            }
            if (bitmap.data[p]! < 247 || bitmap.data[p + 1]! > 8 || bitmap.data[p + 2]! > 8) continue;
            const x = i % bitmap.w;
            const y = Math.floor(i / bitmap.w);
            box.x0 = Math.min(box.x0, x);
            box.y0 = Math.min(box.y0, y);
            box.x1 = Math.max(box.x1, x);
            box.y1 = Math.max(box.y1, y);
            box.count++;
          }
          if (box.count < 200) throw new Error(`${name}/${fallback}/${rotation}: image missing`);
          boxes.push(box);
          if (patternStrokes && patternBox.count < 100)
            throw new Error(`${name}/${fallback}/${rotation}: pattern stroke missing`);
          patternBoxes.push(patternBox);
        }
        results.push(boxes);
        patternResults.push(patternBoxes);
        await client.quit();
        await proc.exited;
      } finally {
        await killAndWait(proc);
      }
    }
    for (let i = 0; i < 2; i++) {
      const normal = results[0]![i]!;
      const fallback = results[1]![i]!;
      if (patternStrokes) {
        const a = patternResults[0]![i]!;
        const b = patternResults[1]![i]!;
        for (const key of ["x0", "y0", "x1", "y1"] as const) {
          if (Math.abs(a[key] - b[key]) > 2)
            throw new Error(
              `${name}/${i}: pattern stroke position differs ${JSON.stringify(a)} / ${JSON.stringify(b)}`,
            );
        }
      }
      for (const key of ["x0", "y0", "x1", "y1"] as const) {
        if (Math.abs(normal[key] - fallback[key]) > 2) {
          throw new Error(
            `${name}/${i}: image position differs ${JSON.stringify(normal)} / ${JSON.stringify(fallback)}`,
          );
        }
      }
    }
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
