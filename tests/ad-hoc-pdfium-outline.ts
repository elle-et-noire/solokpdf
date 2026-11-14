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

// E43: the last item's /Next loops back to the first
function loopOutlinePdf(count: number): string {
  const first = 5;
  const items = Array.from({ length: count }, (_, i) => {
    const prev = i > 0 ? ` /Prev ${first + i - 1} 0 R` : "";
    const next = ` /Next ${i + 1 < count ? first + i + 1 : first} 0 R`;
    return `<< /Title (Item ${i + 1}) /Parent 4 0 R${prev}${next} /Dest [3 0 R /Fit] >>`;
  });
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    `<< /Type /Outlines /First ${first} 0 R /Last ${first + count - 1} 0 R /Count ${count} >>`,
    ...items,
  ]);
}

export async function testit(): Promise<void> {
  const cases = [
    { name: "named", pdf: outlinePdf(false) },
    { name: "remote", pdf: outlinePdf(true) },
    { name: "loop", pdf: loopOutlinePdf(3) },
  ];
  for (const c of cases) {
    const pdf = tmpPath(`pdfium-outline-${c.name}.pdf`);
    writeFileSync(pdf, c.pdf);
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
    // MuPDF drops a looping outline; PDFium lists each item once
    if (c.name === "loop") {
      const items = reports[1].match(/^Item \d+\|/gm) ?? [];
      if (items.length !== 3) throw new Error(`loop outline has ${items.length} items: ${reports[1].slice(0, 300)}`);
      continue;
    }
    if (reports[0] !== reports[1]) throw new Error(`outline differs: ${JSON.stringify(reports)}`);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
