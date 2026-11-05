import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

function makePdf(appearance: string, fontName: string): string {
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /NeedAppearances true /DA (${appearance}) /DR << /Font << /${fontName} 6 0 R >> >> >> >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [5 0 R] >>",
    "<< /FT /Tx /T (sample) /V (Dynamic text) /Kids [5 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /Parent 4 0 R /Rect [100 300 500 400] /F 4 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

async function check(name: string, appearance: string, fontName: string, editField: boolean): Promise<void> {
  const engine = process.env.SOLOKPDF_ENGINE || "pdfium";
  const dir = tmpPath(`theme-dynamic-widget-${USE_NG ? "ng" : engine}-${name}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "widget.pdf");
  writeFileSync(pdf, makePdf(appearance, fontName), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    const countThemed = async (name: string): Promise<number> => {
      await client.waitForRenderIdle();
      const path = join(dir, `${name}.png`);
      if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
      const img = loadPng(path);
      let themed = 0;
      for (let y = Math.floor(img.h * 0.3); y < img.h * 0.7; y++) {
        for (let x = Math.floor(img.w * 0.15); x < img.w * 0.85; x++) {
          const p = (y * img.w + x) * img.nComp;
          const red = img.data[p]!;
          const green = img.data[p + 1]!;
          const blue = img.data[p + 2]!;
          if (
            red >= 40 &&
            red <= 139 &&
            Math.abs(green - (43 + (105 * red) / 131)) < 8 &&
            Math.abs(blue - (54 + (96 * red) / 131)) < 8
          )
            themed++;
        }
      }
      return themed;
    };
    const before = await countThemed("before");
    let after = before;
    if (!USE_NG && editField) {
      const edit = await client.setFormField(1, 0, "Changed text");
      if (edit[0] !== 0 || !String(edit[1]).includes("after='Changed text'")) throw new Error(`widget edit: ${edit}`);
      const zoom = await client.request(ControlCommand.TestInvokeCommand, ["CmdZoomIn"]);
      if (zoom[0] !== 0) throw new Error(`zoom: ${zoom}`);
      after = await countThemed("after");
      await client.resolveUnsavedChanges("discard");
    }
    await client.quit();
    await proc.exited;
    if (before < 30 || after < 30)
      throw new Error(
        `${USE_NG ? "ng" : engine}/${name}: dynamic widget text is not themed (before=${before}, after=${after})`,
      );
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  await check("gray", "/Helv 24 Tf 0 g", "Helv", true);
  await check("rgb", "/Helv 24 Tf 1 0 0 rg 0 0 0 rg", "Helv", false);
  await check("cmyk", "/Helv 24 Tf 0 0 0 1 k", "Helv", false);
  const name = `Custom${"Font".repeat(25)}`;
  await check("long-font", `/${name} 24 Tf 0 g`, name, false);
}

if (import.meta.main) {
  await runStandalone(testit);
}
