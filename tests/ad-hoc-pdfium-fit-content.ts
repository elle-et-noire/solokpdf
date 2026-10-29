import { testit as fitVisible } from "./issue-6241.ts";
import { runStandalone } from "./util.ts";

export async function testit(): Promise<void> {
  const previous = process.env.SOLOKPDF_ENGINE;
  try {
    process.env.SOLOKPDF_ENGINE = "pdfium";
    await fitVisible();
  } finally {
    if (previous === undefined) delete process.env.SOLOKPDF_ENGINE;
    else process.env.SOLOKPDF_ENGINE = previous;
  }
}

if (import.meta.main) await runStandalone(testit);
