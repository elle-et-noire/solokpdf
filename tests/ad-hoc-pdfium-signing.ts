// Sign and certify through each PDF engine, then reopen and verify the result.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { verifyPdfSignature, writeTestPfx } from "./pki.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

const kPassword = "solokpdf-test-pw";

async function check(engine: string, certify: number): Promise<void> {
  const dir = tmpPath(`pdfium-signing/${engine}-${certify}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.pdf");
  const signed = join(dir, "signed.pdf");
  const pfx = join(dir, "signer.pfx");
  const cert = writeTestPfx(pfx, "SolokPDF SigningTest", kPassword);
  const pdf = assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ]);
  writeFileSync(source, pdf, "latin1");

  const env = { ...process.env, SOLOKPDF_ENGINE: engine };
  await withControlledSumatra(
    EXE,
    async (client) => {
      const res = await client.request(ControlCommand.TestSignDocument, [
        source,
        signed,
        "",
        pfx,
        kPassword,
        "",
        -1,
        certify,
        0,
      ]);
      if (res[0] !== 0 || !/ok=1/.test(String(res[1]))) {
        throw new Error(`${engine} certify=${certify}: ${String(res[1])}`);
      }
    },
    ["-appdata", dir, source],
    { env },
  );

  verifyPdfSignature(signed, cert);
  const appended = readFileSync(signed).subarray(Buffer.byteLength(pdf, "latin1")).toString("latin1");
  if (certify && !/\/TransformMethod\s*\/DocMDP/.test(appended)) {
    throw new Error(`${engine}: missing certification transform`);
  }

  await withControlledSumatra(
    EXE,
    async (client) => {
      const res = await client.request(ControlCommand.TestDocumentSignatures);
      const text = String(res[1]);
      if (res[0] !== 0 || !text.includes("Signature 1") || !text.includes("wasn't changed")) {
        throw new Error(`${engine}: signed file did not reopen and verify: ${text}`);
      }
    },
    ["-appdata", dir, signed],
    { env },
  );
  console.log(`${engine} certify=${certify}: signed and reopened`);
}

export async function testit(): Promise<void> {
  for (const engine of ["mupdf", "pdfium"]) {
    await check(engine, 0);
    await check(engine, 1);
  }
}

if (import.meta.main) await runStandalone(testit);
