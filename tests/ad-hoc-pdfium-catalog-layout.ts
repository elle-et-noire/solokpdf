import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";

const CATALOG =
  "<< /Type /Catalog /Pages 2 0 R /PageLayout /TwoColumnRight /ViewerPreferences << /Direction /R2L >> >>";
const PAGES = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>";
const PAGE = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>";
const QUERY_LOG = "PDFium: catalog query";

// The catalog (object 1) is compressed in object stream 5, so a plain byte scan can't see its keys.
function compressedCatalogPdf(): Buffer {
  const compressed = deflateSync(Buffer.from(`1 0 ${CATALOG}`, "latin1"));
  const chunks: Buffer[] = [];
  const offsets = new Array<number>(7).fill(0);
  let length = 0;
  function add(data: string | Buffer): void {
    const buf = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    chunks.push(buf);
    length += buf.length;
  }
  function object(id: number, data: string | Buffer): void {
    offsets[id] = length;
    add(`${id} 0 obj\n`);
    add(data);
    add("\nendobj\n");
  }
  add("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n");
  object(2, PAGES);
  object(3, PAGE);
  object(4, PAGE);
  object(
    5,
    Buffer.concat([
      Buffer.from(`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
      compressed,
      Buffer.from("\nendstream"),
    ]),
  );
  const xrefStart = length;
  offsets[6] = xrefStart;
  const xref = Buffer.alloc(7 * 7);
  for (let i = 0; i < 7; i++) {
    const at = i * 7;
    xref[at] = i === 0 ? 0 : i === 1 ? 2 : 1;
    xref.writeUInt32BE(i === 1 ? 5 : offsets[i]!, at + 1);
    xref.writeUInt16BE(i === 0 ? 65535 : 0, at + 5);
  }
  object(
    6,
    Buffer.concat([
      Buffer.from(`<< /Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Length ${xref.length} >>\nstream\n`),
      xref,
      Buffer.from("\nendstream"),
    ]),
  );
  add(`startxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

async function openLog(dir: string, name: string, pdf: string | Buffer, catalog: boolean): Promise<void> {
  const path = join(dir, `${name}.pdf`);
  writeFileSync(path, pdf, "latin1");
  const log = join(dir, `${name}.log`);
  await withControlledSumatra(
    EXE,
    async (client) => {
      const mode = await client.request(ControlCommand.TestDisplayMode, ["get"]);
      const direction = await client.request(ControlCommand.TestDisplayMode, ["r2l"]);
      const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      const book = String(mode[1]).includes("mode=continuous book view");
      const r2l = String(direction[1]).includes("r2l=1");
      if (book !== catalog || r2l !== catalog) throw new Error(`${name} layout: ${mode[1]}, ${direction[1]}`);
      if (editor[1] !== "editor=none") throw new Error(`${name} loaded editor: ${editor[1]}`);
    },
    ["-appdata", dir, "-log-to-file", log, path],
  );
  const output = readFileSync(log, "utf8");
  if (!output.includes("PDFium 158.0.8111.0: opened")) throw new Error(`${name}: not PDFium`);
  if (output.includes(QUERY_LOG) !== catalog) throw new Error(`${name}: catalog query ran=${!catalog}`);
}

export async function testit(): Promise<void> {
  const dir = tmpPath("pdfium-catalog-layout");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = false\nDefaultDisplayMode = automatic\n",
  );
  await openLog(dir, "layout", assemblePdf([CATALOG, PAGES, PAGE, PAGE]), true);
  await openLog(dir, "compressed", compressedCatalogPdf(), true);
  // no /OpenAction, /PageLayout or /Direction: skip the MuPDF query
  await openLog(dir, "plain", assemblePdf(["<< /Type /Catalog /Pages 2 0 R >>", PAGES, PAGE, PAGE]), false);
}

if (import.meta.main) await runStandalone(testit);
