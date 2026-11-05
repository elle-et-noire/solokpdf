import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("theme-large-pdf");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "large.pdf");
  const renamed = join(dir, "renamed.pdf");
  rmSync(renamed, { force: true });
  const content = "q 0 g 0 0 100 100 re f Q q 100 0 0 100 100 0 cm /Im Do Q";
  const image = String.fromCharCode(255, 0, 0).repeat(64);
  const header = `%PDF-1.4\n%${"x".repeat(33 * 1024 * 1024)}\n`;
  writeFileSync(
    pdf,
    assemblePdf(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
      ],
      { header },
    ),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
    env: { SOLOKPDF_ENGINE: "pdfium" },
  });
  try {
    await client.setNotificationsEnabled(false);
    const check = async (name: string, ink: number[]) => {
      await client.waitForRenderIdle();
      const png = join(dir, `${name}.png`);
      if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
      const bitmap = loadPng(png);
      const colors = [ink, [255, 0, 0]];
      const counts = colors.map(() => 0);
      for (let i = 0; i < bitmap.w * bitmap.h; i++) {
        const p = i * bitmap.nComp;
        for (const [index, rgb] of colors.entries()) {
          if (rgb.every((value, c) => Math.abs(bitmap.data[p + c]! - value) < 8)) counts[index]!++;
        }
      }
      if (counts.some((count) => count < 500)) throw new Error(`${name}: missing page colors ${counts}`);
    };
    await check("before", [131, 148, 150]);
    renameSync(pdf, renamed);
    const result = await client.request(ControlCommand.TestInvokeCommand, ["CmdSetTheme Dark"]);
    if (result[0] !== 0) throw new Error(`theme change: ${result}`);
    await check("renamed", [249, 250, 251]);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
