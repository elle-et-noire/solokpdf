import { existsSync } from "node:fs";
import { EXE, formatDuration, prepareTestEnvironment, runTest, type NamedTest } from "./util.ts";
import { setTestWindowLayout } from "./winapi.ts";
import { testit as documentJs } from "./ad-hoc-pdfium-document-js.ts";
import { testit as formJs } from "./ad-hoc-pdfium-form-js.ts";
import { testit as forms } from "./ad-hoc-pdfium-forms.ts";
import { testit as outline } from "./ad-hoc-pdfium-outline.ts";
import { testit as permissions } from "./ad-hoc-pdfium-permissions.ts";
import { testit as tools } from "./ad-hoc-pdfium-tools.ts";
import { testit as unsupported } from "./ad-hoc-pdfium-unsupported.ts";
import { testit as vimKeys } from "./ad-hoc-vim-keys.ts";
import { testit as countPrefix } from "./ad-hoc-count-prefix.ts";
import { testit as noUpdateCheck } from "./ad-hoc-no-update-check.ts";

const tests: NamedTest[] = [
  ["ad-hoc-pdfium-forms", forms],
  ["ad-hoc-pdfium-tools", tools],
  ["ad-hoc-pdfium-outline", outline],
  ["ad-hoc-pdfium-unsupported", unsupported],
  ["ad-hoc-pdfium-permissions", permissions],
  ["ad-hoc-pdfium-form-js", formJs],
  ["ad-hoc-pdfium-document-js", documentJs],
  ["ad-hoc-vim-keys", vimKeys],
  ["ad-hoc-count-prefix", countPrefix],
  ["ad-hoc-no-update-check", noUpdateCheck],
];

// Hosted runners have no dependable cursor, certificate store, or PDF corpus.
export const excludedTests: Record<string, string> = {
  "ad-hoc-pdfium": "mouse messages and pixel checks",
  "ad-hoc-pdfium-annots": "mouse messages and screenshots",
  "ad-hoc-pdfium-fuzz": "large external corpus",
  "ad-hoc-pdfium-password": "password dialog input",
  "ad-hoc-pdfium-redactions": "GUI annotation selection",
  "ad-hoc-pdfium-session": "mouse messages",
  "ad-hoc-pdfium-signatures": "certificate verification environment",
  "ad-hoc-pdfium-signing": "certificate generation and verification",
  "ad-hoc-pdfium-theme": "pixel-sensitive screenshots",
  "ad-hoc-pdfium-tiles": "pixel-sensitive screenshots",
  "ad-hoc-pdfium-view-state": "window geometry and session state",
};

export async function testit(): Promise<void> {
  setTestWindowLayout("workArea");
  const failures: string[] = [];
  const start = performance.now();

  for (const [name, fn] of tests) {
    console.log(`\n========== ${name} ==========`);
    try {
      await runTest(name, fn);
    } catch (e) {
      failures.push(name);
      console.error(`❌ ${name}: ${(e as Error)?.message ?? e}`);
    }
  }

  const elapsed = formatDuration(performance.now() - start);
  console.log(`\n${tests.length - failures.length}/${tests.length} SolokPDF tests passed in ${elapsed}`);
  if (failures.length) throw new Error(`Failed: ${failures.join(", ")}`);
}

if (import.meta.main) {
  if (!process.env.SUMATRA_TEST_EXE || !existsSync(EXE)) {
    throw new Error("Set SUMATRA_TEST_EXE to the packaged SolokPDF.exe before running CI tests");
  }
  prepareTestEnvironment();
  console.log(`exe: ${EXE}`);
  await testit();
}
