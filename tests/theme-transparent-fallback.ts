import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("theme-transparent-fallback");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "transparent.pdf");
  const stream = "q /Half gs 100 0 0 100 50 0 cm /Im Do Q";
  const image = String.fromCharCode(255, 0, 0).repeat(64);
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> /ExtGState << /Half 6 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
      "<< /Type /ExtGState /ca 0.5 >>",
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const captures = [];
  for (const fallback of [false, true]) {
    const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
      env: { SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_TEST_THEME_FALLBACK: fallback ? "1" : "" },
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
  for (let i = 0; i < normal.w * normal.h; i++) {
    const p = i * normal.nComp;
    const red = normal.data[p]!;
    const green = normal.data[p + 1]!;
    const blue = normal.data[p + 2]!;
    if (red > green + 40 && red > blue + 40 && green > 20 && blue > 20) {
      redPixels++;
      if ([red, green, blue].some((value, c) => Math.abs(value - fallback.data[p + c]!) > 6)) different++;
    }
  }
  if (redPixels < 500 || different > redPixels * 0.01) {
    throw new Error(`transparent image differs: ${different}/${redPixels} pixels`);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
