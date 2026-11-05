import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("theme-render-cancel");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "complex.pdf");
  const log = join(dir, "render.log");
  rmSync(log, { force: true });
  const content = "0 g 0 0 1 1 re f 1 g 1 1 1 1 re f\n".repeat(300_000);
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client } = await launchControlled(["-appdata", dir, "-log-to-file", log, pdf], {
    env: { SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "1" },
  });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(log) && /PDFium profile: render .*setup=/.test(readFileSync(log, "utf8"))) break;
      await Bun.sleep(20);
    }
    if (!existsSync(log) || !/PDFium profile: render .*setup=/.test(readFileSync(log, "utf8"))) {
      throw new Error("render did not start");
    }
    await client.quit();
    const result = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => null)]);
    if (result === null) throw new Error("closing during theme conversion timed out");
    if (result !== 0) throw new Error(`app exited with ${result}`);
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
