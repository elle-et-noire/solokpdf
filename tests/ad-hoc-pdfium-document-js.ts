// The PDF source is assembled here so its document script and form field stay editable.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

function documentJsPdf(includeJs = true): string {
  const names = includeJs ? "/Names << /JavaScript << /Names [(init) 6 0 R] >> >>" : "";
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> ${names} >>`,
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 300 500 350] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    '<< /S /JavaScript /JS (this.getField\\("name"\\).value = "scripted";) >>',
  ]);
}

async function check(engine: string, disableJs: boolean, includeJs = true): Promise<number> {
  const dir = tmpPath(`pdfium-document-js/${engine}-${disableJs}-${includeJs}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "document-js.pdf");
  writeFileSync(path, documentJsPdf(includeJs), "latin1");
  writeFileSync(join(dir, "SolokPDF-settings.txt"), `DisableJavaScript = ${disableJs}\n`);

  return withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const initial = await client.request(ControlCommand.TestDocumentJsOpen, [path, 1, 0]);
      const before = String(initial[1]);
      const want = disableJs || !includeJs ? "" : "scripted";
      const shouldLoad = engine === "mupdf" || (includeJs && !disableJs);
      let pixels = 0;
      if (shouldLoad) {
        const match = /view=(\d+) print=(\d+)/.exec(before);
        if (initial[0] !== 0 || !before.includes(`value='${want}'`) || !match) {
          throw new Error(`${engine} disableJs=${disableJs} includeJs=${includeJs}: initial ${before}`);
        }
        pixels = Number(match[1]);
      } else if (initial[0] !== 0 || before !== "NOTLOADED") {
        throw new Error(`${engine} disableJs=${disableJs} includeJs=${includeJs}: initial ${before}`);
      }
      const res = await client.request(ControlCommand.TestSetFormField, [1, 0, "probe"]);
      const result = String(res[1]);
      if (res[0] !== 0 || !result.includes(`before='${want}'`)) {
        throw new Error(`${engine} disableJs=${disableJs}: ${result}`);
      }
      await client.resolveUnsavedChanges("discard");
      return pixels;
    },
    ["-appdata", dir, path],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  for (const engine of ["mupdf", "pdfium"]) {
    const enabled = await check(engine, false);
    const disabled = await check(engine, true);
    if (enabled <= disabled) throw new Error(`${engine}: script value not drawn: ${enabled} <= ${disabled}`);
    console.log(`${engine}: document script initialized and drew the field; DisableJavaScript stopped it`);
  }
  const plain = await check("pdfium", false, false);
  const plainDisabled = await check("pdfium", true, false);
  if (plain !== plainDisabled) throw new Error(`pdfium: no-script render changed: ${plain} != ${plainDisabled}`);
}

if (import.meta.main) await runStandalone(testit);
