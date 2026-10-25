import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hash, policy } from "./normal-startup-ui.ts";
import { systemCpuTimes, systemMemory } from "../../tests/winapi.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    output: { type: "string", default: "out/solok-multi-alloc" },
    runs: { type: "string", default: "3" },
  },
});
if (!positionals.length) throw new Error("Pass PDF files");
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Invalid runs");
const out = resolve(values.output),
  probe = resolve("out/pdfium-probe/pdfium-multi-alloc.exe"),
  dll = resolve("out/pdfium-probe/pdfium.dll"),
  pdfs = positionals.map((path) => ({ path: resolve(path), sha256: hash(resolve(path)) }));
mkdirSync(out, { recursive: true });
const rows: any[] = [];
let status = "running";
const save = () =>
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      {
        status,
        probeSha256: hash(probe),
        dllSha256: hash(dll),
        pdfs,
        runs,
        note: "Standalone PDFium process, document and first page load followed by page close. No rendering, tile cache, UI, or app engine. Three quiet 1s host samples before each run. Private Bytes are process-wide net values, not allocation stacks.",
        rows,
      },
      null,
      2,
    ) + "\n",
  );
const total = (c: ReturnType<typeof systemCpuTimes>) => c.kernelMs + c.userMs;

async function gate() {
  let stable = 0,
    prev = systemCpuTimes();
  const samples: any[] = [];
  for (const start = performance.now(); performance.now() - start < policy.timeoutMs; ) {
    await Bun.sleep(1000);
    const cpu = systemCpuTimes(),
      memory = systemMemory(),
      dt = total(cpu) - total(prev),
      busyPercent = dt > 0 ? (100 * (dt - cpu.idleMs + prev.idleMs)) / dt : 100;
    samples.push({ busyPercent, memoryLoad: memory.loadPercent });
    prev = cpu;
    stable = busyPercent <= policy.startCpu && memory.loadPercent <= policy.startMemory ? stable + 1 : 0;
    if (stable >= policy.stableSamples) return samples;
  }
  throw new Error("Host did not reach start conditions");
}

try {
  for (let run = 0; run < runs; run++) {
    const order = run % 2 ? [...pdfs].reverse() : pdfs,
      gateSamples = await gate(),
      proc = Bun.spawn([probe, dll, ...order.map((pdf) => pdf.path)], { stdout: "pipe", stderr: "pipe" }),
      stdout = new Response(proc.stdout).text(),
      stderr = new Response(proc.stderr).text(),
      code = await proc.exited;
    if (code !== 0) throw new Error(`probe exited ${code}: ${await stderr}`);
    const metrics = JSON.parse(await stdout),
      memoryLoad = systemMemory().loadPercent,
      mib = 1048576;
    rows.push({
      run,
      order: order.map((pdf) => pdf.path),
      gateSamples,
      memoryLoad,
      metrics,
      openNetMiB: (metrics.before_close - metrics.after_init) / mib,
      closeNetMiB: (metrics.after_shutdown - metrics.after_init) / mib,
    });
    save();
    console.log(
      `${run}: open net ${rows.at(-1).openNetMiB.toFixed(2)} MiB, close net ${rows.at(-1).closeNetMiB.toFixed(2)} MiB`,
    );
  }
  status = "complete";
  save();
} catch (error) {
  status = "incomplete: " + String(error);
  save();
  throw error;
}
