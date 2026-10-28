import { ControlCommand, withControlledSumatra } from "./control.ts";
import { writeFileSync } from "node:fs";
import { EXE, makeBlankPdf, runStandalone, tmpPath } from "./util.ts";

const commands = [
  "CmdPdfShowInfo",
  "CmdPdfBake",
  "CmdPdfCompress",
  "CmdPdfDecompress",
  "CmdPdfEncrypt",
  "CmdPdfExtractPages",
  "CmdPdfDeletePages",
  "CmdMergePDF",
  "CmdRunPDFScript",
  "CmdConvertPdfToImages",
  "CmdDocumentExtractText",
];

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-tools.pdf");
  writeFileSync(pdf, makeBlankPdf(2));
  for (const engine of ["pdfium", "mupdf"]) {
    await withControlledSumatra(
      EXE,
      async (client) => {
        await client.waitForRenderIdle();
        for (const command of commands) {
          const res = await client.request(ControlCommand.TestCommandVisibility, [command, "menu"]);
          const raw = String(res[1] ?? "");
          if (res[0] !== 0 || !raw.includes("vis=show")) {
            throw new Error(`${engine}: ${command}: ${raw}`);
          }
        }
      },
      [pdf],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
