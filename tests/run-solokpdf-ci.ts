import { existsSync } from "node:fs";
import { EXE, formatDuration, prepareTestEnvironment, runTest, type NamedTest } from "./util.ts";
import { setTestWindowLayout } from "./winapi.ts";
import { testit as documentJs } from "./ad-hoc-pdfium-document-js.ts";
import { testit as dates } from "./ad-hoc-pdfium-dates.ts";
import { testit as coexist } from "./ad-hoc-solok-coexist.ts";
import { testit as themeSwitch } from "./ad-hoc-pdfium-theme-switch.ts";
import { testit as cad } from "./ad-hoc-pdfium-cad.ts";
import { testit as formJs } from "./ad-hoc-pdfium-form-js.ts";
import { testit as forms } from "./ad-hoc-pdfium-forms.ts";
import { testit as hover } from "./ad-hoc-pdfium-hover.ts";
import { testit as memory } from "./ad-hoc-pdfium-memory.ts";
import { testit as outline } from "./ad-hoc-pdfium-outline.ts";
import { testit as permissions } from "./ad-hoc-pdfium-permissions.ts";
import { testit as printPrefs } from "./ad-hoc-pdfium-print-prefs.ts";
import { testit as saveas } from "./ad-hoc-pdfium-saveas.ts";
import { testit as synctex } from "./ad-hoc-pdfium-synctex.ts";
import { testit as tools } from "./ad-hoc-pdfium-tools.ts";
import { testit as textExtraction } from "./ad-hoc-pdfium-text.ts";
import { testit as dehyphen } from "./ad-hoc-pdfium-dehyphen.ts";
import { testit as links } from "./ad-hoc-pdfium-links.ts";
import { testit as images } from "./ad-hoc-pdfium-images.ts";
import { testit as fitContent } from "./ad-hoc-pdfium-fit-content.ts";
import { testit as pageBoxes } from "./ad-hoc-pdfium-page-boxes.ts";
import { testit as scroll } from "./ad-hoc-pdfium-scroll.ts";
import { testit as bookmarks } from "./ad-hoc-pdfium-bookmarks.ts";
import { testit as annotations } from "./ad-hoc-pdfium-annotations.ts";
import { testit as unsupported } from "./ad-hoc-pdfium-unsupported.ts";
import { testit as windowBg } from "./ad-hoc-pdfium-window-bg.ts";
import { testit as vimKeys } from "./ad-hoc-vim-keys.ts";
import { testit as countPrefix } from "./ad-hoc-count-prefix.ts";
import { testit as noUpdateCheck } from "./ad-hoc-no-update-check.ts";

const tests: NamedTest[] = [
  ["ad-hoc-pdfium-memory", memory],
  ["ad-hoc-pdfium-saveas", saveas],
  ["ad-hoc-pdfium-forms", forms],
  ["ad-hoc-pdfium-hover", hover],
  ["ad-hoc-pdfium-synctex", synctex],
  ["ad-hoc-pdfium-tools", tools],
  ["ad-hoc-pdfium-text", textExtraction],
  ["ad-hoc-pdfium-dehyphen", dehyphen],
  ["ad-hoc-pdfium-links", links],
  ["ad-hoc-pdfium-images", images],
  ["ad-hoc-pdfium-fit-content", fitContent],
  ["ad-hoc-pdfium-page-boxes", pageBoxes],
  ["ad-hoc-pdfium-scroll", scroll],
  ["ad-hoc-pdfium-bookmarks", bookmarks],
  ["ad-hoc-pdfium-annotations", annotations],
  ["ad-hoc-pdfium-outline", outline],
  ["ad-hoc-pdfium-unsupported", unsupported],
  ["ad-hoc-pdfium-permissions", permissions],
  ["ad-hoc-pdfium-print-prefs", printPrefs],
  ["ad-hoc-pdfium-dates", dates],
  ["ad-hoc-solok-coexist", coexist],
  ["ad-hoc-pdfium-theme-switch", themeSwitch],
  ["ad-hoc-pdfium-cad", cad],
  ["ad-hoc-pdfium-window-bg", windowBg],
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
