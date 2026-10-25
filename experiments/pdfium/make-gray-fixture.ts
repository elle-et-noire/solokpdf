import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemblePdf } from "../../tests/util.ts";

const out = resolve("out/solok-memory-fixtures");
mkdirSync(out, { recursive: true });
const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
const shades = Array.from({ length: 256 }, (_, i) => `${i / 255} g ${i} 0 1 341 re f`).join("\n");
const pdf = assemblePdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 261 341] /Contents 5 0 R >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 263 343] /Rotate 90 /Contents 6 0 R >>",
  stream(shades),
  stream(shades + "\n1 1 0.9960784314 rg 262 342 1 1 re f"),
]);
const path = join(out, "gray-near-gray.pdf");
writeFileSync(path, pdf, "latin1");
console.log(path);
