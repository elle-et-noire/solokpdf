import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import {
  APP_NAME,
  loadPng,
  makeTextPdf,
  pngPixel,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
  USE_NG,
} from "./util";
import { findCanvas, killAndWait, launchControlled } from "./win-automation";
import { captureWindowToPng, repaintWindow, sleep } from "./winapi";

export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") {
    console.log("SKIP selection-noop-colors: SolokPDF original app only");
    return;
  }
  for (const engine of ["pdfium", "mupdf"]) {
    const dir = tmpPath(`selection-noop-${engine}`);
    mkdirSync(dir, { recursive: true });
    const pdf = join(dir, "page.pdf");
    writeFileSync(pdf, makeTextPdf("Selected X"));
    writeFileSync(
      join(dir, SETTINGS_FILE),
      "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\nDocumentColorsFollowTheme = off\nThemes [\n [\n Name = Selection Test\n TextColor = #000000\n BackgroundColor = #ffffff\n ControlBackgroundColor = #ffffff\n LinkColor = #000000\n SelectionBackgroundColor = #ffffff\n SelectionTextColor = #000000\n ]\n]\n",
    );
    const { proc, client, frame } = await launchControlled(
      ["-appdata", dir, "-log-to-file", join(dir, "selection.log"), "-zoom", "125", pdf],
      {
        env: { SOLOKPDF_ENGINE: engine },
      },
    );
    try {
      await client.waitForRenderIdle();
      await client.setNotificationsEnabled(false);
      const canvas = findCanvas(frame);
      const shot = join(dir, "canvas.png");
      const initial = join(dir, "before.png");
      if (!captureWindowToPng(canvas, initial)) throw new Error(`${engine}: capture failed`);
      const before = loadPng(initial);
      await client.seedTextSelection(1, 0, 8);
      const selection = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
      if (!selection.split("\n").includes("expanded=Selected"))
        throw new Error(`${engine}: unexpected selection ${selection}`);
      repaintWindow(canvas);
      await client.waitForRenderIdle();
      repaintWindow(canvas);
      let stable = 0;
      let changed = 0;
      const deadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
      while (Date.now() < deadline && stable < 3) {
        if (!captureWindowToPng(canvas, shot)) throw new Error(`${engine}: selected capture failed`);
        const after = loadPng(shot);
        if (after.w !== before.w || after.h !== before.h) throw new Error(`${engine}: canvas resized`);
        changed = 0;
        for (let y = 0; y < before.h; y++)
          for (let x = 0; x < before.w; x++) {
            const a = pngPixel(before, x, y),
              b = pngPixel(after, x, y);
            if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed++;
          }
        stable = changed ? 0 : stable + 1;
        await sleep(100);
      }
      if (stable < 3) throw new Error(`${engine}: no-op selection changed ${changed} pixels`);
      console.log(`${engine}: no-op selection unchanged at 125%`);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}
if (import.meta.main) await runStandalone(testit);
