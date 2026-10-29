import { writeFileSync } from "node:fs";
import { assemblePdf, extractPageText, runStandalone, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-text.pdf");
  const stream = "BT /F1 12 Tf 72 720 Td [(Library) -300 (Functions) -300 (Manual)] TJ ET";
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

  const previous = process.env.SOLOKPDF_ENGINE;
  try {
    process.env.SOLOKPDF_ENGINE = "mupdf";
    const expected = extractPageText(pdf, 1);
    if (!expected.includes("Library Functions Manual")) {
      throw new Error(`MuPDF spacing: ${JSON.stringify(expected)}`);
    }

    process.env.SOLOKPDF_ENGINE = "pdfium";
    const actual = extractPageText(pdf, 1);
    if (actual !== expected) {
      throw new Error(`PDFium text ${JSON.stringify(actual)}, MuPDF ${JSON.stringify(expected)}`);
    }
  } finally {
    if (previous === undefined) delete process.env.SOLOKPDF_ENGINE;
    else process.env.SOLOKPDF_ENGINE = previous;
  }
}

if (import.meta.main) await runStandalone(testit);
