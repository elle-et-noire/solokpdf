// Opt-in PDFium check: Unsupported Features lists only what a document uses and PDFium can't do
// (empty for a plain paper). Build with solok-build.ts, then use --no-build.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

const stream = (s: string, dict = "") => `<< ${dict} /Length ${s.length} >>\nstream\n${s}\nendstream`;
const kText = "BT /F1 24 Tf 72 700 Td (Hello) Tj ET";

function plainPdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    stream(kText),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

// a text field, a signed signature field, document JavaScript and an embedded file; `xfa` adds /XFA
function featuresPdf(xfa: boolean): string {
  const xfaEntry = xfa ? "/XFA 11 0 R" : "";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R 7 0 R] " +
      xfaEntry +
      " >> /Names << /JavaScript << /Names [(js) 8 0 R] >> /EmbeddedFiles << /Names [(a.txt) 9 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R 7 0 R] >>",
    stream(kText),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [72 600 300 630] /P 3 0 R >>",
    "<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [0 0 0 0] /P 3 0 R " +
      "/V << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0 0 0] /Contents <00> >> >>",
    "<< /S /JavaScript /JS (app.alert\\(1\\)) >>",
    "<< /Type /Filespec /F (a.txt) /EF << /F 10 0 R >> >>",
    stream("hello", "/Type /EmbeddedFile"),
    stream("<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'/>"),
  ]);
}

async function unsupported(name: string, pdf: string): Promise<string> {
  const dir = tmpPath(`pdfium-unsupported/${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.pdf`);
  writeFileSync(path, pdf, "latin1");
  return withControlledSumatra(
    EXE,
    async (client) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const res = await client.request(ControlCommand.TestDocumentProperties);
        const raw = String(res[1] ?? "");
        if (res[0] === 0) {
          const line = raw.split(/\r?\n/).find((l) => l.startsWith("unsupportedFeatures="));
          return line ? line.slice("unsupportedFeatures=".length) : "";
        }
        if (res[0] !== 2 || Date.now() > deadline) throw new Error(`${name}: properties: ${raw.trim()}`);
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    ["-appdata", dir, path],
  );
}

export async function testit(): Promise<void> {
  const cases: [string, string, string][] = [
    ["plain", plainPdf(), ""],
    ["features", featuresPdf(false), "form filling, JavaScript, signature verification, embedded files"],
    ["xfa", featuresPdf(true), "XFA, JavaScript, signature verification, embedded files"],
  ];
  const failures: string[] = [];
  for (const [name, pdf, want] of cases) {
    const got = await unsupported(name, pdf);
    console.log(`${name}: "${got}"`);
    if (got !== want) failures.push(`${name}: want "${want}", got "${got}"`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
