import { testit as checkGradients } from "./theme-blend-gradient.ts";
import { testit as checkDynamicWidgets } from "./theme-dynamic-widget.ts";
import { testit as checkEncrypted } from "./theme-encrypted.ts";
import { testit as checkLargePdf } from "./theme-large-pdf.ts";
import { testit as checkCancel } from "./theme-render-cancel.ts";
import { testit as checkRepaired } from "./theme-repaired-pdf.ts";
import { testit as checkStateWidgets } from "./theme-state-widget.ts";
import { testit as checkType3 } from "./theme-type3.ts";
import { runStandalone, USE_NG } from "./util.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const previous = process.env.SOLOKPDF_TEST_THEME_FALLBACK;
  process.env.SOLOKPDF_TEST_THEME_FALLBACK = "1";
  try {
    await checkGradients();
    await checkStateWidgets();
    await checkDynamicWidgets();
    await checkType3();
    await checkCancel();
    await checkEncrypted();
    await checkRepaired();
    await checkLargePdf();
  } finally {
    if (previous === undefined) delete process.env.SOLOKPDF_TEST_THEME_FALLBACK;
    else process.env.SOLOKPDF_TEST_THEME_FALLBACK = previous;
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
