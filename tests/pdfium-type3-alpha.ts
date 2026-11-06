import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { IS_MAC } from "./host.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

// PDFium paints colored (d0) Type 3 glyphs opaque; affected pages must render with MuPDF.
type Fixture = {
  name: string;
  route: "pdfium" | "mupdf";
  page: string;
  resources?: string;
  objects?: string[];
  glyph?: string;
  fontResources?: string;
  annot?: boolean;
  acroForm?: boolean;
};

const colored = "1000 0 d0 .8 .2 .1 rg 0 0 1000 1000 re f";
const text = "BT /F 500 Tf 50 50 Td (A) Tj ET";
const group = "/Group << /S /Transparency >>";

function stream(dict: string, content: string): string {
  return `<< ${dict} /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

function form(dict: string, content: string): string {
  const resources = "/Font << /F 5 0 R >> /ExtGState << /Half 7 0 R >>";
  return stream(`/Type /XObject /Subtype /Form /BBox [0 0 600 600] /Resources << ${resources} >> ${dict}`, content);
}

const fixtures: Fixture[] = [
  { name: "fill-alpha", route: "mupdf", page: `/Half gs ${text}` },
  { name: "opaque", route: "pdfium", page: text },
  { name: "uncolored", route: "pdfium", page: `/Half gs ${text}`, glyph: "1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f" },
  { name: "restored", route: "pdfium", page: `q /Half gs Q ${text}` },
  { name: "form-alpha", route: "mupdf", page: "/Half gs /Fm Do", objects: [form("", text)] },
  { name: "group-alpha", route: "pdfium", page: "/Half gs /Fm Do", objects: [form(group, text)] },
  {
    name: "soft-mask",
    route: "pdfium",
    page: `/Masked gs ${text}`,
    objects: [
      "<< /Type /ExtGState /SMask << /S /Luminosity /G 9 0 R >> >>",
      stream(
        "/Type /XObject /Subtype /Form /BBox [0 0 600 600] /Group << /S /Transparency /CS /DeviceGray >>",
        ".5 g 0 0 600 600 re f",
      ),
    ],
    resources: "/ExtGState << /Half 7 0 R /Masked 8 0 R >>",
  },
  {
    // the outer glyph is opaque; its procedure sets the alpha and shows a colored inner Type 3 glyph
    name: "nested",
    route: "mupdf",
    page: text,
    glyph: "1000 0 d0 /Half gs BT /G 1000 Tf 0 0 Td (A) Tj ET",
    fontResources: "/Font << /G 9 0 R >> /ExtGState << /Half 7 0 R >>",
    objects: [
      form("", ""),
      "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A 10 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << >> >>",
      stream("", colored),
    ],
  },
  {
    name: "widget-alpha",
    route: "mupdf",
    page: "",
    annot: true,
    acroForm: true,
    objects: [
      form("", `/Half gs ${text}`),
      "<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (b) /Rect [0 0 600 600] /F 4 /AP << /N 8 0 R >> >>",
    ],
  },
  {
    name: "annot-alpha",
    route: "mupdf",
    page: "",
    annot: true,
    objects: [
      form("", `/Half gs ${text}`),
      "<< /Type /Annot /Subtype /Stamp /Rect [0 0 600 600] /F 4 /AP << /N 8 0 R >> >>",
    ],
  },
];

function makePdf(fixture: Fixture): string {
  const resources = fixture.resources ?? "/ExtGState << /Half 7 0 R >>";
  const glyph = fixture.glyph ?? colored;
  const annots = fixture.annot ? "/Annots [9 0 R]" : "";
  const acroForm = fixture.acroForm ? "/AcroForm << /Fields [9 0 R] >>" : "";
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R ${acroForm} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /Font << /F 5 0 R >> /XObject << /Fm 8 0 R >> ${resources} >> /Contents 4 0 R ${annots} >>`,
    stream("", fixture.page),
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A 6 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << ${fixture.fontResources ?? ""} >> >>`,
    stream("", glyph),
    "<< /Type /ExtGState /ca .5 >>",
    ...(fixture.objects ?? [form("", "")]),
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
  if (count < 500) throw new Error(`glyph missing: ${path}`);
  return color.split(",").map(Number);
}

async function sample(engine: string, fixture: Fixture, mode: string): Promise<{ color: number[]; route: string }> {
  const dir = tmpPath(`pdfium-type3-alpha-${engine}-${fixture.name}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "type3.pdf");
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
    if (engine === "pdfium") {
      // routes are cached: zoom and theme changes must not re-check the page
      for (const command of ["CmdZoomIn", "CmdSetTheme Dark", "CmdSetTheme Solarized Dark"]) {
        const result = await client.request(ControlCommand.TestInvokeCommand, [command]);
        if (result[0] !== 0) throw new Error(`${command}: ${result}`);
        await client.waitForRenderIdle();
      }
    }
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
  if (!selected.length) throw new Error("no matching Type 3 fixtures");
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
