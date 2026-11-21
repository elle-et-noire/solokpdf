import { writeFileSync } from "node:fs";
import { ControlClient, ControlCommand, withControlledSumatra } from "./control.ts";
import { testit as fitVisible } from "./issue-6241.ts";
import { assemblePdf, cmdId, EXE, pollUntil, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import { sendCommandSync, waitForFrame } from "./win-automation.ts";

async function zoomReal(client: ControlClient): Promise<number> {
  const [status, result] = await client.request(ControlCommand.TestDisplayMode, ["zoom-real"]);
  const zoom = /zoomReal=([\d.]+)/.exec(String(result));
  if (status !== 0 || !zoom) throw new Error(`Fit Visible zoom: ${result}`);
  return Number(zoom[1]);
}

async function fitAfterRedaction(engine: string): Promise<void> {
  const pdf = tmpPath(`fit-visible-redaction-${engine}.pdf`);
  const contentLeft = 200;
  const contentWidth = 153;
  const redactLeft = 10;
  const totalPadding = 4;
  const appliedRatio = (contentWidth + totalPadding) / (contentLeft + contentWidth - redactLeft + totalPadding);
  const content = `0 g ${contentLeft} 300 ${contentWidth} 300 re f`;
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Type /Annot /Subtype /Redact /P 3 0 R /F 2 /Rect [${redactLeft} 320 60 370] >>`,
    ]),
  );

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      const frame = await waitForFrame(proc.pid!);
      await pollUntil(
        async () => String((await client.request(ControlCommand.TestMarkupAnnots, []))[1]),
        (state) => /annotations=1\b/.test(state),
        { error: (state) => `${engine}: redaction mark was not loaded: ${state}` },
      );
      const before = await zoomReal(client);
      for (const [cmd, ratio, marks] of [
        ["CmdApplyRedactions", appliedRatio, 0],
        ["CmdUndo", 1, 1],
        ["CmdRedo", appliedRatio, 0],
      ] as const) {
        sendCommandSync(frame, cmdId(cmd));
        const [, state] = await client.request(ControlCommand.TestMarkupAnnots, []);
        if (!String(state).includes(`annotations=${marks}\n`)) throw new Error(`${engine} ${cmd}: ${state}`);
        const zoom = await zoomReal(client);
        if (Math.abs(zoom / before - ratio) > 0.05) {
          throw new Error(`${engine} ${cmd}: Fit Visible zoom ${before} -> ${zoom}, expected ratio ${ratio}`);
        }
      }
    },
    [
      "-appdata",
      writeAppdata(`fit-visible-redaction-${engine}`, ""),
      "-view",
      "single page",
      "-zoom",
      "fit visible",
      pdf,
    ],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  const previous = process.env.SOLOKPDF_ENGINE;
  try {
    process.env.SOLOKPDF_ENGINE = "pdfium";
    await fitVisible();
    await fitAfterRedaction("pdfium");
    await fitAfterRedaction("mupdf");
  } finally {
    if (previous === undefined) delete process.env.SOLOKPDF_ENGINE;
    else process.env.SOLOKPDF_ENGINE = previous;
  }
}

if (import.meta.main) await runStandalone(testit);
