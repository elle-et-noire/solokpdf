import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, takeStderr } from "./win-automation.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const patternStrokes = process.env.SOLOKPDF_TEST_PATTERN_STROKES === "1";
  const dir = tmpPath("theme-render-cancel");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "complex.pdf");
  const log = join(dir, "render.log");
  rmSync(log, { force: true });
  const content =
    (patternStrokes ? "q /PCS CS .4 /P SCN 2 w 20 20 160 160 re S Q\n" : "") +
    "0 g 0 0 1 1 re f 1 g 1 1 1 1 re f\n".repeat(300_000);
  const pattern = "0 0 10 10 re f";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ${patternStrokes ? "/Resources << /ColorSpace << /PCS [/Pattern /DeviceGray] >> /Pattern << /P 5 0 R >> >>" : ""} >>`,
      `<< /Length ${content.length} >>\nstream\n${content}endstream`,
      `<< /Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Length ${pattern.length} >>\nstream\n${pattern}\nendstream`,
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = ${patternStrokes ? "off" : "smart"}\n`,
  );
  const { proc, client } = await launchControlled(["-appdata", dir, "-log-to-file", log, pdf], {
    env: { SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "1" },
  });
  try {
    const deadline = Date.now() + 15_000;
    const started = patternStrokes ? /PDFium profile: render .*mupdf-start=/ : /PDFium profile: render .*setup=/;
    while (Date.now() < deadline) {
      if (existsSync(log) && started.test(readFileSync(log, "utf8"))) break;
      await Bun.sleep(20);
    }
    if (!existsSync(log) || !started.test(readFileSync(log, "utf8"))) {
      throw new Error("render did not start");
    }
    await client.quit();
    const result = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => null)]);
    if (result === null) throw new Error("closing during theme conversion timed out");
    if (result !== 0) throw new Error(`app exited with ${result}`);
    if (patternStrokes && !/PDFium profile: render .*canceled-or-failed=/.test(readFileSync(log, "utf8"))) {
      throw new Error("pattern render completed before cancellation was exercised");
    }
    if (patternStrokes && (await takeStderr(proc)).includes("UNHANDLED EXCEPTION")) {
      throw new Error("render cancellation left an unhandled MuPDF exception");
    }
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
