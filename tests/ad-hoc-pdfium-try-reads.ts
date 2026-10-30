// Non-blocking reads on PDFium tabs never load the MuPDF editor (B51): paint's link outlines,
// link following and hover call them on the UI thread. Pages whose blocking reads need the
// editor: a comment annotation (MuPDF elements), a file attachment and a form field's text.
// The tab shows a blank page 4: hovering an annotated page loads the editor by design.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

const kTag = "ad-hoc-pdfium-try-reads";
const kField = "FIELDVALUE";

function makePdf(): string {
  const content = "BT /F1 24 Tf 72 700 Td (HELLO WORLD) Tj ET";
  const ap = `/Tx BMC BT /Helv 12 Tf 2 10 Td (${kField}) Tj ET EMC`;
  const page = (annots: string) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> ` +
    `/Contents 7 0 R /Annots [${annots}] >>`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [12 0 R] /DA (/Helv 12 Tf 0 g) " +
      "/DR << /Font << /Helv 6 0 R >> >> >> >>",
    "<< /Type /Pages /Count 4 /Kids [3 0 R 4 0 R 5 0 R 14 0 R] >>",
    page("9 0 R 10 0 R"),
    page("11 0 R"),
    page("12 0 R"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /EmbeddedFile /Length 5 >>\nstream\nhello\nendstream",
    "<< /Type /Annot /Subtype /Link /Rect [72 690 300 730] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>",
    "<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (note) >>",
    "<< /Type /Annot /Subtype /FileAttachment /Rect [100 500 120 520] /Contents (att) " +
      "/FS << /Type /Filespec /F (a.txt) /EF << /F 8 0 R >> >> >>",
    "<< /Type /Annot /Subtype /Widget /F 4 /P 5 0 R /FT /Tx /T (name) " +
      `/V (${kField}) /DA (/Helv 12 Tf 0 g) /Rect [72 600 300 630] /AP << /N 13 0 R >> >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 228 30] /Resources << /Font << /Helv 6 0 R >> >> ` +
      `/Length ${ap.length} >>\nstream\n${ap}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ]);
}

async function query(client: ControlClient, args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(`${kTag}: ${args.join(" ")}: ${String(res[1])}`);
  return String(res[1]);
}

async function expectNoEditor(client: ControlClient, what: string): Promise<void> {
  const editor = await query(client, ["editor"]);
  if (editor !== "editor=none") throw new Error(`${kTag}: ${what} loaded the MuPDF editor`);
}

function field(res: string, name: string): number {
  const m = new RegExp(`\\b${name}=(-?\\d+)`).exec(res);
  if (!m) throw new Error(`${kTag}: no ${name} in ${res}`);
  return Number(m[1]);
}

export async function testit(): Promise<void> {
  const dir = tmpPath(kTag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "try.pdf");
  writeFileSync(pdf, makePdf(), "latin1");

  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.setNotificationsEnabled(false);
      await client.waitForRenderIdle();
      await expectNoEditor(client, "opening");

      // elements: PDFium's own until the editor is loaded; the link is there
      const links: number[] = [];
      for (const page of [1, 2, 3]) {
        const res = await query(client, ["try-elements", page]);
        await expectNoEditor(client, `try-elements ${page}`);
        if (field(res, "ok") !== 1) throw new Error(`${kTag}: try-elements ${page} on an idle page: ${res}`);
        links.push(field(res, "links"));
      }
      if (links[0] !== 1) throw new Error(`${kTag}: page 1 link missing: ${links}`);

      // text: plain pages come from PDFium; the form page's needs the editor, so a Try call
      // declines rather than store partial text a blocking read must extract again
      const plain = await query(client, ["try-text", 1]);
      if (field(plain, "ok") !== 1 || field(plain, "chars") < 10 || field(plain, "partial") !== 0) {
        throw new Error(`${kTag}: try-text 1: ${plain}`);
      }
      const form = await query(client, ["try-text", 3]);
      await expectNoEditor(client, "try-text on the form page");
      if (field(form, "ok") !== 0) throw new Error(`${kTag}: try-text 3 without the editor: ${form}`);

      // a blocking read loads the editor; then Try calls answer from it without blocking
      const full = await query(client, ["text-page", 3]);
      if ((await query(client, ["editor"])) !== "editor=loaded") throw new Error(`${kTag}: text-page didn't load it`);
      const after = await query(client, ["try-text", 3]);
      if (field(after, "ok") !== 1 || field(after, "partial") !== 0 || field(after, "chars") !== field(full, "chars")) {
        throw new Error(`${kTag}: try-text 3 with the editor: ${after}, blocking ${full}`);
      }
      const els = await query(client, ["try-elements", 1]);
      if (field(els, "ok") !== 1 || field(els, "links") !== links[0]) {
        throw new Error(`${kTag}: try-elements 1 with the editor: ${els}`);
      }
      console.log(`${kTag}: OK (links ${links}, form text ${full})`);
    },
    ["-appdata", dir, "-view", "single page", "-page", "4", pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

if (import.meta.main) await runStandalone(testit);
