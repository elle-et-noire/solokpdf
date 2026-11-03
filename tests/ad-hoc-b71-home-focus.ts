import { testCtrlTShortcut } from "./issue-6464.ts";
import { runStandalone } from "./util.ts";

export async function testit(): Promise<void> {
  await testCtrlTShortcut();
}

if (import.meta.main) await runStandalone(testit);
