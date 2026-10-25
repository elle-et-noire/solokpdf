import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId } from "../../tests/util.ts";
import { sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import {
  processGuiResources,
  processMemory,
  sendCopyDataW,
  setProcessDpiAware,
  systemCpuTimes,
  systemMemory,
} from "../../tests/winapi.ts";

export const sampleMs = 200;
const mib = 1048576;
const ddeOpen = 0x44646557;
export const policy = {
  startCpu: 10,
  startMemory: 85,
  stableSamples: 3,
  timeoutMs: 60000,
  backgroundMean: 10,
  backgroundP95: 20,
  memory: 90,
  pairMemoryDifference: 3,
  attempts: 3,
};
const total = (c: ReturnType<typeof systemCpuTimes>) => c.kernelMs + c.userMs;
const target = (c: ReturnType<typeof processGuiResources>) => c.kernelCpuMs + c.userCpuMs;
export const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function monitor(pid: number) {
  let samples: any[] = [];
  let recording = false;
  let targetPid = pid;
  const take = () => ({
    ms: performance.now(),
    epochMs: Date.now(),
    cpu: systemCpuTimes(),
    resources: processGuiResources(targetPid),
    memory: processMemory(targetPid),
    system: systemMemory(),
  });
  const timer = setInterval(() => {
    if (recording) samples.push(take());
  }, sampleMs);
  process.stdout.write('{"event":"ready"}\n');
  let pending = "";
  try {
    for await (const chunk of Bun.stdin.stream()) {
      pending += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const command = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (command === "start" || command.startsWith("start ")) {
          if (command.startsWith("start ")) targetPid = Number(command.slice(6));
          samples = [take()];
          recording = true;
          process.stdout.write('{"event":"started"}\n');
        }
        if (command === "stop") {
          samples.push(take());
          recording = false;
          process.stdout.write(JSON.stringify({ event: "stopped", samples }) + "\n");
          return;
        }
      }
    }
  } finally {
    clearInterval(timer);
  }
}

export function background(samples: any[]) {
  const first = samples[0],
    last = samples.at(-1),
    duration = total(last.cpu) - total(first.cpu),
    busy = duration - last.cpu.idleMs + first.cpu.idleMs,
    other = busy - target(last.resources) + target(first.resources);
  const windows: any[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1],
      next = samples[i],
      dt = total(next.cpu) - total(prev.cpu),
      used = dt - next.cpu.idleMs + prev.cpu.idleMs,
      app = target(next.resources) - target(prev.resources);
    if (next.ms - prev.ms < sampleMs / 2) continue;
    if (dt <= 0 || used < 0 || app < 0) throw new Error("Invalid CPU counters");
    windows.push({
      ms: next.ms - prev.ms,
      otherPercent: (100 * Math.max(0, used - app)) / dt,
    });
  }
  if (duration <= 0 || windows.length < 8) throw new Error("Insufficient CPU windows");
  const sorted = windows.map((w) => w.otherPercent).sort((a, b) => a - b);
  return {
    meanPercent: (100 * Math.max(0, other)) / duration,
    p95Percent: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxGapMs: Math.max(...windows.map((w) => w.ms)),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      exe: { type: "string", default: "out/solokpdf-portable/SolokPDF.exe" },
      output: { type: "string", default: "out/solok-normal-startup" },
      runs: { type: "string", default: "3" },
    },
  });
  if (!positionals.length) throw new Error("Pass ordinary PDFs to compare");
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("Invalid runs");
  const out = resolve(values.output),
    exe = resolve(values.exe),
    pdfs = positionals.map((path) => ({ path: resolve(path), sha256: hash(resolve(path)) }));
  mkdirSync(out, { recursive: true });
  setProcessDpiAware();
  const exeSha256 = hash(exe),
    dependencies = ["pdfium.dll", "libsumatrapdf.dll"].map((name) => ({
      name,
      sha256: hash(join(dirname(exe), name)),
    }));
  const variants = ["pdfium", "mupdf"];
  const rows: any[] = [],
    pairs: any[] = [],
    gates: any[] = [];
  let status = "running";
  const save = () =>
    writeFileSync(
      join(out, "results.json"),
      JSON.stringify(
        {
          policy,
          sampleMs,
          exe,
          exeSha256,
          dependencies,
          pdfs,
          runs,
          status,
          conditions:
            "Same Release executable and DLLs; fresh isolated settings; one PDF opened from an empty window; 900x1000, 100% zoom; warm OS file cache; application PDBs hidden. Open time ends at render idle, then 1000ms settle and close. Independent Bun process monitors host and target CPU/memory at 200ms. Background includes harness and OS. These are warm document-open timings, not process startup or first paint.",
          gates,
          rows,
          pairs,
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

  async function measure(pdf: (typeof pdfs)[number], run: number, attempt: number, engine: string) {
    const id = `${pdfs.indexOf(pdf)}-${run}-${attempt}-${engine}`;
    await gate(id);
    const settings = join(out, id);
    mkdirSync(settings, { recursive: true });
    writeFileSync(
      join(settings, "SolokPDF-settings.txt"),
      "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n",
    );
    const log = join(out, id + ".log");
    let row: any;
    await withControlledSumatra(
      exe,
      async (client, proc) => {
        await client.setNotificationsEnabled(false);
        const frame = await waitForFrame(proc.pid!);
        if (!frame) throw new Error("No frame");
        await Bun.sleep(500);
        const empty = { memory: processMemory(proc.pid!), resources: processGuiResources(proc.pid!) };
        const child = Bun.spawn([process.execPath, import.meta.path, "--monitor", String(proc.pid)], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const errors = new Response(child.stderr).text(),
          reader = child.stdout.getReader();
        let pending = "";
        async function receive() {
          while (true) {
            const end = pending.indexOf("\n");
            if (end >= 0) {
              const line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              return JSON.parse(line);
            }
            const next = await reader.read();
            if (next.done) throw new Error("Monitor exited: " + (await errors));
            pending += new TextDecoder().decode(next.value);
          }
        }
        async function command(value: string) {
          child.stdin.write(value + "\n");
          await child.stdin.flush();
          return receive();
        }
        try {
          if ((await receive()).event !== "ready") throw new Error("Monitor not ready");
          await command("start");
          const start = performance.now();
          if (!sendCopyDataW(frame, ddeOpen, `[Open("${pdf.path}",0,1,0)]`)) throw new Error("Open failed");
          await client.waitForRenderIdle(30000);
          const openMs = performance.now() - start;
          await Bun.sleep(1000);
          const opened = { memory: processMemory(proc.pid!), resources: processGuiResources(proc.pid!) };
          sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
          if ((await client.request(ControlCommand.TestCurrentTab))[0] === 0) throw new Error("Document still open");
          await Bun.sleep(1000);
          const closed = { memory: processMemory(proc.pid!), resources: processGuiResources(proc.pid!) };
          const samples = (await command("stop")).samples,
            bg = background(samples),
            reasons: string[] = [];
          if (bg.meanPercent > policy.backgroundMean) reasons.push("background CPU mean");
          if (bg.p95Percent > policy.backgroundP95) reasons.push("background CPU p95");
          if (Math.max(...samples.map((s: any) => s.system.loadPercent)) > policy.memory)
            reasons.push("memory pressure");
          row = {
            id,
            pdf: pdf.path,
            run,
            attempt,
            engine,
            openMs,
            empty,
            opened,
            closed,
            openPrivateDeltaMiB: (opened.memory.privateBytes - empty.memory.privateBytes) / mib,
            closePrivateDeltaMiB: (closed.memory.privateBytes - empty.memory.privateBytes) / mib,
            background: bg,
            reasons,
            samples,
          };
        } finally {
          child.stdin.end();
          const code = await Promise.race([child.exited, Bun.sleep(2000).then(() => "timeout")]);
          if (code === "timeout") child.kill();
        }
      },
      ["-appdata", settings, "-window-pos", "900x1000@0x0", "-log-to-file", log],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_PROFILE: "0" }, connectTimeoutMs: 30000 },
    );
    const appLog = readFileSync(log, "utf8");
    if (
      engine === "pdfium" &&
      (!appLog.includes("PDFium 158.0.8111.0: opened") || appLog.includes("Using MuPDF fallback"))
    )
      throw new Error("PDFium was not used");
    rows.push(row);
    save();
    console.log(
      `${id}: ${row.openMs.toFixed(1)}ms, private +${row.openPrivateDeltaMiB.toFixed(1)} MiB, other CPU ${row.background.meanPercent.toFixed(1)}/${row.background.p95Percent.toFixed(1)}%, ${row.reasons.join(",") || "eligible"}`,
    );
    return row;
  }

  const hidden: [string, string][] = [];
  try {
    for (const path of new Set([resolve("out/rel64/SumatraPDF.pdb"), exe.replace(/\.exe$/i, ".pdb")])) {
      const dest = path + ".normal-startup-hidden";
      if (!path.startsWith(resolve("out") + "\\") || existsSync(dest)) throw new Error("PDB guard");
      if (existsSync(path)) {
        renameSync(path, dest);
        hidden.push([path, dest]);
      }
    }
    for (const pdf of pdfs)
      for (let run = 0; run < runs; run++) {
        let accepted = false;
        for (let attempt = 0; attempt < policy.attempts && !accepted; attempt++) {
          const ordered = (run + attempt) % 2 ? [...variants].reverse() : variants,
            measured = [];
          for (const engine of ordered) measured.push(await measure(pdf, run, attempt, engine));
          const reasons = measured.flatMap((row) => row.reasons);
          if (
            Math.abs(measured[0].samples[0].system.loadPercent - measured[1].samples[0].system.loadPercent) >
            policy.pairMemoryDifference
          )
            reasons.push("pair memory differs");
          accepted = !reasons.length;
          pairs.push({ pdf: pdf.path, run, attempt, ids: measured.map((row) => row.id), accepted, reasons });
          save();
        }
        if (!accepted) {
          status = "insufficient qualifying pairs";
          save();
          return;
        }
      }
    status = "complete";
    save();
  } catch (error) {
    status = "incomplete: " + String(error);
    save();
    throw error;
  } finally {
    for (const [path, dest] of hidden) renameSync(dest, path);
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--monitor") await monitor(Number(process.argv[3]));
  else await main();
}
