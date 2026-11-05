import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_MAC } from "./host.ts";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

async function check(theme: string, mode: string, background: string, foreground: string): Promise<void> {
  const dir = tmpPath(`theme-document-${theme}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "blank.pdf");
  const contents = "BT /F1 36 Tf 30 320 Td (Theme) Tj ET";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = ${theme}\n` +
      `DocumentColorsFollowTheme = ${mode}\nThemes [\n [\n Name = Test Background\n TextColor = #eeeeee\n` +
      ` BackgroundColor = #193247\n ControlBackgroundColor = #52739b\n ]\n]\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const png = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("canvas capture failed");
    const img = loadPng(png);
    const pixel = (x: number, y: number): string => {
      const i = (y * img.w + x) * img.nComp;
      return Array.from(img.data.subarray(i, i + 3))
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
    };
    const surround = pixel(Math.floor(img.w / 16), Math.floor(img.h / 2));
    const page = pixel(Math.floor(img.w / 2), Math.floor(img.h / 2));
    const expectedPage = mode === "off" ? "ffffff" : background;
    if (surround !== background || page !== expectedPage) {
      throw new Error(`${theme}/${mode}: surround=${surround}, page=${page}; expected ${background}, ${expectedPage}`);
    }
    const expectedText = mode === "off" ? "000000" : foreground;
    let textPixels = 0;
    for (let y = Math.floor(img.h / 10); y < Math.floor(img.h / 2); y++) {
      for (let x = Math.floor(img.w / 4); x < Math.floor((img.w * 3) / 4); x++) {
        if (pixel(x, y) === expectedText) textPixels++;
      }
    }
    if (textPixels < 20) throw new Error(`${theme}/${mode}: only ${textPixels} pixels match text ${expectedText}`);
    if (theme === "Dark") {
      if (USE_NG) {
        await client.request(ControlCommand.TestInput, ["click", Math.floor(img.w / 2), Math.floor(img.h / 2), 0, 0]);
        await Bun.sleep(300);
      }
      const invertedText = mode === "off" ? "ffffff" : background;
      for (const [expected, expectedInk] of [
        [mode === "off" ? "000000" : foreground, invertedText],
        [expectedPage, expectedText],
      ]) {
        const result = USE_NG
          ? await client.request(ControlCommand.TestInput, ["key", 0x49, 2])
          : await client.request(ControlCommand.TestInvokeCommand, ["CmdInvertColors"]);
        if (result[0] !== 0) throw new Error(`invert command failed: ${result[1]}`);
        if (USE_NG) await client.request(ControlCommand.TestInput, ["keyup", 0x49, 2]);
        await client.waitForRenderIdle();
        if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("inverted canvas capture failed");
        const next = loadPng(png);
        const i = (Math.floor(next.h / 2) * next.w + Math.floor(next.w / 2)) * next.nComp;
        const actual = Array.from(next.data.subarray(i, i + 3))
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        if (actual !== expected) throw new Error(`invert: page=${actual}, expected ${expected}`);
        let ink = 0;
        for (let y = Math.floor(next.h / 10); y < Math.floor(next.h / 2); y++) {
          for (let x = Math.floor(next.w / 4); x < Math.floor((next.w * 3) / 4); x++) {
            const at = (y * next.w + x) * next.nComp;
            const color = Array.from(next.data.subarray(at, at + 3))
              .map((v) => v.toString(16).padStart(2, "0"))
              .join("");
            if (color === expectedInk) ink++;
          }
        }
        if (ink < 20) throw new Error(`invert: only ${ink} pixels match text ${expectedInk}`);
      }
    }
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

async function checkHome(theme: string, background: string): Promise<void> {
  const dir = tmpPath(`theme-home-${theme}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = true\nNoHomeTab = false\nTheme = ${theme}\n` +
      `Themes [\n [\n Name = Test Background\n TextColor = #eeeeee\n BackgroundColor = #193247\n ]\n]\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir]);
  try {
    await client.setNotificationsEnabled(false);
    const png = join(dir, "home.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("home capture failed");
    const img = loadPng(png);
    const i = (Math.floor(img.h / 2) * img.w + Math.floor(img.w / 32)) * img.nComp;
    const actual = Array.from(img.data.subarray(i, i + 3))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== background) throw new Error(`${theme}: home=${actual}, expected ${background}`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

async function checkOriginalPaper(): Promise<void> {
  const dir = tmpPath("theme-original-paper");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "tinted.pdf");
  const contents = "0.9 0.8 0.7 rg 0 0 200 400 re f";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] /Contents 4 0 R >>",
      `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Dark\nDocumentColorsFollowTheme = off\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const path = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("tinted paper capture failed");
    const img = loadPng(path);
    const i = (Math.floor(img.h / 2) * img.w + Math.floor(img.w / 2)) * img.nComp;
    const rgb = Array.from(img.data.subarray(i, i + 3));
    if (rgb.some((value, channel) => Math.abs(value - [230, 204, 179][channel]!) > 2))
      throw new Error(`off: original tinted paper changed (${rgb})`);
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (IS_MAC) return;
  await checkOriginalPaper();
  for (const [theme, background, foreground] of [
    ["Light", "f2f2f2", "000000"],
    ["Dark", "000000", "f9fafb"],
    ["Test Background", "193247", "eeeeee"],
  ]) {
    await checkHome(theme!, background!);
    for (const mode of ["off", "smart", "legacy"]) await check(theme!, mode, background!, foreground!);
  }
}

if (import.meta.main) await runStandalone(testit);
