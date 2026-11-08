import { runStandalone } from "./util";
import { runCases } from "./ad-hoc-selection-mupdf";

export async function testit(): Promise<void> {
  await runCases(["smart-light", "smart-dark", "off", "cross-dark-off"]);
}

if (import.meta.main) await runStandalone(testit);
