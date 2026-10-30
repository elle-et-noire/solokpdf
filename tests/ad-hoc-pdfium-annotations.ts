import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";
import { getCursorPos, setCursorPos } from "./winapi.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-annotation-link.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] >>",
      "<< /Type /Annot /Subtype /Text /Rect [72 700 90 718] /Contents (PDFium note) >>",
    ]),
  );

  const cursor = getCursorPos();
  const parked = setCursorPos(0, 0);
  try {
    await withControlledSumatra(
      EXE,
      async (client) => {
        await client.waitForRenderIdle();
        const before = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
        if (before[1] !== "editor=none") throw new Error(`page render loaded editor: ${before[1]}`);

        const [, comments] = await client.request(ControlCommand.TestPageComments, [pdf, 1]);
        if (!String(comments).includes("comment=PDFium note")) throw new Error(`comment missing: ${comments}`);

        await client.request(ControlCommand.TestCurrentPdf, [""]);
        const after = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
        if (after[1] !== "editor=loaded") throw new Error(`annotation query skipped editor: ${after[1]}`);
      },
      [pdf],
      { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
    );
  } finally {
    if (parked) setCursorPos(cursor.x, cursor.y);
  }
}

if (import.meta.main) await runStandalone(testit);
