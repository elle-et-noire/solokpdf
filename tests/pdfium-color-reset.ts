import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_MAC } from "./host.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

// `cs`/`CS` reset the color to the space's initial value. PDFium keeps painting with the
// previous color until the next color operator; affected pages must render with MuPDF.
type Fixture = { name: string; route: "pdfium" | "mupdf"; page: string; form?: string; annot?: string };

const fill = "0 0 600 600 re f";

const fixtures: Fixture[] = [
  { name: "fill", route: "mupdf", page: `1 0 0 rg /DeviceRGB cs ${fill}` },
  { name: "stroke", route: "mupdf", page: "1 0 0 RG 300 w /DeviceRGB CS 300 0 m 300 600 l S" },
  { name: "text", route: "mupdf", page: "1 0 0 rg /DeviceRGB cs BT /F 500 Tf 40 100 Td (M) Tj ET" },
  { name: "mask", route: "mupdf", page: "1 0 0 rg /DeviceRGB cs q 600 0 0 600 0 0 cm /Im Do Q" },
  { name: "form", route: "mupdf", page: "1 0 0 rg /DeviceRGB cs /Fm Do", form: fill },
  { name: "annot", route: "mupdf", page: "", annot: `1 0 0 rg /DeviceRGB cs ${fill}` },
  { name: "separation", route: "mupdf", page: `/Spot cs ${fill}` },
  { name: "explicit", route: "pdfium", page: `1 0 0 rg /DeviceRGB cs 0 .5 0 sc ${fill}` },
  { name: "restored", route: "pdfium", page: `1 0 0 rg q /DeviceGray cs Q ${fill}` },
  { name: "initial", route: "mupdf", page: `/DeviceRGB cs ${fill}` },
  { name: "other-side", route: "pdfium", page: `1 0 0 rg 1 0 0 RG /DeviceRGB CS ${fill}` },
];

function stream(dict: string, content: string): string {
  return `<< ${dict} /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

function makePdf(fixture: Fixture): string {
  const spot = "/Spot [/Separation /Red /DeviceRGB << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [1 0 0] /N 1 >>]";
  const resources = `/Font << /F 5 0 R >> /XObject << /Im 6 0 R /Fm 7 0 R >> /ColorSpace << ${spot} >>`;
  const annots = fixture.annot ? "/Annots [8 0 R]" : "";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << ${resources} >> /Contents 4 0 R ${annots} >>`,
    stream("", fixture.page),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("/Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1", "\0".repeat(8)),
    stream("/Type /XObject /Subtype /Form /BBox [0 0 600 600] /Resources << >>", fixture.form ?? ""),
    "<< /Type /Annot /Subtype /Square /Rect [0 0 600 600] /F 4 /AP << /N 9 0 R >> >>",
    stream("/Type /XObject /Subtype /Form /BBox [0 0 600 600] /Resources << >>", fixture.annot ?? ""),
  ]);
}

// Most frequent color in the middle of the canvas, ignoring white paper and the theme surround.
function dominant(path: string): number[] {
  const img = loadPng(path);
  const counts = new Map<string, number>();
  for (let y = Math.floor(img.h * 0.15); y < img.h * 0.85; y++) {
    for (let x = Math.floor(img.w * 0.15); x < img.w * 0.85; x++) {
      const p = (y * img.w + x) * img.nComp;
      const rgb = Array.from(img.data.subarray(p, p + 3));
      if (rgb.every((v) => v === 255) || rgb.join(",") === "0,43,54") continue;
      const key = rgb.join(",");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const [color, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (count < 500) throw new Error(`paint missing: ${path}`);
  return color.split(",").map(Number);
}

async function sample(engine: string, fixture: Fixture, mode: string): Promise<{ color: number[]; route: string }> {
  const dir = tmpPath(`pdfium-color-reset-${engine}-${fixture.name}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "reset.pdf");
  const log = join(dir, "render.log");
  writeFileSync(pdf, makePdf(fixture), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = ${mode}\n`,
  );
  writeFileSync(log, "");
  const { proc, client, frame } = await launchControlled(["-appdata", dir, "-log-to-file", log, pdf], {
    env: { SOLOKPDF_ENGINE: engine, SOLOKPDF_PROFILE: "1" },
  });
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    const path = join(dir, "canvas.png");
    if (!captureWindowToPng(findCanvas(frame), path)) throw new Error("capture failed");
    const color = dominant(path);
    await client.quit();
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`${fixture.name}/${mode}: app exited with ${exitCode}`);
    const checks = [...readFileSync(log, "utf8").matchAll(/PDFium render check: page=1 probe=\d backend=(\w+)/g)];
    return { color, route: checks.map((m) => m[1]).join("+") };
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (IS_MAC || USE_NG) return;
  const names = process.argv
    .find((a) => a.startsWith("--case="))
    ?.slice("--case=".length)
    .split(",");
  const selected = names ? fixtures.filter((f) => names.includes(f.name)) : fixtures;
  if (!selected.length) throw new Error("no matching color reset fixtures");
  const failures: string[] = [];
  for (const fixture of selected) {
    for (const mode of ["off", "smart", "legacy"]) {
      try {
        const expected = (await sample("mupdf", fixture, mode)).color;
        const { color, route } = await sample("pdfium", fixture, mode);
        const errors = [];
        if (color.some((v, c) => Math.abs(v - expected[c]!) > 4)) errors.push(`color ${color}, expected ${expected}`);
        if (route !== fixture.route) errors.push(`render checks "${route}", expected one ${fixture.route} check`);
        if (errors.length) throw new Error(`${fixture.name}/${mode}: ${errors.join("; ")}`);
        console.log(`${fixture.name}/${mode}: ${color} via ${route}`);
      } catch (e) {
        failures.push(String(e));
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
