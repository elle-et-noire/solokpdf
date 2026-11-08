import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import {
  APP_NAME,
  cmdId,
  loadPng,
  makeTextPdf,
  pngPixel,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
  USE_NG,
} from "./util";
import { clickAt, findCanvas, killAndWait, launchControlled, pressVKey, sendCommandSync } from "./win-automation";
import { captureWindowToPng, getWindowRect, repaintWindow, sleep } from "./winapi";

export async function testit(): Promise<void> {
  if (!USE_NG && APP_NAME !== "SolokPDF") {
    console.log("SKIP selection-noop-colors: SolokPDF original app only");
    return;
  }
  for (const { engine, loadEditor, color, alpha } of [
    { engine: "pdfium", loadEditor: false, color: "#800066cc", alpha: 128 },
    { engine: "pdfium", loadEditor: false, color: "#000066cc", alpha: 0 },
    { engine: "pdfium", loadEditor: false, color: "#0066cc", alpha: 95 },
    { engine: "pdfium", loadEditor: true, color: "#800066cc", alpha: 128 },
    { engine: "mupdf", loadEditor: false, color: "#800066cc", alpha: 128 },
  ]) {
    if (USE_NG && loadEditor) continue;
    const name = `${engine}${loadEditor ? "-editor" : ""}-${alpha}`;
    const dir = tmpPath(`selection-noop-${name}`);
    mkdirSync(dir, { recursive: true });
    const pdf = join(dir, "page.pdf");
    writeFileSync(pdf, makeTextPdf("Selected X"));
    writeFileSync(
      join(dir, SETTINGS_FILE),
      "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\nDocumentColorsFollowTheme = off\nThemes [\n [\n Name = Selection Test\n TextColor = #000000\n BackgroundColor = #ffffff\n ControlBackgroundColor = #ffffff\n LinkColor = #000000\n SelectionBackgroundColor = #ffffff\n SelectionTextColor = #000000\n TextSelectionColor = #800066cc\n ]\n]\n".replace(
        "#800066cc",
        color,
      ),
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
      if (loadEditor) {
        await client.seedTextSelection(1, 0, 8);
        const position = String(
          (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
        );
        const match = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(position);
        if (!match) throw new Error(`missing selection bounds: ${position}`);
        const win = getWindowRect(canvas),
          x = +match[1]! - win.left + 2,
          y = +match[2]! - win.top + Math.floor(+match[4]! / 2);
        pressVKey(frame, 27);
        await sleep(100);
        await clickAt(canvas, x, y, 200, 0, client);
        const editor = String((await client.request(ControlCommand.TestCurrentPdf, ["editor"]))[1] ?? "");
        if (editor !== "editor=loaded") throw new Error(`annotation editor did not load: ${editor}`);
        await client.waitForRenderIdle();
      }
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
      let blended = 0;
      const deadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
      while (Date.now() < deadline && stable < 3) {
        if (!captureWindowToPng(canvas, shot)) throw new Error(`${engine}: selected capture failed`);
        const after = loadPng(shot);
        if (after.w !== before.w || after.h !== before.h) throw new Error(`${engine}: canvas resized`);
        changed = 0;
        blended = 0;
        for (let y = 0; y < before.h; y++)
          for (let x = 0; x < before.w; x++) {
            const a = pngPixel(before, x, y),
              b = pngPixel(after, x, y);
            if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed++;
            if (
              a[0] === 255 &&
              a[1] === 255 &&
              a[2] === 255 &&
              Math.abs(b[0] - (255 - alpha)) <= 2 &&
              Math.abs(b[1] - (255 - (153 * alpha) / 255)) <= 2 &&
              Math.abs(b[2] - (255 - (51 * alpha) / 255)) <= 2
            )
              blended++;
          }
        stable = (alpha === 0 ? changed === 0 : blended > 30) ? stable + 1 : 0;
        await sleep(100);
      }
      if (stable < 3)
        throw new Error(`${engine}: selection overlay changed ${changed} pixels with ${blended} blended pixels`);
      if (engine === "pdfium" && alpha === 128 && !loadEditor) {
        sendCommandSync(frame, cmdId("CmdZoomFitPage"));
        sendCommandSync(frame, cmdId("CmdRotateRight"));
        await client.waitForRenderIdle();
        await client.seedTextSelection(1, 0, 8);
        repaintWindow(canvas);
        let rotatedPixels = 0;
        const rotateEnd = Date.now() + 4000 * SLOW_BUILD_FACTOR;
        while (Date.now() < rotateEnd && rotatedPixels < 30) {
          await sleep(50);
          if (!captureWindowToPng(canvas, shot)) throw new Error("rotation capture failed");
          const image = loadPng(shot);
          rotatedPixels = 0;
          for (let y = 0; y < image.h; y++)
            for (let x = 0; x < image.w; x++) {
              const [r, g, b] = pngPixel(image, x, y);
              if (Math.abs(r - 127) <= 2 && Math.abs(g - 178) <= 2 && Math.abs(b - 229) <= 2) rotatedPixels++;
            }
        }
        if (rotatedPixels < 30) throw new Error(`rotated selection missing: ${rotatedPixels}`);
        sendCommandSync(frame, cmdId("CmdRotateLeft"));
        await client.waitForRenderIdle();
        await client.seedTextSelection(1, 0, 8);
        sendCommandSync(frame, cmdId("CmdNextTheme"));
        const end = Date.now() + 4000 * SLOW_BUILD_FACTOR;
        let defaultPixels = 0;
        while (Date.now() < end && defaultPixels < 30) {
          await sleep(50);
          if (!captureWindowToPng(canvas, shot)) throw new Error("theme-switch capture failed");
          const image = loadPng(shot);
          defaultPixels = 0;
          for (let y = 0; y < image.h; y++)
            for (let x = 0; x < image.w; x++) {
              const [r, g, b] = pngPixel(image, x, y);
              if (Math.abs(r - 179) <= 2 && Math.abs(g - 217) <= 2 && Math.abs(b - 255) <= 2) defaultPixels++;
            }
        }
        if (defaultPixels < 30) throw new Error(`theme switch did not update overlay: ${defaultPixels}`);
      }
      console.log(`${name}: selection opacity verified at 125%`);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}
if (import.meta.main) await runStandalone(testit);
