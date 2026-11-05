import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { IS_MAC } from "./host.ts";
import { assemblePdf, loadPng, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowToPng } from "./winapi.ts";

type Fixture = {
  name: string;
  space: string;
  color: string;
  form?: boolean;
  ordinary?: boolean;
  annot?: boolean;
  plain?: boolean;
  extra?:
    | "text"
    | "nested"
    | "type3"
    | "nested-unused"
    | "deep"
    | "nested-mask"
    | "nested-inline"
    | "soft-fill"
    | "soft-image"
    | "soft-shade"
    | "gs-font";
};
const fixtures: Fixture[] = [
  { name: "gray", space: "DeviceGray", color: ".6" },
  { name: "rgb", space: "DeviceRGB", color: ".2 .6 .8" },
  { name: "cmyk", space: "DeviceCMYK", color: ".8 .2 .1 .1" },
  { name: "form", space: "DeviceRGB", color: ".2 .6 .8", form: true },
  { name: "annotation", space: "DeviceRGB", color: ".2 .6 .8", annot: true },
  { name: "unused-pattern", space: "DeviceRGB", color: ".2 .6 .8", ordinary: true },
  { name: "plain", space: "DeviceRGB", color: ".2 .6 .8", ordinary: true, plain: true },
  { name: "text", space: "DeviceRGB", color: ".2 .6 .8", extra: "text" },
  { name: "nested", space: "DeviceRGB", color: ".2 .6 .8", extra: "nested" },
  { name: "type3", space: "DeviceRGB", color: ".2 .6 .8", extra: "type3" },
  { name: "nested-unused", space: "DeviceRGB", color: ".2 .6 .8", extra: "nested-unused", ordinary: true },
  { name: "deep", space: "DeviceRGB", color: ".2 .6 .8", extra: "deep" },
  { name: "nested-mask", space: "DeviceRGB", color: ".2 .6 .8", extra: "nested-mask" },
  { name: "nested-inline", space: "DeviceRGB", color: ".2 .6 .8", extra: "nested-inline" },
  ...(["soft-fill", "soft-image", "soft-shade", "gs-font"] as const).map((extra) => ({
    name: extra,
    space: "DeviceGray",
    color: ".6",
    extra,
  })),
];

function stream(dict: string, content: string): string {
  return `<< ${dict} /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

function extraPdf(kind: NonNullable<Fixture["extra"]>): string {
  if (kind.startsWith("soft-") || kind === "gs-font") return extStatePdf(kind);
  const patterns = "/ColorSpace << /PCS [/Pattern /DeviceRGB] >> /Pattern << /P 5 0 R >>";
  let resources = `${patterns} /Font << /F 6 0 R >>`;
  let content = "q /PCS CS .2 .6 .8 /P SCN 12 w BT /F 180 Tf 1 Tr 70 210 Td (ABC) Tj ET Q";
  let objects = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  if (kind === "nested" || kind === "nested-unused" || kind === "nested-mask" || kind === "nested-inline") {
    resources = "/Pattern << /Outer 6 0 R >>";
    content = "q /Pattern cs /Outer scn 50 50 500 500 re f Q";
    if (kind === "nested-unused") content = "q /Pattern cs /Outer scn .2 .6 .8 RG 50 w 100 100 400 400 re S Q";
    objects = [
      stream(
        `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100 /Resources << ${patterns} >>`,
        "q /PCS CS .2 .6 .8 /P SCN 10 w 15 15 70 70 re S Q",
      ),
    ];
    if (kind === "nested-mask" || kind === "nested-inline") {
      resources += " /XObject << /Im 7 0 R >>";
      const mask = "\0".repeat(8);
      content =
        "q /Pattern cs /Outer scn 500 0 0 500 50 50 cm " +
        (kind === "nested-inline" ? `BI /W 8 /H 8 /IM true /BPC 1 /L 8 ID\n${mask}\nEI` : "/Im Do") +
        " Q";
      objects.push(
        stream("/Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1", mask),
      );
    }
  } else if (kind === "deep") {
    resources = `${patterns} /XObject << /Fm 6 0 R >>`;
    content = "q /PCS CS .2 .6 .8 /P SCN /Fm Do Q";
    const depth = 16;
    objects = Array.from({ length: depth }, (_, i) =>
      stream(
        `/Type /XObject /Subtype /Form /BBox [0 0 600 600] /Resources << ${i + 1 < depth ? `/XObject << /Fm ${7 + i} 0 R >>` : ""} >>`,
        i + 1 < depth ? "/Fm Do" : "50 w 100 100 400 400 re S",
      ),
    );
  } else if (kind === "type3") {
    resources = "/Font << /F 6 0 R >>";
    content = "q BT /F 400 Tf 100 100 Td (A) Tj ET Q";
    objects = [
      `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << ${patterns} >> >>`,
      stream("", "1000 0 d0 q /PCS CS .2 .6 .8 /P SCN 150 w 150 150 700 700 re S Q"),
    ];
  }
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << ${resources} >> /Contents 4 0 R >>`,
    stream("", content),
    stream(
      "/Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>",
      "0 0 10 10 re f",
    ),
    ...objects,
  ]);
}

function extStatePdf(kind: string): string {
  const patterns = "/ColorSpace << /PCS [/Pattern /DeviceGray] >> /Pattern << /P 5 0 R >>";
  const pattern = stream(
    "/Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>",
    "0 0 10 10 re f",
  );
  const resources =
    "/ExtGState << /GS 6 0 R >> " +
    (kind === "soft-shade" ? "/Shading << /Sh 8 0 R >>" : kind === "soft-image" ? "/XObject << /Im 8 0 R >>" : "");
  const mark =
    kind === "soft-image"
      ? "600 0 0 600 0 0 cm /Im Do"
      : kind === "soft-shade"
        ? "/Sh sh"
        : "1 0 0 rg 0 0 600 600 re f";
  const content = kind === "gs-font" ? "q /GS gs BT 100 100 Td (A) Tj ET Q" : `q /GS gs ${mark} Q`;
  const objects =
    kind === "gs-font"
      ? [
          "<< /Type /ExtGState /Font [7 0 R 400] >>",
          `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A 8 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << ${patterns} >> >>`,
          stream("", "1000 0 d0 q /PCS CS .6 /P SCN 150 w 150 150 700 700 re S Q"),
        ]
      : [
          "<< /Type /ExtGState /SMask << /S /Luminosity /G 7 0 R >> >>",
          stream(
            `/Type /XObject /Subtype /Form /BBox [0 0 600 600] /Group << /S /Transparency /CS /DeviceGray >> /Resources << ${patterns} >>`,
            "q /PCS CS .6 /P SCN 50 w 100 100 400 400 re S Q",
          ),
          kind === "soft-shade"
            ? "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 600 0] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [1 0 0] /N 1 >> >>"
            : stream(
                "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8",
                "\xff\0\0",
              ),
        ];
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << ${resources} >> /Contents 4 0 R >>`,
    stream("", content),
    pattern,
    ...objects,
  ]);
}

function makePdf(fixture: Fixture): string {
  if (fixture.extra) return extraPdf(fixture.extra);
  const pattern = "0 0 10 10 re f";
  const stroke = "50 w 100 100 400 400 re S";
  const colors = fixture.plain ? "" : `/PCS CS ${fixture.color} /P SCN`;
  const resources = fixture.plain ? "" : `/ColorSpace << /PCS [/Pattern /${fixture.space}] >> /Pattern << /P 5 0 R >>`;
  const content = `q ${colors} ${fixture.ordinary ? ".2 .6 .8 RG" : ""} ${fixture.form ? "/Fm Do" : stroke} Q`;
  const pageContent = fixture.annot ? "" : content;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << ${resources} /XObject << /Fm 6 0 R >> >> /Contents 4 0 R ${fixture.annot ? "/Annots [7 0 R]" : ""} >>`,
    `<< /Length ${pageContent.length} >>\nstream\n${pageContent}\nendstream`,
    `<< /Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Length ${pattern.length} >>\nstream\n${pattern}\nendstream`,
  ];
  const form = fixture.annot ? content : stroke;
  objects.push(
    `<< /Type /XObject /Subtype /Form /BBox [0 0 600 600] /Resources << ${fixture.annot ? resources : ""} >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
  );
  if (fixture.annot) objects.push("<< /Type /Annot /Subtype /Stamp /Rect [0 0 600 600] /F 4 /AP << /N 6 0 R >> >>");
  return assemblePdf(objects);
}

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
  if (count < 500) throw new Error(`stroke missing: ${path}`);
  return color.split(",").map(Number);
}

async function sample(engine: string, fixture: Fixture, mode: string): Promise<number[]> {
  const dir = tmpPath(`pdfium-pattern-strokes-${engine}-${fixture.name}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "stroke.pdf");
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
    if (engine === "pdfium" && mode === "off" && fixture.ordinary) {
      for (const command of ["CmdZoomIn", "CmdSetTheme Dark", "CmdSetTheme Solarized Dark"]) {
        await client.request(ControlCommand.TestInvokeCommand, [command]);
        await client.waitForRenderIdle();
      }
    }
    await client.quit();
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`${fixture.name}/${mode}: app exited with ${exitCode}`);
    if (engine === "pdfium") {
      const text = readFileSync(log, "utf8");
      const checks = [...text.matchAll(/PDFium render check: page=1 probe=(\d) backend=(\w+)/g)];
      const expectedBackend = fixture.ordinary ? "pdfium" : "mupdf";
      if (checks.length !== 1 || checks[0]![2] !== expectedBackend)
        throw new Error(`${fixture.name}/${mode}: render checks ${checks}`);
      if (fixture.plain && checks[0]![1] !== "0") throw new Error("plain page contents were scanned");
      const opens = [...text.matchAll(/PDFium render probe: opened/g)].length;
      const canceled = [...text.matchAll(/PDFium render probe: canceled/g)].length;
      if (opens !== canceled + 1) throw new Error(`${fixture.name}/${mode}: render probe was reopened`);
    }
    return color;
  } finally {
    await killAndWait(proc);
  }
}

async function checkCachedPages(): Promise<void> {
  const dir = tmpPath("pdfium-pattern-cache");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "pages.pdf");
  const log = join(dir, "render.log");
  const plain = ".2 .6 .8 RG 50 w 100 100 400 400 re S";
  const colored = "/PCS CS .2 .6 .8 /P SCN 50 w 100 100 400 400 re S";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << >> /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /ColorSpace << /PCS [/Pattern /DeviceRGB] >> /Pattern << /P 7 0 R >> >> /Contents 6 0 R >>",
      stream("", plain),
      stream("", colored),
      stream(
        "/Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>",
        "0 0 10 10 re f",
      ),
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nDefaultDisplayMode = single page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = off\n",
  );
  writeFileSync(log, "");
  const { proc, client } = await launchControlled(["-appdata", dir, "-log-to-file", log, pdf], {
    env: { SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "1" },
  });
  try {
    await client.setNotificationsEnabled(false);
    for (const page of [1, 2, 1, 2]) {
      await client.goToLocation(1, page);
      await client.waitForRenderIdle();
      for (const command of ["CmdZoomIn", "CmdTogglePreservePdfImages", "CmdSetTheme Dark"]) {
        const result = await client.request(ControlCommand.TestInvokeCommand, [command]);
        if (result[0] !== 0) throw new Error(`cache command failed: ${result}`);
        await client.waitForRenderIdle();
      }
    }
    await client.quit();
    await proc.exited;
    const text = readFileSync(log, "utf8");
    const checks = [...text.matchAll(/PDFium render check: page=(\d) probe=(\d) backend=(\w+)/g)];
    const opens = [...text.matchAll(/PDFium render probe: opened/g)].length;
    const canceled = [...text.matchAll(/PDFium render probe: canceled/g)].length;
    if (checks.length !== 2 || opens !== canceled + 1) {
      throw new Error(
        `document/page probe repeated: ${checks.length} page checks, ${opens} document opens, ${canceled} canceled`,
      );
    }
    for (const [page, probe, backend] of [
      ["1", "0", "pdfium"],
      ["2", "1", "mupdf"],
    ]) {
      if (!checks.some((m) => m[1] === page && m[2] === probe && m[3] === backend))
        throw new Error(`wrong cached routes: ${checks}`);
    }
    console.log(
      "page routes: one document parse plus canceled retries, one check per page across zoom/theme/mode changes",
    );
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (IS_MAC || USE_NG) return;
  const failures: string[] = [];
  const names = process.argv
    .find((a) => a.startsWith("--case="))
    ?.slice("--case=".length)
    .split(",");
  const selected = names ? fixtures.filter((f) => names.includes(f.name)) : fixtures;
  const checkCache = !names || names.includes("cache");
  if (!selected.length && !checkCache) throw new Error("no matching pattern fixtures");
  for (const fixture of selected) {
    for (const mode of ["off", "smart", "legacy"]) {
      try {
        const expected = await sample("mupdf", fixture, mode);
        const actual = await sample("pdfium", fixture, mode);
        if (mode === "off" && expected.every((v) => v < 20)) throw new Error("reference stroke is black");
        if (actual.some((v, c) => Math.abs(v - expected[c]!) > 4))
          throw new Error(`${fixture.name}/${mode}: ${actual}, expected ${expected}`);
        console.log(`${fixture.name}/${mode}: ${actual}`);
      } catch (e) {
        failures.push(String(e));
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  if (checkCache) await checkCachedPages();
}

if (import.meta.main) await runStandalone(testit);
