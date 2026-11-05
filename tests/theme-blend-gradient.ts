import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_MAC } from "./host.ts";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

function makePdf(): string {
  const image = String.fromCharCode(255, 0, 0).repeat(64);
  const content = "q 200 0 0 200 0 0 cm /Im Do Q\nq /GS gs /Sh sh Q";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im 5 0 R >> /Shading << /Sh 6 0 R >> /ExtGState << /GS 8 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
    "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Domain [0 1] /Function 7 0 R /Extend [true true] >>",
    "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 1 >>",
    "<< /Type /ExtGState /BM /Multiply /ca 0.5 >>",
  ]);
}

function makeSharedMaskPdf(): string {
  const image = String.fromCharCode(255, 255, 0).repeat(64);
  const content = "q /Fm Do Q q /GS gs 80 0 0 80 50 20 cm /Im Do Q";
  const form = "1 g 0 0 1 1 re f";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Fm 5 0 R /Im 6 0 R >> /ExtGState << /GS 7 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [80 0 0 80 50 20] /Group << /S /Transparency /CS /DeviceRGB >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n${image}\nendstream`,
    "<< /Type /ExtGState /SMask << /S /Luminosity /G 5 0 R >> >>",
  ]);
}

function makePatternMaskPdf(maskFirst: boolean): string {
  const shape = "q /Pattern cs /P scn 130 130 50 50 re f Q";
  const maskDraw = "q /Pattern cs /P scn 80 0 0 80 50 20 cm /M Do Q";
  const content = maskFirst ? `${maskDraw} ${shape}` : `${shape} ${maskDraw}`;
  const pattern = "q 0 0 1 1 re W n 1 0 0 rg 0 0 1 1 re f Q";
  const mask = "\xaa".repeat(8);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> /XObject << /M 6 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Matrix [10 0 0 10 0 0] /Resources << >> /Length ${pattern.length} >>\nstream\n${pattern}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Length ${mask.length} >>\nstream\n${mask}\nendstream`,
  ]);
}

function makeShadeMaskPdf(): string {
  const content = "q /Pattern cs /P scn 80 0 0 80 50 20 cm /M Do Q";
  const mask = "\xaa".repeat(8);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> /XObject << /M 8 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>",
    "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [50 20 130 20] /Domain [0 1] /Function 7 0 R /Extend [true true] >>",
    "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 1 0] /N 1 >>",
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Length ${mask.length} >>\nstream\n${mask}\nendstream`,
  ]);
}

async function checkSharedMask(engine: string): Promise<void> {
  const dir = tmpPath(`theme-shared-mask-${engine}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "shared.pdf");
  writeFileSync(pdf, makeSharedMaskPdf(), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const path = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
    const img = loadPng(path);
    let yellow = 0;
    for (let i = 0; i < img.w * img.h; i++) {
      const p = i * img.nComp;
      if (img.data[p]! >= 247 && img.data[p + 1]! >= 247 && img.data[p + 2]! <= 8) yellow++;
    }
    if (yellow < 500) throw new Error(`${engine}: shared soft mask changed yellow image (${yellow} pixels)`);
    console.log(`${engine}: shared soft mask preserved (${yellow} pixels)`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

async function checkPatternMask(engine: string, maskFirst: boolean): Promise<void> {
  const dir = tmpPath(`theme-pattern-mask-${engine}-${maskFirst}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "pattern.pdf");
  writeFileSync(pdf, makePatternMaskPdf(maskFirst), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    const checkCurrent = async (expected: number[], tag: string) => {
      await client.waitForRenderIdle();
      const path = join(dir, `${tag}.png`);
      if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
      const img = loadPng(path);
      let red = 0;
      let left = img.w;
      let top = img.h;
      let right = -1;
      for (let i = 0; i < img.w * img.h; i++) {
        const p = i * img.nComp;
        if (img.data[p]! >= 247 && img.data[p + 1]! <= 8 && img.data[p + 2]! <= 8) {
          const x = i % img.w;
          const y = Math.floor(i / img.w);
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          red++;
        }
      }
      if (red < 500) throw new Error(`${engine}/${tag}: pattern image mask changed color (${red} pixels)`);
      const scale = (right - left + 1) / 80;
      const x = Math.floor(left + (155 - 50) * scale);
      const y = Math.floor(top - (155 - 100) * scale);
      if (x >= img.w || y < 0) throw new Error(`${engine}/${tag}: pattern sample is outside canvas`);
      const p = (y * img.w + x) * img.nComp;
      const rgb = Array.from(img.data.subarray(p, p + 3));
      if (rgb.some((v, i) => Math.abs(v - expected[i]!) > 10))
        throw new Error(`${engine}/${tag}: shared pattern not themed (mask first: ${maskFirst}, ${rgb})`);
      console.log(`${engine}/${tag}: pattern image mask preserved (${red} pixels)`);
    };
    await checkCurrent([0, 148, 150], "dark");
    for (const [theme, expected] of [
      ["Light", [242, 0, 0]],
      ["Solarized Dark", [0, 148, 150]],
    ] as const) {
      const result = await client.request(ControlCommand.TestInvokeCommand, [`CmdSetTheme ${theme}`]);
      if (result[0] !== 0) throw new Error(`${theme}: ${result[1]}`);
      await checkCurrent([...expected], theme.replace(/ /g, "-"));
    }
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

async function checkShadeMask(engine: string): Promise<void> {
  const dir = tmpPath(`theme-shade-mask-${engine}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "shade-mask.pdf");
  writeFileSync(pdf, makeShadeMaskPdf(), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const path = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
    const img = loadPng(path);
    let red = 0;
    let middle = 0;
    for (let i = 0; i < img.w * img.h; i++) {
      const p = i * img.nComp;
      const r = img.data[p]!;
      const g = img.data[p + 1]!;
      const b = img.data[p + 2]!;
      if (r > 220 && g < 50 && b < 10) red++;
      if (r > 85 && g > 85 && b < 10) middle++;
    }
    if (red < 200 || middle < 500) throw new Error(`${engine}: shade image mask changed (${red}, ${middle})`);
    console.log(`${engine}: shade image mask preserved (${red}, ${middle} pixels)`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

async function check(engine: string, mode: string, expected: number): Promise<void> {
  const dir = tmpPath(`theme-blend-gradient-${engine}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "blend.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = ${mode}\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], { env: { SOLOKPDF_ENGINE: engine } });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const path = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
    const img = loadPng(path);
    const y = Math.floor(img.h / 2);
    let left = img.w;
    let right = -1;
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.nComp;
      if (img.data[i]! > 80 && img.data[i + 1]! < 5 && img.data[i + 2]! < 5) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    if (right < left) throw new Error(`${engine}/${mode}: page not visible`);
    const i = (y * img.w + Math.floor((left + right) / 2)) * img.nComp;
    const rgb = Array.from(img.data.subarray(i, i + 3));
    if (Math.abs(rgb[0]! - expected) > 6 || rgb[1]! > 5 || rgb[2]! > 5) {
      throw new Error(`${engine}/${mode}: composite=${rgb.join(",")}, expected red near ${expected}`);
    }
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (IS_MAC) return;
  const failures: string[] = [];
  for (const engine of USE_NG ? ["mupdf"] : ["mupdf", "pdfium"]) {
    const cases = [
      () => checkSharedMask(engine),
      () => checkPatternMask(engine, false),
      () => checkPatternMask(engine, true),
      () => checkShadeMask(engine),
      () => check(engine, "off", 191),
      () => check(engine, "smart", 160),
    ];
    for (const run of cases) {
      try {
        await run();
      } catch (e) {
        failures.push(String(e));
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
