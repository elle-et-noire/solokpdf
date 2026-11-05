import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXE, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("theme-encrypted");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "encrypted.pdf");
  const password = "theme-test-password";
  const fixture = join(import.meta.dir, "theme-color-state-widget.pdf");
  const result = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", password, "-O", "owner", fixture, pdf]);
  if (result.exitCode !== 0) throw new Error(`encrypt fixture: ${result.stderr}`);
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nHighlightFormFields = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, "-pwd", password, pdf], {
    env: { SOLOKPDF_ENGINE: "pdfium" },
  });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const png = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
    const image = loadPng(png);
    const expected = [
      [131, 148, 150],
      [255, 0, 0],
    ];
    const counts = expected.map(() => 0);
    for (let i = 0; i < image.w * image.h; i++) {
      const p = i * image.nComp;
      for (const [index, rgb] of expected.entries()) {
        if (rgb.every((value, c) => Math.abs(image.data[p + c]! - value) < 8)) counts[index]!++;
      }
    }
    if (counts.some((count) => count < 500)) throw new Error(`encrypted widget colors: ${counts}`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
