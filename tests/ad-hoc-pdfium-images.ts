import { testit as cmykSave } from "./cmyk-image-save.ts";
import { testit as orientation } from "./issue-6214.ts";
import { runStandalone } from "./util.ts";

export async function testit(): Promise<void> {
  await cmykSave();
  await orientation();
}

if (import.meta.main) {
  await runStandalone(testit);
}
