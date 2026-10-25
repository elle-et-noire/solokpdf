import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const source = resolve(process.argv[2] ?? ".work/corpus/attention-1706.03762v7.pdf");
const tool = resolve("out/solokpdf-portable/sumatrapdf-tool.exe");
const out = resolve(".work/corpus/phase4");
const sourcePages = 15;
const repetitions = 20;
const rasterDpi = 144;
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sourceSha256 = sha256(source);
const expectedSourceSha256 = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
if (sourceSha256 !== expectedSourceSha256) {
  throw new Error("Expected Attention Is All You Need arXiv:1706.03762v7; see docs/solokpdf-progress.md");
}
mkdirSync(out, { recursive: true });
const commands: string[][] = [];
async function run(args: string[]): Promise<void> {
  commands.push([tool, ...args]);
  const proc = Bun.spawn([tool, ...args], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`Corpus command failed: ${args.join(" ")}`);
}

const vector = join(out, `attention-vector-${sourcePages * repetitions}.pdf`);
const raster = join(out, `attention-raster-${sourcePages}.pdf`);
const pages = `1-${sourcePages}`;
await run([
  "merge",
  "-o",
  vector,
  "-O",
  "reproducible",
  ...Array.from({ length: repetitions }, () => [source, pages]).flat(),
]);
await run(["draw", "-q", "-r", String(rasterDpi), "-c", "gray", "-F", "pclm", "-o", raster, source, pages]);
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      source,
      sourceSha256,
      tool,
      toolSha256: sha256(tool),
      commands,
      note: "Derived size/raster stress fixtures, not independent papers or real scans. Repeated content adds no independent font diversity; merge does not preserve the original outline. No PDFs are redistributed.",
      files: [vector, raster].map((file) => ({ file, bytes: statSync(file).size, sha256: sha256(file) })),
    },
    null,
    2,
  ) + "\n",
);
console.log(join(out, "manifest.json"));
