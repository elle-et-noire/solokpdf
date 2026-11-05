import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, loadPng, makePng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng, setProcessDpiAware } from "./winapi.ts";

const background = [0xf2, 0xf2, 0xf2];

async function sample(engine: string): Promise<number> {
  const dir = tmpPath(`pdfium-window-bg-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "page.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] >>",
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Light\n` +
      `FixedPageUI [\n\tWindowBgCol = #3167a1\n\tGradientColors = #ff0000 #00ff00\n]\n` +
      `FileStates [\n [\n FilePath = ${pdf}\n BgCol = #aa22cc\n ]\n]\n`,
  );

  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const png = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error(`${engine}: capture failed`);
    const img = loadPng(png);
    let count = 0;
    for (let y = Math.floor(img.h / 4); y < Math.floor((img.h * 3) / 4); y++) {
      for (let x = 0; x < Math.floor(img.w / 8); x++) {
        const i = (y * img.w + x) * img.nComp;
        if (background.every((v, c) => img.data[i + c] === v)) count++;
      }
    }
    await client.quit();
    await proc.exited;
    return count;
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
}

async function checkNonPdfBackground(kind: "image" | "ebook", perFile: boolean): Promise<void> {
  const dir = tmpPath(`${kind}-window-bg-${perFile}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, kind === "image" ? "image.png" : "document.rtf");
  if (kind === "image") writeFileSync(path, makePng(40, 40, [255, 0, 0]));
  else writeFileSync(path, String.raw`{\rtf1\ansi Hello\par}`, "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nTheme = Light\n` +
      `${kind === "image" ? "ImageUI" : "EBookUI"} [\n WindowBgCol = #3167a1\n]\n` +
      (perFile ? `FileStates [\n [\n FilePath = ${path}\n BgCol = #aa22cc\n ]\n]\n` : ""),
  );
  const { proc, client, frame } = await launchControlled([
    "-appdata",
    dir,
    "-zoom",
    kind === "image" ? "100" : "fit page",
    path,
  ]);
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const capture = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), capture)) throw new Error(`${kind} canvas capture failed`);
    const img = loadPng(capture);
    const expected = perFile ? [0xaa, 0x22, 0xcc] : [0x31, 0x67, 0xa1];
    let count = 0;
    for (let y = Math.floor(img.h / 4); y < Math.floor((img.h * 3) / 4); y++) {
      for (let x = 0; x < Math.floor(img.w / 8); x++) {
        const i = (y * img.w + x) * img.nComp;
        if (expected.every((v, c) => img.data[i + c] === v)) count++;
      }
    }
    if (count < 300) throw new Error(`${kind} background perFile=${perFile}: only ${count} matching pixels`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  for (const engine of USE_NG ? ["mupdf"] : ["mupdf", "pdfium"]) {
    const count = await sample(engine);
    if (count < 300) throw new Error(`${engine}: only ${count} page-surround pixels have the theme background`);
  }
  for (const kind of ["image", "ebook"] as const) {
    await checkNonPdfBackground(kind, false);
    await checkNonPdfBackground(kind, true);
  }
}

if (import.meta.main) await runStandalone(testit);
