import { runStandalone } from "./util.ts";
import { testThemeSwitch } from "./ad-hoc-pdfium-theme.ts";

export async function testit(): Promise<void> {
  await testThemeSwitch();
}

if (import.meta.main) await runStandalone(testit);
