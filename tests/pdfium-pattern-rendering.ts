import { testit as geometry } from "./theme-fallback-geometry.ts";
import { testit as transparent } from "./theme-transparent-fallback.ts";
import { testit as cancel } from "./theme-render-cancel.ts";
import { testit as tiles } from "./ad-hoc-pdfium-tiles.ts";
import { runStandalone, USE_NG } from "./util.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const previous = process.env.SOLOKPDF_TEST_PATTERN_STROKES;
  process.env.SOLOKPDF_TEST_PATTERN_STROKES = "1";
  try {
    await geometry();
    console.log("pattern strokes: page boxes and rotation OK");
    await transparent();
    console.log("pattern strokes: transparency OK");
    await cancel();
    console.log("pattern strokes: cancellation OK");
    await tiles();
  } finally {
    if (previous === undefined) delete process.env.SOLOKPDF_TEST_PATTERN_STROKES;
    else process.env.SOLOKPDF_TEST_PATTERN_STROKES = previous;
  }
}

if (import.meta.main) await runStandalone(testit);
