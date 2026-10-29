import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, pollUntil, runStandalone, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";

const stream = (data: string) => `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;
const DER_SEQUENCE = 0x30;
const DER_SET = 0x31;
const DER_OCTET_STRING = 0x04;
const DER_CONTEXT_0 = 0xa0;
const DER_LONG_LENGTH_1 = 0x81;
const DER_LONG_LENGTH_2 = 0x82;
const PKCS7_DATA_OID = "06092a864886f70d010701";
const PKCS7_SIGNED_DATA_OID = "06092a864886f70d010702";
const DER_SIGNED_DATA_VERSION = Buffer.from([0x02, 0x01, 0x01]);
const DER_EMPTY_SET = Buffer.from([DER_SET, 0x00]);

function innerPdf(): string {
  const content = "BT /F1 20 Tf 40 300 Td (Memory needle) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [8 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(content),
    "<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>",
    "<< /Title (Memory chapter) /Parent 6 0 R /Dest [3 0 R /Fit] >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 260 180 280] /A << /S /URI /URI (https://example.com/memory) >> >>",
  ]);
}

function outerPdf(inner: string): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /FileAttachment /P 3 0 R /Rect [100 100 200 200] /FS 5 0 R /Name /PushPin >>",
    "<< /Type /Filespec /F (inner.pdf) /UF (inner.pdf) /EF << /F 6 0 R >> >>",
    stream(inner).replace("<< /Length", "<< /Type /EmbeddedFile /Length"),
  ]);
}

function der(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const length =
    n < 128
      ? Buffer.from([n])
      : n < 256
        ? Buffer.from([DER_LONG_LENGTH_1, n])
        : Buffer.from([DER_LONG_LENGTH_2, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

function p7m(pdf: string): Buffer {
  const dataOid = Buffer.from(PKCS7_DATA_OID, "hex");
  const signedOid = Buffer.from(PKCS7_SIGNED_DATA_OID, "hex");
  const encapsulated = der(
    DER_SEQUENCE,
    Buffer.concat([dataOid, der(DER_CONTEXT_0, der(DER_OCTET_STRING, Buffer.from(pdf, "latin1")))]),
  );
  const signed = der(
    DER_SEQUENCE,
    Buffer.concat([DER_SIGNED_DATA_VERSION, DER_EMPTY_SET, encapsulated, DER_EMPTY_SET]),
  );
  return der(DER_SEQUENCE, Buffer.concat([signedOid, der(DER_CONTEXT_0, signed)]));
}

async function inspect(path: string, engine: string, attachment: boolean, saved?: string): Promise<string> {
  return withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      if (attachment) {
        await pollUntil(
          () => client.request(ControlCommand.TestMarkupAnnots, ["open-embedded", 0, 0]),
          (r) => r[0] === 0 && String(r[1]).includes("OK"),
          { timeoutMs: 8000 * SLOW_BUILD_FACTOR, error: (r) => `attachment open: ${r[1]}` },
        );
        await client.waitForRenderIdle();
      }
      const result = await client.request(ControlCommand.TestCurrentPdf, ["Memory needle"]);
      if (result[0] !== 0) throw new Error(`current PDF: ${result[1]}`);
      const info = await client.request(ControlCommand.TestPageInfo);
      if (info[0] !== 0 || !String(info[1]).includes("pages=1")) throw new Error(`page render: ${info[1]}`);
      if (saved) {
        const save = await client.request(ControlCommand.TestSaveFileAs, [saved]);
        if (save[0] !== 0) throw new Error(`Save As: ${save[1]}`);
      }
      return String(result[1]);
    },
    [path],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  const dir = tmpPath("pdfium-memory");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = innerPdf();
  const outer = join(dir, "outer.pdf");
  const signed = join(dir, "wrapped.p7m");
  writeFileSync(outer, outerPdf(pdf), "latin1");
  writeFileSync(signed, p7m(pdf));

  for (const [name, path, attachment] of [
    ["attachment", outer, true],
    ["p7m", signed, false],
  ] as const) {
    const mupdf = await inspect(path, "mupdf", attachment);
    const saved = join(dir, `${name}-saved.pdf`);
    const pdfium = await inspect(path, "pdfium", attachment, saved);
    if (!readFileSync(saved).equals(Buffer.from(pdf, "latin1"))) {
      throw new Error(`${name}: Save As did not write the embedded PDF`);
    }
    if (!mupdf.includes("engine=enginePdf ") || !pdfium.includes("engine=enginePdfium")) {
      throw new Error(`${name}: wrong engine: MuPDF ${mupdf}; PDFium ${pdfium}`);
    }
    for (const report of [mupdf, pdfium]) {
      if (
        !report.includes("pages=1 found=1") ||
        !report.includes("Memory needle") ||
        !report.includes("toc=Memory chapter tocPage=1") ||
        !report.includes("link=https://example.com/memory")
      ) {
        throw new Error(`${name}: document features: ${report}`);
      }
    }
    const normalizedMu = mupdf.replace("engine=enginePdf", "").replace(/\s+/g, " ").trim();
    const normalizedPdfium = pdfium.replace("engine=enginePdfium", "").replace(/\s+/g, " ").trim();
    if (normalizedMu !== normalizedPdfium) {
      throw new Error(`${name}: PDFium differs from MuPDF: ${mupdf}; ${pdfium}`);
    }
    console.log(`${name}: PDFium renders, searches and matches MuPDF links/outline`);
  }
}

if (import.meta.main) await runStandalone(testit);
