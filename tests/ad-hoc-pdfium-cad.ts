import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  for (const [engine, expected] of [
    ["pdfium", "hide"],
    ["mupdf", "show"],
  ]) {
    const dir = tmpPath(`pdfium-cad-${engine}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const pdf = join(dir, "drawing.pdf");
    writeFileSync(
      pdf,
      assemblePdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
      ]),
      "latin1",
    );
    const visibility = await withControlledSumatra(
      EXE,
      async (client) => {
        const res = await client.request(ControlCommand.TestCommandVisibility, [
          "CmdToggleEngineeringDrawingEnhance",
          "palette",
        ]);
        return /vis=(\w+)/.exec(String(res[1] ?? ""))?.[1] ?? String(res[1]);
      },
      ["-appdata", dir, pdf],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
    if (visibility !== expected) throw new Error(`${engine}: CAD command ${visibility}, want ${expected}`);
  }
}

if (import.meta.main) await runStandalone(testit);
