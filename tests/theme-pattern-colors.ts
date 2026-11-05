import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_MAC } from "./host.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

function patternPdf(space: string, color: string): string {
  const pattern = "0 0 10 10 re f";
  const content = `q /PCS CS ${color} /P SCN 50 w 100 100 400 400 re S Q`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /ColorSpace << /PCS [/Pattern /${space}] >> /Pattern << /P 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Length ${pattern.length} >>\nstream\n${pattern}\nendstream`,
  ]);
}

function formPdf(): string {
  const content = "q 1 0 0 rg 1 0 0 1 60 100 cm /Fm Do Q q 0 0 1 rg 1 0 0 1 340 100 cm /Fm Do Q 0 g 20 340 100 40 re f";
  const form = "q 200 0 0 200 0 0 cm /Im Do Q";
  const mask = "\0".repeat(8);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /XObject << /Im 6 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Length ${mask.length} >>\nstream\n${mask}\nendstream`,
  ]);
}

async function check(engine: string, name: string, pdf: string, expected: number[][]): Promise<void> {
  const dir = tmpPath(`theme-pattern-${engine}-${name}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "page.pdf");
  writeFileSync(path, pdf, "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, path], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const capture = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), capture)) throw new Error("capture failed");
    const img = loadPng(capture);
    const counts = expected.map(() => 0);
    for (let i = 0; i < img.w * img.h; i++) {
      const p = i * img.nComp;
      for (let c = 0; c < expected.length; c++) {
        if (expected[c]!.every((v, channel) => Math.abs(img.data[p + channel]! - v) < 4)) counts[c]!++;
      }
    }
    if (counts.some((n) => n < 500))
      throw new Error(`${engine}/${name}: colors=${JSON.stringify(expected)}, counts=${counts}`);
    console.log(`${engine}/${name}: colors preserved (${counts})`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (IS_MAC) return;
  const failures: string[] = [];
  const patterns: [string, string, number[]][] = [
    ["DeviceGray", "0", [131, 148, 150]],
    ["DeviceCMYK", "0 0 0 1", [114, 135, 138]],
    ["DeviceRGB", "0 0 0", [131, 148, 150]],
  ];
  for (const engine of USE_NG ? ["mupdf"] : ["mupdf", "pdfium"]) {
    const cases = [
      () =>
        check(engine, "inherited-mask", formPdf(), [
          [255, 0, 0],
          [0, 0, 255],
          [131, 148, 150],
        ]),
      ...patterns.map(
        ([space, color, expected]) =>
          () =>
            check(engine, space, patternPdf(space, color), [expected]),
      ),
    ];
    for (const run of cases) {
      try {
        await run();
      } catch (e) {
        failures.push(String(e));
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
