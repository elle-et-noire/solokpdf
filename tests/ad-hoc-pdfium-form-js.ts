// A calculated AcroForm value survives an edit and incremental save in both engines.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

function formPdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] /CO [5 0 R] /DR << /Font << /Helv 6 0 R >> >> >> >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R 5 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (input) /Rect [100 400 500 450] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>",
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (total) /Rect [100 300 500 350] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) /AA << /C << /S /JavaScript /JS (event.value = Number(this.getField\\("input"\\).value) * 2;) >> >> >>',
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

async function check(engine: string): Promise<void> {
  const dir = tmpPath(`pdfium-form-js/${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  const saved = join(dir, "saved.pdf");
  writeFileSync(source, formPdf(), "latin1");

  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const res = await client.request(ControlCommand.TestSetFormField, [1, 0, "7"]);
      if (res[0] !== 0) throw new Error(`${engine}: edit: ${String(res[1])}`);
      await client.resolveUnsavedChanges("save-as", saved);
    },
    ["-appdata", dir, source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );

  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const res = await client.request(ControlCommand.TestSetFormField, [1, 1, "probe"]);
      const result = String(res[1]);
      if (res[0] !== 0 || !result.includes("before='14'")) {
        throw new Error(`${engine}: calculated value after reopen: ${result}`);
      }
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, saved],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
  console.log(`${engine}: calculated 14 and saved`);
}

export async function testit(): Promise<void> {
  for (const engine of ["mupdf", "pdfium"]) await check(engine);
}

if (import.meta.main) await runStandalone(testit);
