// Opt-in PDFium check: with DocumentColorsFollowTheme = smart (the default) a page takes the theme's colors and
// its embedded images keep theirs, on dark and light themes, while legacy recolors them. Build with
// solok-build.ts, then use --no-build.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG, type PngImage } from "./util.ts";
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
const kSmallImage = [0, 255, 255];
const kMaskImage = [255, 0, 255];
const kInlineMaskImage = [16, 128, 240];
const kAnnotationImage = [230, 80, 180];
const kSoftMaskedImage = [255, 255, 0];
const kMinSmallImagePixels = 50;
const kDarkShadeMidpoint = [65, 95, 102];

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
  const softMask = "1 g 50 20 40 80 re f 0.5 g 90 20 40 80 re f";
  const annotation = "0 g BT /F1 24 Tf 4 4 Td (Annotation) Tj ET";
  const page = [
    "BT /F1 28 Tf 72 700 Td (Themed page text) Tj ET",
    "q 150 0 0 150 72 450 cm /Im1 Do Q",
    "BT /F1 28 Tf 80 500 Td (X) Tj ET",
    "BT /F1 28 Tf 340 500 Td (X) Tj ET",
    "q 1 0 0 1 330 450 cm /Fm1 Do Q",
    "q 150 0 0 150 72 250 cm /Im3 Do Q",
    "q 20 0 0 20 300 250 cm /Im4 Do Q",
    "q 1 0 1 rg 80 0 0 80 340 200 cm /Im5 Do Q",
    `q 0.062745 0.501961 0.941176 rg 60 0 0 60 230 180 cm BI /W 8 /H 8 /IM true /BPC 1 ID\n${"\xaa".repeat(8)}\nEI Q`,
    "q 330 20 150 150 re W n /Sh1 sh Q",
    "q /GS1 gs 80 0 0 80 50 20 cm /Im6 Do Q",
    "1 1 0 0.5 k 220 100 70 70 re f",
  ].join("\n");
  const form = "/Im2 Do";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Annots [17 0 R 19 0 R] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R /Fm1 7 0 R /Im3 9 0 R /Im4 10 0 R /Im5 11 0 R /Im6 16 0 R >> /Shading << /Sh1 12 0 R >> /ExtGState << /GS1 14 0 R >> >> >>",
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    imageObject(kRed),
    `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [150 0 0 150 0 0] ` +
      `/Resources << /XObject << /Im2 8 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
    imageObject(kGreen),
    figureObject(),
    imageObject(kSmallImage),
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Length 8 >>\nstream\n${"\xaa".repeat(8)}\nendstream`,
    "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [330 20 480 20] /Domain [0 1] /Function 13 0 R /Extend [true true] >>",
    "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 1 >>",
    "<< /Type /ExtGState /SMask << /S /Luminosity /G 15 0 R >> >>",
    `<< /Type /XObject /Subtype /Form /BBox [50 20 130 100] /Group << /S /Transparency /CS /DeviceRGB >> /Length ${softMask.length} >>\nstream\n${softMask}\nendstream`,
    imageObject(kSoftMaskedImage),
    "<< /Type /Annot /Subtype /FreeText /Rect [220 650 370 680] /F 4 /AP << /N 18 0 R >> >>",
    `<< /Type /XObject /Subtype /Form /BBox [0 0 150 30] /Resources << /Font << /F1 5 0 R >> >> /Length ${annotation.length} >>\nstream\n${annotation}\nendstream`,
    "<< /Type /Annot /Subtype /Stamp /Rect [430 650 490 710] /F 4 /AP << /N 20 0 R >> >>",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /X 21 0 R >> >> /Length 5 >>\nstream\n/X Do\nendstream",
    imageObject(kAnnotationImage),
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

function shadeBounds(img: PngImage): number[] {
  let left = img.w;
  let top = img.h;
  let right = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.nComp;
      if (kRed.every((value, channel) => Math.abs(img.data[i + channel]! - value) <= kTolerance)) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
      }
    }
  }
  if (right < left) return [];
  const scale = (right - left + 1) / 150;
  const x0 = Math.max(0, Math.floor(left + (330 - 72) * scale));
  const x1 = Math.min(img.w, Math.ceil(left + (480 - 72) * scale));
  const y0 = Math.max(0, Math.floor(top + (600 - 170) * scale));
  const y1 = Math.min(img.h, Math.ceil(top + (600 - 20) * scale));
  return [x0, y0, x1, y1];
}

function shadeMidpoint(img: PngImage): number {
  const bounds = shadeBounds(img);
  if (bounds.length !== 4) return 0;
  const [x0, y0, x1, y1] = bounds as [number, number, number, number];
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * img.nComp;
      if (kDarkShadeMidpoint.every((value, channel) => Math.abs(img.data[i + channel]! - value) <= kTolerance)) count++;
    }
  }
  return count;
}

function whiteOutsideShade(img: PngImage): number {
  const bounds = shadeBounds(img);
  if (bounds.length !== 4) return countNear(img, [255, 255, 255]);
  const [x0, y0, x1, y1] = bounds as [number, number, number, number];
  let count = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = (y * img.w + x) * img.nComp;
      if ([255, 255, 255].every((v, c) => Math.abs(img.data[i + c]! - v) <= kTolerance)) count++;
    }
  }
  return count;
}

function annotationInk(img: PngImage, color: number[], background: number[]): number {
  const bounds = shadeBounds(img);
  if (bounds.length !== 4) return 0;
  const [shadeX, shadeY, shadeRight] = bounds as [number, number, number, number];
  const scale = (shadeRight - shadeX) / 150;
  const x0 = Math.max(0, Math.floor(shadeX - 110 * scale));
  const x1 = Math.min(img.w, Math.ceil(shadeX + 40 * scale));
  const y0 = Math.max(0, Math.floor(shadeY - 510 * scale));
  const y1 = Math.min(img.h, Math.ceil(shadeY - 480 * scale));
  let count = 0;
  const ink = color.map((v, i) => v - background[i]!);
  const norm = ink.reduce((sum, v) => sum + v * v, 0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * img.nComp;
      const projection = ink.reduce((sum, v, c) => sum + v * (img.data[i + c]! - background[c]!), 0);
      if (projection >= norm / 4) count++;
    }
  }
  return count;
}

function pagePixel(img: PngImage, pageX: number, pageY: number): number[] {
  let left = img.w;
  let top = img.h;
  let right = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.nComp;
      if (kRed.every((value, channel) => Math.abs(img.data[i + channel]! - value) <= kTolerance)) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
      }
    }
  }
  if (right < left) throw new Error("red image missing; cannot locate CMYK sample");
  const scale = (right - left + 1) / 150;
  const x = Math.floor(left + (pageX - 72) * scale);
  const y = Math.floor(top + (600 - pageY) * scale);
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) throw new Error("sample outside canvas");
  const i = (y * img.w + x) * img.nComp;
  return Array.from(img.data.slice(i, i + 3));
}

function blackOnColor(img: PngImage, color: number[]): number {
  let count = 0;
  for (let y = 4; y < img.h - 4; y++) {
    for (let x = 4; x < img.w - 4; x++) {
      const p = (y * img.w + x) * img.nComp;
      if (img.data[p]! > 10 || img.data[p + 1]! > 10 || img.data[p + 2]! > 10) continue;
      for (let dx = -4; dx <= 4; dx++) {
        const q = (y * img.w + x + dx) * img.nComp;
        if (color.every((value, channel) => Math.abs(img.data[q + channel]! - value) < 10)) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

function whiteByMask(img: PngImage): number {
  let count = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 1; x < img.w - 1; x++) {
      const p = (y * img.w + x) * img.nComp;
      if (img.data[p]! < 250 || img.data[p + 1]! < 250 || img.data[p + 2]! < 250) continue;
      const q = p + img.nComp;
      if (img.data[q]! > 245 && img.data[q + 1]! < 10 && img.data[q + 2]! > 245) count++;
    }
  }
  return count;
}

interface Counts {
  red: number;
  green: number;
  white: number;
  backdrop: number;
  overlay: number;
  coveredText: number;
  smallImage: number;
  maskImage: number;
  inlineMaskImage: number;
  maskBackground: number;
  softMaskedImage: number;
  halfMaskedImage: number;
  shade: number;
  annotation: number;
  png: string;
}

async function capture(theme: string, mode: string): Promise<Counts> {
  const dir = tmpPath(`pdfium-theme/${theme.replace(/ /g, "-")}-${mode}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "theme.pdf");
  writeFileSync(pdf, themePdf(), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
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
      white: whiteOutsideShade(img),
      backdrop: countNear(img, kBackdrop),
      overlay: blackOnColor(img, kRed),
      coveredText: blackOnColor(img, kGreen),
      smallImage: countNear(img, kSmallImage),
      maskImage: countNear(img, kMaskImage),
      inlineMaskImage: countNear(img, kInlineMaskImage),
      maskBackground: whiteByMask(img),
      softMaskedImage: countNear(img, kSoftMaskedImage),
      halfMaskedImage: countNear(img, [128, 149, 27]),
      shade: shadeMidpoint(img),
      annotation:
        mode === "legacy"
          ? 0
          : annotationInk(
              img,
              mode === "off" ? [0, 0, 0] : [131, 148, 150],
              mode === "off" ? [255, 255, 255] : [0, 43, 54],
            ),
      png,
    };
    console.log(
      `${theme} ${mode}: red=${counts.red} green=${counts.green} white=${counts.white} backdrop=${counts.backdrop}` +
        ` small=${counts.smallImage} mask=${counts.maskImage} inlineMask=${counts.inlineMaskImage} maskBackground=${counts.maskBackground}` +
        ` softMask=${counts.softMaskedImage} halfMask=${counts.halfMaskedImage} annotation=${counts.annotation}` +
        ` overlay=${counts.overlay} coveredText=${counts.coveredText} ${png}`,
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
  ];
  if (!USE_NG) smartCases.push(["Solarized Dark", "default"]);
  for (const [theme, mode] of smartCases) {
    const name = `${theme} ${mode}`;
    const smart = await capture(theme!, mode!);
    if (smart.white > kMaxWhitePixels) failures.push(`${name}: page not themed (${smart.png})`);
    if (smart.red < kMinPhotoPixels) failures.push(`${name}: page photo recolored (${smart.png})`);
    if (smart.green < kMinPhotoPixels) failures.push(`${name}: form photo recolored (${smart.png})`);
    if (smart.backdrop < kMinPhotoPixels) failures.push(`${name}: figure backdrop recolored (${smart.png})`);
    if (smart.smallImage < kMinSmallImagePixels) failures.push(`${name}: small image recolored (${smart.png})`);
    if (smart.maskImage < kMinSmallImagePixels) failures.push(`${name}: image mask recolored (${smart.png})`);
    if (smart.inlineMaskImage < kMinSmallImagePixels)
      failures.push(`${name}: inline image mask recolored (${smart.png})`);
    if (smart.softMaskedImage < kMinSmallImagePixels)
      failures.push(`${name}: soft-masked image recolored (${smart.png})`);
    if (theme === "Solarized Dark" && smart.halfMaskedImage < kMinSmallImagePixels)
      failures.push(`${name}: half-transparent image changed (${smart.png})`);
    if (theme === "Solarized Dark" && smart.shade < kMinSmallImagePixels)
      failures.push(`${name}: gradient missing theme colors (${smart.png})`);
    if (theme === "Solarized Dark" && smart.annotation < 30)
      failures.push(`${name}: annotation text missing theme colors (${smart.png})`);
    if (smart.maskBackground > 5) failures.push(`${name}: image mask background not themed (${smart.png})`);
    if (theme === "Solarized Dark" && smart.overlay > 5) failures.push(`${name}: image text not themed (${smart.png})`);
    if (smart.coveredText > 5) failures.push(`${name}: covered text shows through image (${smart.png})`);
  }
  const legacy = await capture("Solarized Dark", "legacy");
  if (legacy.red >= kMinPhotoPixels) failures.push(`legacy: photo kept its colors (${legacy.png})`);
  const off = await capture("Solarized Dark", "off");
  if (off.softMaskedImage < kMinSmallImagePixels) failures.push(`off: soft-masked fixture missing (${off.png})`);
  if (off.annotation < 30) failures.push(`off: annotation text missing (${off.png})`);
  if (!USE_NG) {
    try {
      await testThemeSwitch();
    } catch (e) {
      failures.push(`theme switch: ${e}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

export async function testThemeSwitch(): Promise<void> {
  setProcessDpiAware();
  const baseline = await capture("Solarized Dark", "off");
  const baselineCmyk = pagePixel(loadPng(baseline.png), 255, 135);
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
    const counts = {
      red: countNear(img, kRed),
      white: countNear(img, [255, 255, 255]),
      shade: countNear(img, kDarkShadeMidpoint),
      cmyk: countNear(img, kRed) >= kMinPhotoPixels ? pagePixel(img, 255, 135) : [],
      annotation: annotationInk(img, [131, 148, 150], [0, 43, 54]),
      annotationOff: annotationInk(img, [0, 0, 0], [255, 255, 255]),
      annotationLight: annotationInk(img, [0, 0, 0], [242, 242, 242]),
      annotationImage: countNear(img, kAnnotationImage),
    };
    console.log(`${tag}: red=${counts.red} white=${counts.white} shade=${counts.shade}`);
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
    await mode(0x24); // smart -> off
    const initialOff = await captureCurrent("dark-off-after-smart");
    if (initialOff.cmyk.length !== 3 || initialOff.cmyk.some((value, i) => value !== baselineCmyk[i]))
      throw new Error(`CMYK color changed after smart: ${baselineCmyk} -> ${initialOff.cmyk}`);
    console.log(`CMYK color preserved after smart: ${baselineCmyk}`);
    await mode(0x28); // off -> smart
    const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
    if (editor[1] === "editor=none" && process.env.SOLOKPDF_ENGINE !== "mupdf") {
      await client.request(ControlCommand.TestCurrentPdf, [""]);
      const loaded = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (loaded[1] !== "editor=loaded") throw new Error(`annotation editor did not load: ${loaded[1]}`);
      await invoke("CmdRotateRight");
      await invoke("CmdRotateLeft");
      const edited = await captureCurrent("dark-smart-editor");
      if (edited.annotation < 30) throw new Error("annotation text lost theme colors after loading editor");
      if (edited.annotationImage < kMinSmallImagePixels)
        throw new Error("annotation image lost its colors after loading editor");
      await invoke("CmdSetTheme Light");
      const lightEditor = await captureCurrent("light-smart-editor");
      if (lightEditor.annotationLight < 30) throw new Error("annotation text lost light theme colors with editor");
      await invoke("CmdSetTheme Solarized Dark");
      await mode(0x24); // smart -> off
      const offEditor = await captureCurrent("dark-off-editor");
      if (offEditor.annotationOff < 30) throw new Error("annotation text did not return to original color with editor");
      await mode(0x28); // off -> smart
      const restoredEditor = await captureCurrent("dark-smart-editor-restored");
      if (restoredEditor.annotation < 30) throw new Error("annotation text lost theme colors after restoring smart");
    }
    await invoke("CmdRotateRight");
    const rotated = await captureCurrent("dark-smart-rotated");
    if (rotated.red < kMinPhotoPixels || rotated.white > kMaxWhitePixels || rotated.shade < kMinSmallImagePixels)
      throw new Error("rotated page lost image colors or left white paper");
    await invoke("CmdRotateLeft");
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
