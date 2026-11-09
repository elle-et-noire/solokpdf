import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import { APP_NAME, assemblePdf, loadPng, pngPixel, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import { findCanvas, killAndWait, launchControlled } from "./win-automation";
import { captureWindowToPng, getWindowRect, repaintWindow, sleep } from "./winapi";

function ratio(a: number[], b: number[]): number {
  const lum = (v: number[]) =>
    v.reduce((s, c, i) => {
      const x = c / 255;
      return s + [0.2126, 0.7152, 0.0722][i]! * (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    }, 0);
  const x = lum(a),
    y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
type Theme = { name: string; bg: number[]; ink: number[] };
const themes: Theme[] = [
  { name: "Purpy", bg: [44, 27, 48], ink: [226, 195, 195] },
  { name: "Purpy Slate", bg: [32, 34, 42], ink: [226, 195, 195] },
  { name: "One Dark", bg: [40, 44, 52], ink: [171, 178, 191] },
  { name: "Solarized Dark", bg: [0, 43, 54], ink: [131, 148, 150] },
  { name: "Greeny", bg: [79, 98, 50], ink: [253, 208, 133] },
  { name: "Everforest Light", bg: [253, 246, 227], ink: [92, 106, 114] },
  { name: "Light Warm", bg: [235, 230, 218], ink: [51, 51, 51] },
];
async function check(theme: Theme, mode: string, clip: boolean, engine = "pdfium"): Promise<void> {
  const name = `${theme.name}-${mode}-${clip ? "actualtext" : "plain"}-${engine}`;
  const dir = tmpPath(`selection-purpy-${name}`);
  mkdirSync(dir, { recursive: true });
  const content = `${clip ? "/Span << /ActualText (Selected X) >> BDC " : ""}BT /F1 24 Tf 1.4 Tc 72 700 Td (Selected X) Tj ET${clip ? " EMC" : ""}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const path = join(dir, "page.pdf");
  writeFileSync(path, assemblePdf(objects), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `Theme = ${theme.name}\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\nDocumentColorsFollowTheme = ${mode}\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, path], {
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame),
      shot = join(dir, "canvas.png");
    if (!captureWindowToPng(canvas, shot)) throw new Error(`${name}: initial capture failed`);
    const before = loadPng(shot);
    await client.seedTextSelection(1, 0, 8);
    const selected = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
    if (!/^expanded=Selected$/m.test(selected)) throw new Error(`${name}: unexpected selection ${selected}`);
    repaintWindow(canvas);
    await sleep(2000);
    if (!captureWindowToPng(canvas, shot)) throw new Error(`${name}: selection capture failed`);
    const after = loadPng(shot);
    const position = String(
      (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
    );
    const m = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(position);
    if (!m) throw new Error(position);
    const wr = getWindowRect(canvas),
      x0 = +m[1]! - wr.left,
      y0 = +m[2]! - wr.top,
      x1 = x0 + +m[3]!,
      y1 = y0 + +m[4]!;
    const expectedBg = mode === "smart" ? theme.bg : [255, 255, 255];
    const expectedInk = mode === "smart" ? theme.ink : [0, 0, 0];
    const backgrounds = new Map<string, number>(),
      inks = new Map<string, number>();
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (x < 0 || y < 0 || x >= before.w || y >= before.h) continue;
        const a = pngPixel(before, x, y).slice(0, 3) as number[],
          b = pngPixel(after, x, y).slice(0, 3) as number[];
        const near = (p: number[], q: number[]) => p.every((c, i) => Math.abs(c - q[i]!) <= 3);
        const map = near(a, expectedBg) ? backgrounds : near(a, expectedInk) ? inks : null;
        if (map) {
          const key = b.join(",");
          map.set(key, (map.get(key) ?? 0) + 1);
        }
      }
    const common = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const bg = common(backgrounds),
      ink = common(inks);
    if (!bg || !ink) throw new Error(`${name}: insufficient sampled pixels bg=${bg} ink=${ink}`);
    const contrast = ratio(bg[0].split(",").map(Number), ink[0].split(",").map(Number));
    const highlight = ratio(bg[0].split(",").map(Number), expectedBg);
    console.log(`${name}: bg=${bg} ink=${ink} contrast=${contrast.toFixed(2)} highlight=${highlight.toFixed(2)}`);
    const overlay = [51, 153, 255];
    const alpha = 95;
    for (const [label, source, sample] of [
      ["background", expectedBg, bg],
      ["ink", expectedInk, ink],
    ] as const) {
      const actual = sample[0].split(",").map(Number);
      const expected = source.map((c, i) => (c * (255 - alpha) + overlay[i]! * alpha) / 255);
      if (actual.some((c, i) => Math.abs(c - expected[i]!) > 3))
        throw new Error(`${name}: ${label} is ${actual}, expected overlay ${expected}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}
export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") return;
  for (const mode of ["smart", "off"]) for (const clip of [false, true]) await check(themes[0]!, mode, clip);
  await check(themes[0]!, "smart", true, "mupdf");
  await check(themes[4]!, "smart", false);
  for (const theme of themes.slice(1)) await check(theme, "smart", true);
}
if (import.meta.main) await runStandalone(testit);
