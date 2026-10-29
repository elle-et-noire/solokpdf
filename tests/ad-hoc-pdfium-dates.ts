import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-dates.pdf");
  writeFileSync(
    pdf,
    assemblePdf(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
        "<< /CreationDate (D:20240102030405+09'00') /ModDate (D:20250203040506-05'00') >>",
      ],
      { trailerExtras: "/Info 4 0 R" },
    ),
    "latin1",
  );

  let expected = "";
  for (const engine of ["mupdf", "pdfium"]) {
    const displayed = await withControlledSumatra(
      EXE,
      async (client) => {
        const [rawCode, raw] = await client.request(ControlCommand.TestDocumentProperties);
        if (rawCode !== 0 || !String(raw).includes("creationDate=D:20240102030405")) {
          throw new Error(`${engine}: raw CreationDate ${raw}`);
        }
        const [code, text] = await client.request(ControlCommand.TestDocumentProperties, ["display"]);
        if (code !== 0) throw new Error(`${engine}: ${text}`);
        return String(text)
          .split(/\r?\n/)
          .filter((line) => /Created:|Modified:/.test(line))
          .join("\n");
      },
      [pdf],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
    if (engine === "mupdf") {
      expected = displayed;
      if (!expected.includes("2024") || !expected.includes("2025")) throw new Error(`MuPDF: ${expected}`);
    } else if (displayed !== expected) {
      throw new Error(`PDFium dates ${JSON.stringify(displayed)}, MuPDF ${JSON.stringify(expected)}`);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
