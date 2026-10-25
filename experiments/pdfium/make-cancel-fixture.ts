import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemblePdf } from "../../tests/util.ts";

const out = resolve("out/solok-memory-fixtures");
mkdirSync(out, { recursive: true });
const width = 14000,
  height = 420;
const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
const pdf = assemblePdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 5 0 R >>`,
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width + 1} ${height + 1}] /Contents 6 0 R >>`,
  stream("0 g 1 1 1 1 re f"),
  stream(`0 g 1 1 1 1 re f\n1 1 0.9960784314 rg ${width} 0 1 1 re f`),
]);
const file = join(out, "wide-gray-light.pdf");
writeFileSync(file, pdf, "latin1");
console.log(file);
