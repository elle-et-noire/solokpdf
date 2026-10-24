import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const input = resolve(process.argv[2] ?? ".work/corpus/attention-1706.03762v7.pdf");
if (!existsSync(input)) throw new Error("Pass the path to a local PDF");
const output = resolve("out/pdfium-comparison");
mkdirSync(output, { recursive: true });
const probe = resolve("out/pdfium-probe/pdfium-render.exe");
const mupdf = resolve("out/baseline/bin/sumatrapdf-tool.exe");
const results: unknown[] = [];
for (const dpi of [96, 144]) {
  for (const page of [3, 4]) {
    for (const lcd of [false, true]) {
      const name = `pdfium-p${page}-${dpi}${lcd ? "-lcd" : ""}`;
      const p = Bun.spawnSync(
        [
          probe,
          input,
          String(page),
          String(dpi),
          join(output, name + ".png"),
          "--repeat",
          "5",
          ...(lcd ? ["--lcd"] : []),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      writeFileSync(join(output, name + ".stderr.txt"), p.stderr);
      if (p.error || p.exitCode !== 0) throw new Error(`${name}: ${p.error ?? p.stderr.toString()}`);
      const metrics = JSON.parse(p.stdout.toString());
      writeFileSync(join(output, name + ".json"), JSON.stringify(metrics, null, 2));
      results.push({ name, ...metrics });
    }
    const name = `mupdf-p${page}-${dpi}`;
    const args = [
      mupdf,
      "draw",
      "-A",
      "8",
      "-r",
      String(dpi),
      "-s",
      "tm",
      "-o",
      join(output, name + ".png"),
      input,
      String(page),
    ];
    const start = performance.now();
    const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    const processMs = performance.now() - start;
    writeFileSync(join(output, name + ".txt"), p.stdout.toString() + p.stderr.toString());
    if (p.error || p.exitCode !== 0) throw new Error(`${name}: ${p.error ?? p.stderr.toString()}`);
    results.push({
      name,
      command: args,
      process_ms: processMs,
      note: "MuPDF CLI timings include its own I/O/encoding; not equivalent to probe render_ms",
    });
  }
}
writeFileSync(
  join(output, "results.json"),
  JSON.stringify({ input, sha256: createHash("sha256").update(readFileSync(input)).digest("hex"), results }, null, 2),
);
console.log(`Wrote images and raw metrics to ${output}`);
