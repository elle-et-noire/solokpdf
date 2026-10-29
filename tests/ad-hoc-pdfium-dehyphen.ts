import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-dehyphen.pdf");
  const stream = "BT /F1 12 Tf 50 750 Td (hyphen-) Tj 0 -16 Td (ated) Tj ET";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ]),
    "latin1",
  );

  for (const engine of ["mupdf", "pdfium"]) {
    await withControlledSumatra(
      EXE,
      async (client) => {
        const [, raw] = await client.request(ControlCommand.TestSearch, [pdf, "hyphenated"]);
        if (!String(raw).startsWith("FOUND")) {
          throw new Error(`${engine}: ${raw}`);
        }
      },
      [],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
  }
}

if (import.meta.main) await runStandalone(testit);
