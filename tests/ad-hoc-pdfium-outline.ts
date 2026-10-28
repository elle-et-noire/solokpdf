import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

function outlinePdf(remote: boolean): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    "<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 3 >>",
    "<< /Title (Page two) /Parent 5 0 R /Next 7 0 R /Dest [4 0 R /Fit] >>",
    "<< /Title (Named action) /Parent 5 0 R /Prev 6 0 R /Next 8 0 R /A << /S /Named /N /NextPage >> >>",
    remote
      ? "<< /Title (Remote) /Parent 5 0 R /Prev 7 0 R /A << /S /GoToR /F (target.pdf) /D (chapter) >> >>"
      : "<< /Title (Page two again) /Parent 5 0 R /Prev 7 0 R /Dest [4 0 R /Fit] >>",
  ]);
}

export async function testit(): Promise<void> {
  for (const remote of [false, true]) {
    const pdf = tmpPath(`pdfium-outline-${remote ? "remote" : "named"}.pdf`);
    writeFileSync(pdf, outlinePdf(remote));
    const reports: string[] = [];
    for (const engine of ["mupdf", "pdfium"]) {
      const report = await withControlledSumatra(
        EXE,
        async (client) => {
          await client.waitForRenderIdle();
          const toc = await client.request(ControlCommand.TestGetToc, [pdf]);
          const named = await client.request(ControlCommand.TestDest, [pdf, 2]);
          const third = await client.request(ControlCommand.TestDest, [pdf, 3]);
          return [toc[1], named[1], third[1]].join("\n");
        },
        [pdf],
        { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
      );
      reports.push(report);
    }
    if (reports[0] !== reports[1]) throw new Error(`outline differs: ${JSON.stringify(reports)}`);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
