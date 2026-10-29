import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { makePushButtonPdf } from "./issue-1914.ts";
import { testit as jsMenus } from "./issue-1198.ts";
import { testit as contents } from "./issue-1724.ts";
import { testit as wrappedUrls } from "./issue-2239.ts";
import { EXE, runStandalone, tmpPath } from "./util.ts";

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
  });
}

if (import.meta.main) {
  await runStandalone(testit);
}
