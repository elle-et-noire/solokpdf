import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemblePdf } from "../../tests/util.ts";

const out = resolve("out/solok-memory-fixtures");
mkdirSync(out, { recursive: true });
const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
const width = 14000,
  height = 420;
const shades = Array.from({ length: 256 }, (_, i) => `${i / 255} g ${i * 50} 0 50 ${height} re f`).join("\n");
const text = "BT /F1 20 Tf 30 200 Td (Wide tile: gray levels, text and lines) Tj ET";
const lines = Array.from({ length: 2000 }, (_, i) => `${i * 7} 0 m ${i * 7 + 100} ${height} l S`).join("\n");
const content = `${shades}\n0 G 0.1 w ${lines}\n0 g ${text}`;
const pdf = assemblePdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`,
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width + 1} ${height + 1}] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  stream(content),
  stream(content + `\n1 1 0.9960784314 rg ${width - 1} 0 1 1 re f`),
]);
const file = join(out, "wide-gray-color.pdf");
writeFileSync(file, pdf, "latin1");
console.log(file);
