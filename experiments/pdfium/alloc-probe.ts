import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hash, policy } from "./normal-startup-ui.ts";
import { systemCpuTimes, systemMemory } from "../../tests/winapi.ts";

const mib = 1048576;
const total = (c: ReturnType<typeof systemCpuTimes>) => c.kernelMs + c.userMs;
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    output: { type: "string", default: "out/solok-alloc-probe" },
    runs: { type: "string", default: "3" },
    fontInfoV2: { type: "boolean" },
    fontProfile: { type: "boolean" },
  },
});
if (!positionals.length) throw new Error("Pass PDF files");
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Invalid runs");
const out = resolve(values.output),
  probe = resolve("out/pdfium-probe/pdfium-render.exe"),
  pdfs = positionals.map((path) => ({ path: resolve(path), sha256: hash(resolve(path)) }));
mkdirSync(out, { recursive: true });
const rows: any[] = [],
  gates: any[] = [];
let status = "running";
const save = () =>
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      {
        status,
        probe,
        probeSha256: hash(probe),
        pdfiumDllSha256: hash(resolve("out/pdfium-probe/pdfium.dll")),
        pdfs,
        runs,
        fontInfoV2: !!values.fontInfoV2,
        fontProfile: !!values.fontProfile,
        policy: { startCpu: policy.startCpu, startMemory: policy.startMemory, stableSamples: policy.stableSamples },
        note: "Standalone PDFium memory diagnostic, page 1 at 96 DPI and LCD flag. Font-info v2 is probe-only and changes alias pixels. Three quiet 1s host samples before each run; no continuous CPU gate during this short probe. Do not use page-load time as performance evidence. Per-phase Private Bytes are process-wide net values; PNGs are compared to the prior unmodified probe.",
        gates,
        rows,
      },
      null,
      2,
    ) + "\n",
  );

async function gate(id: string) {
  let stable = 0,
    prev = systemCpuTimes();
  const samples: any[] = [];
  for (const start = performance.now(); performance.now() - start < policy.timeoutMs; ) {
    await Bun.sleep(1000);
    const cpu = systemCpuTimes(),
      memory = systemMemory(),
      dt = total(cpu) - total(prev),
      busyPercent = dt > 0 ? (100 * (dt - cpu.idleMs + prev.idleMs)) / dt : 100;
    samples.push({ busyPercent, memory });
    prev = cpu;
    stable = busyPercent <= policy.startCpu && memory.loadPercent <= policy.startMemory ? stable + 1 : 0;
    if (stable >= policy.stableSamples) {
      gates.push({ id, accepted: true, samples });
      save();
      return;
    }
  }
  gates.push({ id, accepted: false, samples });
  save();
  throw new Error("Host did not reach start conditions");
}

try {
  for (let run = 0; run < runs; run++) {
    const ordered = run % 2 ? [...pdfs].reverse() : pdfs;
    for (const pdf of ordered) {
      const id = `${pdfs.indexOf(pdf)}-${run}`;
      await gate(id);
      const png = join(out, id + ".png"),
        proc = Bun.spawn(
          [
            probe,
            pdf.path,
            "1",
            "96",
            png,
            "--lcd",
            ...(values.fontInfoV2 ? ["--font-info-v2"] : []),
            ...(values.fontProfile ? ["--font-profile"] : []),
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
        stdout = new Response(proc.stdout).text(),
        stderr = new Response(proc.stderr).text(),
        code = await proc.exited;
      if (code !== 0) throw new Error(`${id}: probe exited ${code}: ${await stderr}`);
      const metrics = JSON.parse(await stdout),
        expectedName = basename(pdf.path).startsWith("attention-")
          ? "paper-1"
          : basename(pdf.path).startsWith("bert-")
            ? "bert"
            : basename(pdf.path) === "fonts.pdf"
              ? "fonts"
              : "ipa",
        expected =
          expectedName === "fonts"
            ? resolve("out/solok-phase4-font-check/fonts-0-v1.png")
            : resolve(`out/solok-font-attribution/${expectedName}-0-false.png`),
        pixelMatch = hash(png) === hash(expected),
        memoryLoad = systemMemory().loadPercent,
        reasons = memoryLoad > policy.memory ? ["memory pressure"] : [];
      if (!pixelMatch && !values.fontInfoV2) throw new Error(`${id}: PNG changed`);
      rows.push({
        id,
        run,
        pdf: pdf.path,
        png,
        pngSha256: hash(png),
        pixelMatch,
        memoryLoad,
        reasons,
        metrics,
        pagePrivateMiB: (metrics.after_page.private_bytes - metrics.before_page.private_bytes) / mib,
        documentCloseMiB: (metrics.after_document_close.private_bytes - metrics.after_page_close.private_bytes) / mib,
      });
      save();
      console.log(
        `${id}: page +${rows.at(-1).pagePrivateMiB.toFixed(2)} MiB, document close ${rows.at(-1).documentCloseMiB.toFixed(2)} MiB, PNG ${pixelMatch ? "matches" : "differs"}`,
      );
    }
  }
  status = "complete";
  save();
} catch (error) {
  status = "incomplete: " + String(error);
  save();
  throw error;
}
