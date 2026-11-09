import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("theme-annotation-failure");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "annotation.pdf");
  const content = "0 g 10 10 40 40 re f";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Annots [5 0 R] >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Annot /Subtype /Text /Rect [60 60 80 80] /Contents (sample) >>",
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );

  for (const fail of [false, true]) {
    const { proc, client } = await launchControlled(["-appdata", dir, pdf], {
      env: { SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_TEST_ANNOTATION_FAILURE: fail ? "1" : "" },
    });
    try {
      const initial = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (initial[1] !== "editor=none") {
        console.log("SKIP: PDFium build required");
        return;
      }
      const render = () => client.request(ControlCommand.TestRenderPageColors, [pdf]);
      if ((await render())[0] !== 0) throw new Error("PDFium body render failed");
      await client.request(ControlCommand.TestCurrentPdf, [""]);
      const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (editor[1] !== "editor=loaded") throw new Error(`editor did not load: ${editor}`);
      const result = await render();
      if (fail ? result[0] === 0 || !String(result[1]).includes("ERROR render-failed") : result[0] !== 0) {
        throw new Error(`annotation failure=${fail}: ${result}`);
      }
      await client.quit();
      if ((await proc.exited) !== 0) throw new Error("app failed to exit");
    } finally {
      await killAndWait(proc);
    }
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
