import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

function makePdf(): string {
  const appearance = "0 g 0 0 200 100 re f q 200 0 0 100 200 0 cm /Im Do Q";
  const image = String.fromCharCode(255, 0, 0).repeat(64);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /T (sample) /V /Yes /AS /Yes /Rect [100 300 500 400] /F 4 /AP << /N << /Yes 5 0 R /Off 5 0 R >> >> >>",
    `<< /Type /XObject /Subtype /Form /BBox [0 0 400 100] /Resources << /XObject << /Im 6 0 R >> >> /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
  ]);
}

export async function testit(): Promise<void> {
  const engine = process.env.SOLOKPDF_ENGINE || "pdfium";
  const dir = tmpPath(`theme-state-widget-${USE_NG ? "ng" : engine}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "widget.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nHighlightFormFields = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    const count = async (name: string): Promise<[number, number]> => {
      await client.waitForRenderIdle();
      const path = join(dir, `${name}.png`);
      if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
      const img = loadPng(path);
      let themed = 0,
        red = 0;
      for (let i = 0; i < img.w * img.h; i++) {
        const p = i * img.nComp;
        if ([131, 148, 150].every((v, c) => Math.abs(img.data[p + c]! - v) < 8)) themed++;
        if ([255, 0, 0].every((v, c) => Math.abs(img.data[p + c]! - v) < 8)) red++;
      }
      return [themed, red];
    };
    const before = await count("before");
    let after = before;
    if (!USE_NG) {
      const toggle = await client.toggleFormButton(1, 0);
      if (!toggle.toggled) throw new Error(`widget did not toggle: ${JSON.stringify(toggle)}`);
      const zoom = await client.request(ControlCommand.TestInvokeCommand, ["CmdZoomIn"]);
      if (zoom[0] !== 0) throw new Error(`zoom: ${zoom}`);
      after = await count("after");
      await client.resolveUnsavedChanges("discard");
    }
    await client.quit();
    await proc.exited;
    if ([...before, ...after].some((n) => n < 500))
      throw new Error(`${USE_NG ? "ng" : engine}: state colors before=${before}, after=${after}`);
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
