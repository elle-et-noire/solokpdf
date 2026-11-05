import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

type Box = { x0: number; y0: number; x1: number; y1: number; count: number };

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("theme-fallback-geometry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nDefaultDisplayMode = single page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const image = String.fromCharCode(255, 0, 0).repeat(64);
  const content = "q 40 0 0 30 110 160 cm /Im Do Q";
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
        `<< /Type /Page /Parent 2 0 R /MediaBox [40 60 280 380] ${options} /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
      ]),
      "latin1",
    );
    const results: Box[][] = [];
    for (const fallback of [false, true]) {
      const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
        env: { SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_TEST_THEME_FALLBACK: fallback ? "1" : "" },
      });
      try {
        await client.setNotificationsEnabled(false);
        const boxes: Box[] = [];
        for (const rotation of [0, 90]) {
          if (rotation) await client.request(ControlCommand.TestInvokeCommand, ["CmdRotateRight"]);
          await client.waitForRenderIdle();
          const png = join(dir, `${name}-${fallback}-${rotation}.png`);
          if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
          const bitmap = loadPng(png);
          const box: Box = { x0: bitmap.w, y0: bitmap.h, x1: -1, y1: -1, count: 0 };
          for (let i = 0; i < bitmap.w * bitmap.h; i++) {
            const p = i * bitmap.nComp;
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
        }
        results.push(boxes);
        await client.quit();
        await proc.exited;
      } finally {
        await killAndWait(proc);
      }
    }
    for (let i = 0; i < 2; i++) {
      const normal = results[0]![i]!;
      const fallback = results[1]![i]!;
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
