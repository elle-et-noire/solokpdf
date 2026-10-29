// Opt-in PDFium check: with DocumentColorsFollowTheme = smart (the default) a page takes the theme's colors and
// its photos keep theirs, on dark and light themes; a figure on a flat light backdrop recolors
// (#6088) and legacy recolors photos too. Build with
// solok-build.ts, then use --no-build.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, loadPng, runStandalone, tmpPath, type PngImage } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { ControlCommand } from "./control.ts";
import {
  captureWindowToPng,
  enumWindows,
  findChildWindow,
  getWindowPid,
  getWindowText,
  postMessage,
  sendMessage,
  setProcessDpiAware,
  sleep,
} from "./winapi.ts";

// how far a pixel may be from a photo's color and still count as untouched
const kTolerance = 8;
// a photo is 150x150 pt; at fit-page zoom it covers far more pixels than this
const kMinPhotoPixels = 5000;
// paper left white means the page wasn't themed
const kMaxWhitePixels = 500;

const kRed = [255, 0, 0];
const kGreen = [0, 255, 0];
const kBackdrop = [0xcc, 0xcc, 0xcc];

// 8x8 solid RGB image
function imageObject(rgb: number[]): string {
  const data = String.fromCharCode(...rgb).repeat(64);
  return `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>\nstream\n${data}\nendstream`;
}

// 16x16: a blue square on flat light gray, a figure rather than a photo
function figureObject(): string {
  let data = "";
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const inner = x >= 4 && x < 12 && y >= 4 && y < 12;
      data += String.fromCharCode(...(inner ? [0, 0, 255] : kBackdrop));
    }
  }
  return `<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>\nstream\n${data}\nendstream`;
}

// text, a red photo on the page, a green one inside a form XObject and a figure
function themePdf(): string {
  const page = [
    "BT /F1 28 Tf 72 700 Td (Themed page text) Tj ET",
    "q 150 0 0 150 72 450 cm /Im1 Do Q",
    "q 1 0 0 1 330 450 cm /Fm1 Do Q",
    "q 150 0 0 150 72 250 cm /Im3 Do Q",
  ].join("\n");
  const form = "/Im2 Do";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R /Fm1 7 0 R /Im3 9 0 R >> >> >>",
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    imageObject(kRed),
    `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [150 0 0 150 0 0] ` +
      `/Resources << /XObject << /Im2 8 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
    imageObject(kGreen),
    figureObject(),
  ]);
}

function countNear(img: PngImage, rgb: number[]): number {
  let n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const p = i * img.nComp;
    let near = true;
    for (let c = 0; c < 3; c++) {
      if (Math.abs(img.data[p + c]! - rgb[c]!) > kTolerance) near = false;
    }
    if (near) n++;
  }
  return n;
}

interface Counts {
  red: number;
  green: number;
  white: number;
  backdrop: number;
  png: string;
}

async function capture(theme: string, mode: string): Promise<Counts> {
  const dir = tmpPath(`pdfium-theme/${theme.replace(/ /g, "-")}-${mode}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "theme.pdf");
  writeFileSync(pdf, themePdf(), "latin1");
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    `UiLanguage = en
CheckForUpdates = false
ShowStartPage = false
DefaultZoom = fit page
Theme = ${theme}
${mode === "default" ? "" : `DocumentColorsFollowTheme = ${mode}`}
`,
  );

  const args = ["-appdata", dir, "-log-to-file", join(dir, "log.txt"), pdf];
  const { proc, client, frame } = await launchControlled(args);
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle(30000);
    const png = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error("capture failed");
    await client.quit();
    await proc.exited;
    const img = loadPng(png);
    const counts = {
      red: countNear(img, kRed),
      green: countNear(img, kGreen),
      white: countNear(img, [255, 255, 255]),
      backdrop: countNear(img, kBackdrop),
      png,
    };
    console.log(
      `${theme} ${mode}: red=${counts.red} green=${counts.green} white=${counts.white} backdrop=${counts.backdrop} ${png}`,
    );
    return counts;
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const failures: string[] = [];
  // smart is the default: no setting behaves like smart
  const smartCases = [
    ["Solarized Dark", "smart"],
    ["Catppuccin Latte", "smart"],
    ["Solarized Dark", "default"],
  ];
  for (const [theme, mode] of smartCases) {
    const name = `${theme} ${mode}`;
    const smart = await capture(theme!, mode!);
    if (smart.white > kMaxWhitePixels) failures.push(`${name}: page not themed (${smart.png})`);
    if (smart.red < kMinPhotoPixels) failures.push(`${name}: page photo recolored (${smart.png})`);
    if (smart.green < kMinPhotoPixels) failures.push(`${name}: form photo recolored (${smart.png})`);
    if (smart.backdrop > kMaxWhitePixels) failures.push(`${name}: figure backdrop kept (${smart.png})`);
  }
  const legacy = await capture("Solarized Dark", "legacy");
  if (legacy.red >= kMinPhotoPixels) failures.push(`legacy: photo kept its colors (${legacy.png})`);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  await testThemeSwitch();
}

export async function testThemeSwitch(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath("pdfium-theme-switch");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "theme.pdf");
  writeFileSync(pdf, themePdf(), "latin1");
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  const captureCurrent = async (tag: string) => {
    await client.waitForRenderIdle(30000);
    const png = join(dir, `${tag}.png`);
    if (!captureWindowToPng(findCanvas(frame), png)) throw new Error(`${tag}: capture failed`);
    const img = loadPng(png);
    const counts = { red: countNear(img, kRed), white: countNear(img, [255, 255, 255]) };
    console.log(`${tag}: red=${counts.red} white=${counts.white}`);
    return counts;
  };
  const invoke = async (name: string) => {
    const result = await client.request(ControlCommand.TestInvokeCommand, [name]);
    if (result[0] !== 0) throw new Error(`${name}: ${result[1]}`);
    await sleep(150);
  };
  const mode = async (key: number) => {
    await invoke("CmdSetDocumentColorsFollowTheme");
    let dialog = 0;
    for (let i = 0; i < 30 && !dialog; i++) {
      enumWindows((hwnd) => {
        if (getWindowPid(hwnd) === proc.pid && getWindowText(hwnd) === "Make Document Colors Follow Theme")
          dialog = hwnd;
        return !dialog;
      });
      if (!dialog) await sleep(50);
    }
    if (!dialog) throw new Error("color mode dialog missing");
    const combo = findChildWindow(dialog, "ComboBox");
    if (!combo) throw new Error("color mode combo missing");
    sendMessage(combo, 0x0100, key, 0);
    sendMessage(combo, 0x0101, key, 0);
    postMessage(dialog, 0x0100, 0x0d, 0);
    await sleep(150);
  };
  try {
    await client.setNotificationsEnabled(false);
    const first = await captureCurrent("dark-smart-first");
    await invoke("CmdSetTheme Light");
    const light = await captureCurrent("light-smart");
    await invoke("CmdSetTheme Solarized Dark");
    const second = await captureCurrent("dark-smart-second");
    await mode(0x28); // smart -> legacy
    const legacy = await captureCurrent("dark-legacy");
    await mode(0x24); // legacy -> off
    const off = await captureCurrent("dark-off");
    await mode(0x28); // off -> smart
    const restored = await captureCurrent("dark-smart-restored");
    if (
      first.red < kMinPhotoPixels ||
      second.red < kMinPhotoPixels ||
      light.red < kMinPhotoPixels ||
      restored.red < kMinPhotoPixels
    )
      throw new Error("smart mode lost preserved photos");
    if (legacy.red >= kMinPhotoPixels) throw new Error("legacy kept photo colors");
    if (off.white < kMinPhotoPixels) throw new Error("off recolored white paper");
    if (second.white > kMaxWhitePixels || restored.white > kMaxWhitePixels)
      throw new Error("dark theme left white paper");
    if (
      first.red !== second.red ||
      first.white !== second.white ||
      first.red !== restored.red ||
      first.white !== restored.white
    )
      throw new Error("dark smart render changed after theme or color mode switch");
    await client.quit();
    await proc.exited;
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
}

if (import.meta.main) await runStandalone(testit);
