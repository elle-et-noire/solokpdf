import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, loadPng, runStandalone, tmpPath } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng, setProcessDpiAware } from "./winapi.ts";

const background = [0x31, 0x67, 0xa1];

async function sample(engine: string): Promise<number> {
  const dir = tmpPath(`pdfium-window-bg-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "page.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] >>",
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Light\nFixedPageUI [\n\tWindowBgCol = #3167a1\n]\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const png = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error(`${engine}: capture failed`);
    const img = loadPng(png);
    let count = 0;
    for (let y = Math.floor(img.h / 4); y < Math.floor((img.h * 3) / 4); y++) {
      for (let x = 0; x < Math.floor(img.w / 8); x++) {
        const i = (y * img.w + x) * img.nComp;
        if (background.every((v, c) => img.data[i + c] === v)) count++;
      }
    }
    await client.quit();
    await proc.exited;
    return count;
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  for (const engine of ["mupdf", "pdfium"]) {
    const count = await sample(engine);
    if (count < 300) throw new Error(`${engine}: only ${count} page-surround pixels have WindowBgCol`);
  }
}

if (import.meta.main) await runStandalone(testit);
