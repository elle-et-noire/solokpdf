import { writeFileSync } from "node:fs";
import { ControlCommand, type ControlClient, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";
import { findCanvas, FRAME_CLASS } from "./win-automation.ts";
import { packCoords, postMessage, sendCopyDataW, waitForTopWindow, WM_MOUSEMOVE } from "./winapi.ts";

const OPEN_DATA_ID = 0x44646557;

async function hover(client: ControlClient, canvas: number, x: number, y: number, tip?: string): Promise<void> {
  const point = await client.request(ControlCommand.TestCurrentPdf, ["widget-cursor", 1, x, y]);
  if (tip && !String(point[1]).includes(`tip=${tip} `)) throw new Error(`missing tooltip: ${point}`);
  const match = /pt=(-?\d+),(-?\d+)$/.exec(String(point[1]));
  if (point[0] !== 0 || !match) throw new Error(`hover point: ${point}`);
  postMessage(canvas, WM_MOUSEMOVE, 0, packCoords(Number(match[1]), Number(match[2])));
  await client.waitForRenderIdle();
  const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
  if (editor[1] !== "editor=none") throw new Error(`hover at ${x},${y} loaded editor: ${editor[1]}`);
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-annotation-link.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R] >>",
      "<< /Type /Annot /Subtype /Text /Rect [72 700 90 718] /Contents (PDFium note) >>",
      "<< /Type /Annot /Subtype /Link /Rect [120 700 180 718] /A << /S /URI /URI (https://example.com/) >> >>",
    ]),
  );

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.request(ControlCommand.TestCursorPosition, [0, 0]);
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS, 5000);
      const canvas = findCanvas(frame);
      if (!canvas) throw new Error("canvas missing");
      if (!sendCopyDataW(frame, OPEN_DATA_ID, `[Open("${pdf}", 0, 1, 0)]`)) throw new Error("open failed");
      await client.waitForRenderIdle();
      const before = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (before[1] !== "editor=none") throw new Error(`page render loaded editor: ${before[1]}`);

      await hover(client, canvas, 81, 83, "PDFium note");
      await hover(client, canvas, 150, 83);

      const [, comments] = await client.request(ControlCommand.TestPageComments, [pdf, 1]);
      if (!String(comments).includes("comment=PDFium note")) throw new Error(`comment missing: ${comments}`);

      await client.request(ControlCommand.TestCurrentPdf, [""]);
      const after = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (after[1] !== "editor=loaded") throw new Error(`annotation query skipped editor: ${after[1]}`);
      await client.request(ControlCommand.TestCursorPosition);
    },
    [],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

if (import.meta.main) await runStandalone(testit);
