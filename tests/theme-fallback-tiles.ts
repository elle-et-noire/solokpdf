import { testit as checkTiles } from "./ad-hoc-pdfium-tiles.ts";
import { runStandalone, USE_NG } from "./util.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const previous = process.env.SOLOKPDF_TEST_THEME_FALLBACK;
  process.env.SOLOKPDF_TEST_THEME_FALLBACK = "1";
  try {
    await checkTiles();
  } finally {
    if (previous === undefined) delete process.env.SOLOKPDF_TEST_THEME_FALLBACK;
    else process.env.SOLOKPDF_TEST_THEME_FALLBACK = previous;
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
