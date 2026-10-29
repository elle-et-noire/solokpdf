import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-inherited-page-boxes.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] /TrimBox [36 36 576 756] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << >> >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
    ]),
  );

  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const [, raw] = await client.request(ControlCommand.TestPageBoxes, [1]);
      if (!String(raw).includes("media=") || !String(raw).includes("trim=")) {
        throw new Error(`inherited page boxes missing: ${raw}`);
      }
      const [, directMedia] = await client.request(ControlCommand.TestPageBoxes, [2]);
      if (!String(directMedia).includes("media=") || !String(directMedia).includes("trim=")) {
        throw new Error(`inherited trim box missing: ${directMedia}`);
      }
      const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (editor[1] !== "editor=loaded") throw new Error(`inherited boxes did not load fallback: ${editor[1]}`);
    },
    [pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

if (import.meta.main) await runStandalone(testit);
