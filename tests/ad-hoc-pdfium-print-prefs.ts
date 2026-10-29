import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-print-prefs.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PickTrayByPDFSize true /NumCopies 3 /Duplex /DuplexFlipLongEdge /PrintScaling /None >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    ]),
    "latin1",
  );

  for (const engine of ["mupdf", "pdfium"]) {
    await withControlledSumatra(
      EXE,
      async (client) => {
        const [code, raw] = await client.request(ControlCommand.TestCurrentPdf, ["print-prefs"]);
        if (code !== 0 || raw !== "found=1 tray=1 copies=3 duplex=3 scaling=1") {
          throw new Error(`${engine}: ${raw}`);
        }
        if (engine === "pdfium") {
          const [editorCode, editor] = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
          if (editorCode !== 0 || editor !== "editor=none") throw new Error(`editor loaded: ${editor}`);
        }
      },
      [pdf],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
  }
}

if (import.meta.main) await runStandalone(testit);
