import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { findCanvas } from "./win-automation.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";
import { getClientRect, packCoords, postMessage, waitForTopWindow, WM_MOUSEMOVE } from "./winapi.ts";

const bigHeader = `%PDF-1.4\n%${"x".repeat(33 * 1024 * 1024)}\n`;

function pdf(annotation: boolean): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400]${annotation ? " /Annots [4 0 R]" : ""} >>`,
  ];
  if (annotation) {
    objects.push("<< /Type /Annot /Subtype /Text /Rect [130 180 170 220] /Contents (note) >>");
  }
  return Buffer.from(assemblePdf(objects, { header: annotation ? undefined : bigHeader }), "latin1");
}

async function check(annotation: boolean): Promise<void> {
  const dir = tmpPath(`pdfium-hover/${annotation ? "annot" : "plain"}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.pdf");
  writeFileSync(source, pdf(annotation));

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      const frame = await waitForTopWindow(proc.pid!, "SUMATRA_PDF_FRAME", 5000);
      const canvas = findCanvas(frame);
      if (!canvas) throw new Error("no canvas");
      const rect = getClientRect(canvas);
      postMessage(canvas, WM_MOUSEMOVE, 0, packCoords((rect.right - rect.left) >> 1, (rect.bottom - rect.top) >> 1));
      await client.waitForRenderIdle();
      const result = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      const want = annotation ? "editor=loaded" : "editor=none";
      if (result[0] !== 0 || result[1] !== want) throw new Error(`${want}: ${result[1]}`);
      if (!annotation) renameSync(source, join(dir, "moved.pdf"));
    },
    ["-appdata", join(dir, "settings"), "-view", "single page", "-zoom", "fit page", source],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  console.log(`${annotation ? "annotated" : "plain"}: hover editor state and rename OK`);
}

export async function testit(): Promise<void> {
  await check(false);
  await check(true);
}

if (import.meta.main) await runStandalone(testit);
