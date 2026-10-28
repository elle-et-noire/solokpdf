// PDFium and MuPDF show the same verification result for signed PDFs.
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { EXE, ROOT, runStandalone } from "./util.ts";

async function signaturesOf(path: string, engine: string): Promise<string> {
  return withControlledSumatra(
    EXE,
    async (client) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const res = await client.request(ControlCommand.TestDocumentSignatures);
        const raw = String(res[1] ?? "");
        if (res[0] === 0) return raw;
        if (res[0] !== 2 || Date.now() > deadline) throw new Error(`${engine}: ${raw.trim()}`);
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    [path],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  const dir = join(ROOT, "tests", "issue-5581-data");
  for (const name of ["test_sign_PAdES_B-T.pdf", "test_sign_PAdES_B-LTA.pdf"]) {
    const path = join(dir, name);
    const mupdf = await signaturesOf(path, "mupdf");
    const pdfium = await signaturesOf(path, "pdfium");
    if (!mupdf.includes("Signature 1")) throw new Error(`${name}: no MuPDF signature`);
    if (pdfium !== mupdf) throw new Error(`${name}: PDFium verification differs from MuPDF`);
    console.log(`${name}: verification matches`);
  }
}

if (import.meta.main) await runStandalone(testit);
