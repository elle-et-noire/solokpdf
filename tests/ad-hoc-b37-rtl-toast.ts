import { testit as testRtlToast } from "./issue-6113.ts";
import { runStandalone } from "./util.ts";

export async function testit(): Promise<void> {
  await testRtlToast();
}

if (import.meta.main) {
  await runStandalone(testit);
}
