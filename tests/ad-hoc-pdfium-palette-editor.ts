// E68: opening the command palette lists annotations without loading the hidden MuPDF
// editor for a PDF that has none (links, widgets and fonts don't count). A PDF whose
// annotation sits in a compressed object stream still lists it.
//
// Run: bun tests/ad-hoc-pdfium-palette-editor.ts [--no-build]

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { ControlClient, ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, cmdId, EXE, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { FRAME_CLASS, paletteState, sendCommand, waitForPalette } from "./win-automation.ts";
import { sleep, waitForTopWindow } from "./winapi.ts";

const CATALOG = "<< /Type /Catalog /Pages 2 0 R >>";
const PAGES = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
const LINK = "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /A << /S /URI /URI (https://example.com/) >> >>";
const NOTE = "<< /Type /Annot /Subtype /Text /Rect [72 600 92 620] /Contents (palette-note) >>";

// A link and a Type1 font: /Annots and /Subtype are present, but no annotation the palette lists.
function linkOnlyPdf(): string {
  const content = "BT /F1 12 Tf 72 706 Td (link) Tj ET";
  return assemblePdf([
    CATALOG,
    PAGES,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    LINK,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

// The note (object 4) is compressed in object stream 6, so a plain byte scan can't see it.
function compressedNotePdf(): Buffer {
  const compressed = deflateSync(Buffer.from(`4 0 ${NOTE}`, "latin1"));
  const chunks: Buffer[] = [];
  const offsets = new Array<number>(8).fill(0);
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
  object(1, CATALOG);
  object(2, PAGES);
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R] >>");
  object(5, LINK);
  object(
    6,
    Buffer.concat([
      Buffer.from(`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
      compressed,
      Buffer.from("\nendstream"),
    ]),
  );
  const xrefStart = length;
  offsets[7] = xrefStart;
  const xref = Buffer.alloc(8 * 7);
  for (let i = 0; i < 8; i++) {
    const at = i * 7;
    xref[at] = i === 0 ? 0 : i === 4 ? 2 : 1;
    xref.writeUInt32BE(i === 4 ? 6 : offsets[i]!, at + 1);
    xref.writeUInt16BE(i === 0 ? 65535 : 0, at + 5);
  }
  object(
    7,
    Buffer.concat([
      Buffer.from(`<< /Type /XRef /Size 8 /Root 1 0 R /W [1 4 2] /Length ${xref.length} >>\nstream\n`),
      xref,
      Buffer.from("\nendstream"),
    ]),
  );
  add(`startxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

async function editorState(client: ControlClient): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
  return String(res[1]);
}

async function check(dir: string, name: string, pdf: string | Buffer, annots: number): Promise<void> {
  const path = join(dir, `${name}.pdf`);
  writeFileSync(path, pdf, "latin1");
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      if ((await editorState(client)) !== "editor=none") throw new Error(`${name}: editor loaded at open`);
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS, 5000);
      sendCommand(frame, cmdId("CmdCommandPalette"));
      await waitForPalette(client, frame);

      // annotations arrive from a background load; wait for them, or briefly for none
      const deadline = Date.now() + (annots > 0 ? 8000 : 1000);
      let state = await paletteState(client);
      while (state.annots < annots && Date.now() < deadline) {
        await sleep(50);
        state = await paletteState(client);
      }
      if (annots === 0) {
        await client.waitForRenderIdle();
        state = await paletteState(client);
      }
      if (state.annots !== annots) throw new Error(`${name}: palette annots=${state.annots}, want ${annots}`);
      const editor = await editorState(client);
      const want = annots > 0 ? "editor=loaded" : "editor=none";
      if (editor !== want) throw new Error(`${name}: ${editor} after opening the palette, want ${want}`);
      console.log(`${name}: annots=${state.annots} ${editor} OK`);
    },
    ["-appdata", dir, path],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

export async function testit(): Promise<void> {
  const dir = tmpPath("pdfium-palette-editor");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = false\n",
  );
  await check(dir, "links", linkOnlyPdf(), 0);
  await check(dir, "compressed-note", compressedNotePdf(), 1);
}

if (import.meta.main) await runStandalone(testit);
