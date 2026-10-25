import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemblePdf, loadPng } from "../../tests/util.ts";

const out = resolve("out/solok-phase4-font-check");
const dpi = 96;
const pointsPerInch = 72;
const scale = dpi / pointsPerInch;
const pageHeight = 1220;
const firstBaseline = 1180;
const rowSpacing = 38;
const standardFontCount = 14;
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
mkdirSync(out, { recursive: true });
const names = [
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Symbol",
  "ZapfDingbats",
  "Arial",
  "ArialMT",
  "Arial-BoldMT",
  "Arial-BoldItalicMT",
  "Calibri",
  "Calibri-Bold",
  "Cambria",
  "CambriaMath",
  "Consolas",
  "CourierNewPSMT",
  "TimesNewRomanPSMT",
  "TimesNewRomanPS-BoldMT",
  "SegoeUI",
  "SegoeUI-Bold",
  "Meiryo",
  "MS-Gothic",
];
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "", ""];
const fonts: string[] = [];
const lines: string[] = [];
for (const [i, name] of names.entries()) {
  const font = objects.length + 1;
  const descriptor =
    i < standardFontCount
      ? ""
      : ` /FontDescriptor ${font + 1} 0 R /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(600).join(" ")}]`;
  objects.push(
    `<< /Type /Font /Subtype /${i < standardFontCount ? "Type1" : "TrueType"} /BaseFont /${name} /Encoding /WinAnsiEncoding${descriptor} >>`,
  );
  if (descriptor)
    objects.push(
      `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [-100 -250 1100 1000] /ItalicAngle ${name.includes("Italic") ? -12 : 0} /Ascent 900 /Descent -250 /CapHeight 700 /StemV 80 >>`,
    );
  fonts.push(`/F${i} ${font} 0 R`);
  lines.push(`BT /F${i} 18 Tf 20 ${firstBaseline - i * rowSpacing} Td (${name}: ABC abc 0123 +-=) Tj ET`);
}
const content = lines.join("\n");
objects[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${pageHeight}] /Resources << /Font << ${fonts.join(" ")} >> >> /Contents 4 0 R >>`;
objects[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
const fixture = join(out, "fonts.pdf");
writeFileSync(fixture, assemblePdf(objects), "latin1");
const input = resolve(".work/corpus/attention-1706.03762v7.pdf");
const probe = resolve("out/pdfium-probe/pdfium-render.exe");
const results: unknown[] = [];
let matches = true;
for (let run = 0; run < 3; run++) {
  for (const [name, pdf, page] of [
    ["paper-1", input, 1],
    ["paper-4", input, 4],
    ["fonts", fixture, 1],
  ] as const) {
    const rows = [];
    for (const version of run % 2 === 0 ? [1, 2] : [2, 1]) {
      const png = join(out, `${name}-${run}-v${version}.png`);
      const args = [
        probe,
        pdf,
        String(page),
        String(dpi),
        png,
        "--lcd",
        "--repeat",
        "3",
        ...(version === 2 ? ["--font-info-v2"] : []),
      ];
      const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
      if (proc.error || proc.exitCode !== 0)
        throw new Error(`${name} v${version}: ${proc.error ?? proc.stderr.toString()}`);
      rows.push({
        version,
        sha256: sha256(png),
        metrics: JSON.parse(proc.stdout.toString()),
      });
    }
    rows.sort((a, b) => a.version - b.version);
    const identical = rows[0]!.sha256 === rows[1]!.sha256;
    const changedFonts: string[] = [];
    if (name === "fonts" && !identical) {
      const a = loadPng(join(out, `fonts-${run}-v1.png`));
      const b = loadPng(join(out, `fonts-${run}-v2.png`));
      if (a.w !== b.w || a.h !== b.h || a.nComp !== b.nComp) throw new Error("Font image dimensions changed");
      for (const [i, face] of names.entries()) {
        const baseline = (pageHeight - firstBaseline + i * rowSpacing) * scale;
        const glyphAscender = 28,
          glyphDescender = 8;
        const start = Math.max(0, Math.floor(baseline - glyphAscender * scale)) * a.w * a.nComp;
        const end = Math.min(a.h, Math.ceil(baseline + glyphDescender * scale)) * a.w * a.nComp;
        if (a.data.subarray(start, end).some((v, n) => v !== b.data[start + n])) changedFonts.push(face);
      }
    }
    matches &&= identical;
    results.push({ run, name, pdf, pdfSha256: sha256(pdf), page, identical, changedFonts, rows });
    console.log(
      `${name}: identical=${identical}, page_load_ms=${rows.map((r) => r.metrics.page_load_ms).join(" -> ")}`,
    );
    if (changedFonts.length) console.log(`Changed font rows: ${changedFonts.join(", ")}`);
  }
}
writeFileSync(
  join(out, "results.json"),
  JSON.stringify(
    { probeSha256: sha256(probe), pdfiumSha256: sha256(resolve("out/pdfium-probe/pdfium.dll")), names, results },
    null,
    2,
  ) + "\n",
);
if (!matches) throw new Error("Font-info v2 changed rendered output; do not enable it by default");
