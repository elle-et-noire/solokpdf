import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemblePdf } from "../../tests/util.ts";

const out = resolve("out/solok-memory-fixtures");
mkdirSync(out, { recursive: true });
const width = 261,
  height = 341;
const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
const resources = "/Resources << /Font << /F1 5 0 R >> /ExtGState << /GS1 8 0 R >> >>";
const content = (w: number) =>
  [
    "BT /F1 13 Tf 12 310 Td (Odd stride RGB / alpha) Tj ET",
    "1 0 0 rg 0 0 1 290 re f",
    `0 1 0 rg ${w - 2} 0 1 290 re f`,
    `0 0 1 rg ${w - 1} 0 1 290 re f`,
    "q /GS1 gs 1 0 0 rg 20 140 120 100 re f Q",
    "q /GS1 gs 0 0 1 rg 70 190 120 100 re f Q",
    "0 0 0 RG 0.5 w 12 10 m 250 300 l S",
  ].join("\n");
const pdf = assemblePdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ${resources} /Contents 6 0 R >>`,
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width + 2} ${height + 2}] /Rotate 90 ${resources} /Contents 7 0 R >>`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  stream(content(width)),
  stream(content(width + 2)),
  "<< /Type /ExtGState /ca 0.35 /CA 0.35 /BM /Normal >>",
]);
const path = join(out, "odd-rgb-alpha.pdf");
writeFileSync(path, pdf, "latin1");
console.log(path);
