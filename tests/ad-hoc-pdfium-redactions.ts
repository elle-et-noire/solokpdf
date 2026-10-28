import { runStandalone } from "./util.ts";
import { testit as redact } from "./redact-annotations.ts";

export async function testit(): Promise<void> {
  const previous = process.env.SOLOKPDF_ENGINE;
  try {
    for (const engine of ["pdfium", "mupdf"]) {
      process.env.SOLOKPDF_ENGINE = engine;
      await redact();
      console.log(`${engine}: redaction passed`);
    }
  } finally {
    if (previous === undefined) delete process.env.SOLOKPDF_ENGINE;
    else process.env.SOLOKPDF_ENGINE = previous;
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
