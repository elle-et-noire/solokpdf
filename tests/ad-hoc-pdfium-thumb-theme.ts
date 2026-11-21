import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, loadPng, pollUntil, runStandalone, tmpPath, type PngImage } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { captureWindowToPng, setProcessDpiAware, sleep } from "./winapi.ts";

function count(img: PngImage, rgb: number[]): number {
  let n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const p = i * img.nComp;
    if (rgb.every((c, k) => Math.abs(img.data[p + k]! - c) <= 8)) n++;
  }
  return n;
}

function thumbnailPdf(): string {
  let pixels = "";
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const red = x >= 8 && x < 24 && y >= 8 && y < 24;
      const rgb = red ? [255, 0, 0] : [(x * 7 + y * 3) % 150, (x * 5 + y * 9) % 150, 80 + ((x * 11 + y) % 100)];
      pixels += String.fromCharCode(...rgb);
    }
  }
  const page = "BT /F1 28 Tf 72 700 Td (Themed page text) Tj ET\nq 150 0 0 150 72 450 cm /Im1 Do Q";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>",
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`,
  ]);
}

function splitThumbnailPng(png: Buffer): { plain: Buffer; metadata: Buffer } | undefined {
  for (let off = 8; off + 12 <= png.length; ) {
    const size = png.readUInt32BE(off);
    const next = off + 12 + size;
    if (next > png.length) break;
    if (png.toString("ascii", off + 4, off + 8) === "stMD") {
      return {
        plain: Buffer.concat([png.subarray(0, off), png.subarray(next)]),
        metadata: png.subarray(off + 8, next - 4),
      };
    }
    off = next;
  }
}

async function checkFailedReplacement(client: ControlClient, png: string, log: string) {
  const legacy = splitThumbnailPng(readFileSync(png));
  if (!legacy || legacy.metadata.length < 24 || legacy.metadata.readUInt32LE(20) === 0) {
    throw new Error("Home thumbnail photo bounds missing");
  }
  const sidecar = `${png}.theme`;
  writeFileSync(png, legacy.plain);
  writeFileSync(sidecar, legacy.metadata);

  const rerender = async () => {
    const res = await client.request(ControlCommand.TestCurrentPdf, ["render-home-thumbnail"]);
    if (res[0] !== 0) throw new Error(`Home rerender failed: ${res[1]}`);
  };
  chmodSync(png, 0o444);
  try {
    await rerender();
    await pollUntil(() => readFileSync(log, "utf8").includes("SaveThumbnail: Save("), Boolean, {
      error: "read-only PNG did not reject replacement",
    });
    if (!readFileSync(png).equals(legacy.plain) || !readFileSync(sidecar).equals(legacy.metadata)) {
      throw new Error("failed replacement changed the old Home thumbnail pair");
    }
  } finally {
    chmodSync(png, 0o666);
  }
  await rerender();
  await pollUntil(() => !existsSync(sidecar) && !!splitThumbnailPng(readFileSync(png)), Boolean, {
    error: "Home thumbnail retry did not publish the PNG with metadata",
  });
}

export async function testit(): Promise<void> {
  let grayscaleFailed = false;
  setProcessDpiAware();
  const dir = tmpPath("pdfium-thumb-theme");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "theme.pdf");
  const log = join(dir, "app.log");
  writeFileSync(pdf, thumbnailPdf(), "latin1");
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = true\nNoHomeTab = false\nRememberOpenedFiles = true\nHomePageViewMode = thumbnails\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, "-log-to-file", log, pdf]);
  const shot = (hwnd: number, name: string) => {
    const path = join(dir, `${name}.png`);
    if (!captureWindowToPng(hwnd, path)) throw new Error(`${name}: capture failed`);
    const img = loadPng(path);
    const white = count(img, [255, 255, 255]);
    const red = count(img, [255, 0, 0]);
    let redX = img.w;
    let redY = img.h;
    let redBottom = 0;
    for (let y = 60; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const p = (y * img.w + x) * img.nComp;
        if (Math.abs(img.data[p]! - 255) > 8 || img.data[p + 1]! > 8 || img.data[p + 2]! > 8) continue;
        redX = Math.min(redX, x);
        redY = Math.min(redY, y);
        redBottom = Math.max(redBottom, y);
      }
    }
    if (red < 100 || redX < 22) throw new Error(`${name}: photo missing`);
    const p = (Math.floor((redY + redBottom) / 2) * img.w + redX - 20) * img.nComp;
    const paper = [img.data[p]!, img.data[p + 1]!, img.data[p + 2]!];
    console.log(`${name}: white=${white} red=${red} paper=${paper}`);
    return { white, red, paper: paper.reduce((sum, c) => sum + c, 0) };
  };
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    let raw = "";
    for (let i = 0; i < 40; i++) {
      const res = await client.request(ControlCommand.TestSidebarThumbnails, []);
      raw = String(res[1] ?? "");
      if (/rendered=[1-9]/.test(raw)) break;
      await sleep(50);
    }
    const match = /hwnd=(\d+)/.exec(raw);
    if (!match || !/rendered=[1-9]/.test(raw)) throw new Error(`F12 thumbnail missing: ${raw}`);
    const f12 = shot(Number(match[1]), "f12-dark");
    if (f12.paper > 300) throw new Error("F12 thumbnail lost dark paper");

    sendCommandSync(frame, cmdId("CmdToggleGrayscale"));
    await sleep(150);
    const grayPath = join(dir, "f12-gray.png");
    if (!captureWindowToPng(Number(match[1]), grayPath)) throw new Error("F12 grayscale capture failed");
    grayscaleFailed = count(loadPng(grayPath), [255, 0, 0]) > 10;
    sendCommandSync(frame, cmdId("CmdToggleGrayscale"));
    await sleep(150);

    const changeTheme = async (theme: string) => {
      const res = await client.request(ControlCommand.TestInvokeCommand, [`CmdSetTheme ${theme}`]);
      if (res[0] !== 0) throw new Error(`theme change failed: ${res[1]}`);
    };
    const waitF12 = async () => {
      for (let i = 0; i < 40; i++) {
        const state = await client.request(ControlCommand.TestSidebarThumbnails, []);
        const info = String(state[1] ?? "");
        const hwnd = /hwnd=(\d+)/.exec(info);
        if (/rendered=[1-9]/.test(info) && hwnd) return Number(hwnd[1]);
        await sleep(50);
      }
      throw new Error("F12 thumbnail did not redraw");
    };
    await changeTheme("Light");
    const lightHwnd = await waitF12();
    const f12Light = shot(lightHwnd, "f12-light");
    if (f12Light.paper < 600) throw new Error("F12 thumbnail did not switch to light paper");
    await changeTheme("Solarized Dark");
    await waitF12();

    const cache = join(dir, "sumatrapdfcache");
    const png = await pollUntil(
      () => (existsSync(cache) ? readdirSync(cache).find((name) => name.endsWith(".png")) : undefined),
      Boolean,
      { error: "Home thumbnail PNG missing" },
    );
    const pngPath = join(cache, png!);
    await checkFailedReplacement(client, pngPath, log);

    const { idx: documentTab } = await client.selectTab();
    await client.selectTab(0);
    const canvas = findCanvas(frame);
    const original = shot(canvas, "home-original");
    if (original.paper > 300) throw new Error("Home thumbnail lost dark paper");
    await client.selectTab(documentTab);
    const adjust = async (brightness: number, contrast: number) => {
      const res = await client.request(ControlCommand.TestPageAdjust, [brightness, contrast]);
      if (res[0] !== 0) throw new Error(`page adjust failed: ${res[1]}`);
    };
    // These adjustments shared a cache key with brightness=0, contrast=0.
    await adjust(1, -31);
    await client.selectTab(0);
    const adjustedPath = join(dir, "home-adjusted.png");
    await pollUntil(
      () => captureWindowToPng(canvas, adjustedPath) && count(loadPng(adjustedPath), [217, 41, 41]) >= 100,
      Boolean,
      { error: "Home did not show the adjusted photo pixels" },
    );
    await client.selectTab(documentTab);
    await adjust(0, 0);

    sendCommandSync(frame, cmdId("CmdClose"));
    for (let i = 0; i < 40; i++) {
      const home = await client.homeSelection("thumbnails");
      if (home.ready && home.entries >= 1) break;
      await sleep(50);
    }
    await sleep(100);
    const dark = shot(canvas, "home-dark");
    if (dark.paper > 300) throw new Error("Home thumbnail lost dark paper");

    const neutral = loadPng(pngPath);
    if (count(neutral, [255, 255, 255]) < 1000) throw new Error("Home PNG is not theme neutral");

    await changeTheme("Light");
    await sleep(150);
    const light = shot(canvas, "home-light");
    if (light.paper < 600) throw new Error("Home thumbnail did not return to light paper");
  } finally {
    await killAndWait(proc);
  }

  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = true\nRememberOpenedFiles = true\nHomePageViewMode = thumbnails\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\nFileStates [\n\t[\n\t\tFilePath = ${pdf}\n\t\tOpenCount = 1\n\t]\n]\n`,
  );
  const reopened = await launchControlled(["-appdata", dir]);
  try {
    const home = await reopened.client.homeSelection("thumbnails");
    if (!home.ready || home.entries !== 1) throw new Error(`saved Home thumbnail missing: ${home.raw}`);
    await sleep(100);
    const savedDark = shot(findCanvas(reopened.frame), "saved-home-dark");
    if (savedDark.paper > 300) throw new Error("saved Home thumbnail lost dark paper");
    const changed = await reopened.client.request(ControlCommand.TestInvokeCommand, ["CmdSetTheme Light"]);
    if (changed[0] !== 0) throw new Error(`saved theme change failed: ${changed[1]}`);
    await sleep(150);
    const savedLight = shot(findCanvas(reopened.frame), "saved-home-light");
    if (savedLight.paper < 600) throw new Error("saved Home thumbnail did not switch to light paper");
  } finally {
    await killAndWait(reopened.proc);
  }

  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = true\nRememberOpenedFiles = true\nHomePageViewMode = thumbnails\nTheme = Solarized Dark\nDocumentColorsFollowTheme = legacy\nFileStates [\n\t[\n\t\tFilePath = ${pdf}\n\t\tOpenCount = 1\n\t]\n]\n`,
  );
  const legacy = await launchControlled(["-appdata", dir]);
  let legacyFailed = false;
  try {
    const home = await legacy.client.homeSelection("thumbnails");
    if (!home.ready || home.entries !== 1) throw new Error(`legacy Home thumbnail missing: ${home.raw}`);
    await sleep(100);
    const path = join(dir, "home-legacy.png");
    if (!captureWindowToPng(findCanvas(legacy.frame), path)) throw new Error("legacy Home capture failed");
    legacyFailed = count(loadPng(path), [255, 0, 0]) > 10;
  } finally {
    await killAndWait(legacy.proc);
  }
  if (grayscaleFailed || legacyFailed) {
    throw new Error(`F12 ignored grayscale=${grayscaleFailed}; legacy Home preserved photo colors=${legacyFailed}`);
  }
}

if (import.meta.main) await runStandalone(testit);
