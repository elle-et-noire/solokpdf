import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { makePushButtonPdf } from "./issue-1914.ts";
import { testit as jsMenus } from "./issue-1198.ts";
import { testit as contents } from "./issue-1724.ts";
import { testit as wrappedUrls } from "./issue-2239.ts";
import { EXE, runStandalone, tmpPath } from "./util.ts";

const kInvisible = 1;
const kHidden = 2;
const kPrint = 4;
const kNoView = 32;

export async function testit(): Promise<void> {
  await jsMenus();
  await contents();
  await wrappedUrls();

  const pdf = tmpPath("ad-hoc-pdfium-button-link.pdf");
  writeFileSync(pdf, makePushButtonPdf());
  await withControlledSumatra(EXE, async (client) => {
    const res = await client.request(ControlCommand.TestPageLinks, [pdf, 1]);
    const links = String(res[1] ?? "");
    if (res[0] !== 0 || !/^kind=\S+ page=2\b/m.test(links)) {
      throw new Error(`button link missing:\n${links}`);
    }

    const overlap = tmpPath("ad-hoc-pdfium-button-overlap.pdf");
    writeFileSync(overlap, makePushButtonPdf({ overlap: true }));
    const result = await client.request(ControlCommand.TestPageLinks, [overlap, 1]);
    const pages = [...String(result[1]).matchAll(/^kind=\S+ page=(\d+)/gm)].map((m) => Number(m[1]));
    if (result[0] !== 0 || pages.join() !== "2,1")
      throw new Error(`overlapping /Link does not win hit testing:\n${result[1]}`);

    for (const [name, flags] of [
      ["hidden", kPrint | kHidden],
      ["no-view", kPrint | kNoView],
      ["invisible", kPrint | kInvisible],
    ] as const) {
      const hidden = tmpPath(`ad-hoc-pdfium-button-${name}.pdf`);
      writeFileSync(hidden, makePushButtonPdf({ flags }));
      const result = await client.request(ControlCommand.TestPageLinks, [hidden, 1]);
      if (result[0] === 0 || /^kind=/m.test(String(result[1])))
        throw new Error(`${name} button became a link:\n${result[1]}`);
    }
  });
}

if (import.meta.main) {
  await runStandalone(testit);
}
