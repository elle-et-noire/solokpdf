import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXE, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

async function check(encrypted: boolean): Promise<void> {
  const dir = tmpPath(`theme-repaired-pdf-${encrypted}`);
  mkdirSync(dir, { recursive: true });
  let input = join(import.meta.dir, "theme-color-state-widget.pdf");
  const password = "repaired-theme-password";
  if (encrypted) {
    const output = join(dir, "encrypted.pdf");
    const result = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", password, "-O", "owner", input, output]);
    if (result.exitCode !== 0) throw new Error(`encrypt fixture: ${result.stderr}`);
    input = output;
  }
  const fixture = readFileSync(input, "latin1");
  const damaged = fixture.replace(/startxref\s+\d+/, "startxref\n1");
  if (damaged === fixture) throw new Error("fixture has no xref offset");
  const pdf = join(dir, "repaired.pdf");
  writeFileSync(pdf, damaged, "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nHighlightFormFields = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, ...(encrypted ? ["-pwd", password] : []), pdf],
    {
      env: { SOLOKPDF_ENGINE: "pdfium" },
    },
  );
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const png = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
    const image = loadPng(png);
    const colors = [
      [131, 148, 150],
      [255, 0, 0],
    ];
    const counts = colors.map(() => 0);
    for (let i = 0; i < image.w * image.h; i++) {
      const p = i * image.nComp;
      for (const [index, rgb] of colors.entries()) {
        if (rgb.every((value, c) => Math.abs(image.data[p + c]! - value) < 8)) counts[index]!++;
      }
    }
    if (counts.some((count) => count < 500)) throw new Error(`repaired widget colors: ${counts}`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  await check(false);
  await check(true);
}

if (import.meta.main) {
  await runStandalone(testit);
}
