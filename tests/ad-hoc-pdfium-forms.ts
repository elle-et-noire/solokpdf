// PDFium form edits use the lazy MuPDF editor and save through it.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

function formPdf(type: "text" | "choice"): string {
  const field =
    type === "text"
      ? "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>"
      : "<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (choice) /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) /Opt [(first) (second)] /V (first) >>";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
    field,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

async function check(type: "text" | "choice", engine: string): Promise<void> {
  const dir = tmpPath(`pdfium-forms/${type}-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  const saved = join(dir, "saved.pdf");
  const value = type === "text" ? "filled" : "second";
  writeFileSync(source, formPdf(type), "latin1");

  const set = async (path: string, copy?: string) =>
    withControlledSumatra(
      EXE,
      async (client) => {
        await client.waitForRenderIdle();
        const res = await client.request(ControlCommand.TestSetFormField, [1, 0, value]);
        if (res[0] !== 0) throw new Error(`${type} (${engine}): ${String(res[1])}`);
        if (copy) await client.resolveUnsavedChanges("save-as", copy);
        else await client.resolveUnsavedChanges("discard");
        return String(res[1]);
      },
      ["-appdata", dir, path],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );

  const first = await set(source, saved);
  if (!first.includes(`after='${value}'`)) throw new Error(`${type} (${engine}): ${first}`);
  const pixels = /viewBefore=(\d+) viewAfter=(\d+) printBefore=(\d+) printAfter=(\d+)/.exec(first);
  if (!pixels || Number(pixels[2]) <= Number(pixels[1]) || Number(pixels[4]) <= Number(pixels[3])) {
    throw new Error(`${type} (${engine}): edited field not drawn: ${first}`);
  }
  const reopened = await set(saved);
  if (!reopened.includes(`before='${value}'`)) throw new Error(`${type} (${engine}) saved: ${reopened}`);
  console.log(`${type} (${engine}): saved ${value}`);
}

export async function testit(): Promise<void> {
  for (const engine of ["mupdf", "pdfium"]) {
    await check("text", engine);
    await check("choice", engine);
  }
}

if (import.meta.main) await runStandalone(testit);
