import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId } from "../../tests/util.ts";
import { findCanvas, sendCommand, sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import {
  processGuiResources,
  processMemory,
  sendMessage,
  setProcessDpiAware,
  systemCpuTimes,
  systemMemory,
} from "../../tests/winapi.ts";

const sampleMs = 200;
const policy = {
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
const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function monitor(pid: number) {
  let samples: any[] = [],
    recording = false;
  const take = () => ({
    ms: performance.now(),
    cpu: systemCpuTimes(),
    resources: processGuiResources(pid),
    memory: processMemory(pid),
    system: systemMemory(),
  });
  const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  const timer = setInterval(() => {
    if (recording) samples.push(take());
  }, sampleMs);
  emit({ event: "ready" });
  let text = "";
  try {
    for await (const chunk of Bun.stdin.stream()) {
      text += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = text.indexOf("\n")) >= 0) {
        const command = text.slice(0, end);
        text = text.slice(end + 1);
        if (command === "start") {
          samples = [take()];
          recording = true;
          emit({ event: "started" });
        }
        if (command === "stop") {
          samples.push(take());
          recording = false;
          emit({ event: "stopped", samples });
          return;
        }
      }
    }
  } finally {
    clearInterval(timer);
  }
}

function background(samples: any[]) {
  const a = samples[0],
    z = samples.at(-1),
    duration = total(z.cpu) - total(a.cpu);
  const busy = duration - z.cpu.idleMs + a.cpu.idleMs;
  const other = busy - target(z.resources) + target(a.resources);
  const windows: any[] = [];
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1],
      q = samples[i],
      dt = total(q.cpu) - total(p.cpu);
    if (q.ms - p.ms < sampleMs / 2) continue;
    const used = dt - q.cpu.idleMs + p.cpu.idleMs;
    const app = target(q.resources) - target(p.resources);
    if (dt <= 0 || used < 0 || app < 0) throw new Error("Invalid CPU counters");
    windows.push({
      ms: q.ms - p.ms,
      totalCpuMs: dt,
      busyCpuMs: used,
      appCpuMs: app,
      otherPercent: (100 * Math.max(0, used - app)) / dt,
    });
  }
  if (duration <= 0 || windows.length < 8) throw new Error("Insufficient CPU windows");
  const sorted = windows.map((w) => w.otherPercent).sort((x, y) => x - y);
  return {
    meanPercent: (100 * Math.max(0, other)) / duration,
    p95Percent: sorted[Math.ceil(sorted.length * 0.95) - 1],
    windows,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      before: { type: "string" },
      after: { type: "string" },
      output: { type: "string", default: "out/solok-load-controlled" },
      runs: { type: "string", default: "4" },
    },
  });
  if (!values.before || !values.after) throw new Error("Pass --before and --after");
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("Invalid runs");
  const out = resolve(values.output),
    pdf = resolve("out/solok-memory-fixtures/wide-gray-light.pdf");
  mkdirSync(out, { recursive: true });
  setProcessDpiAware();
  const variants = [
    { name: "before", exe: resolve(values.before) },
    { name: "after", exe: resolve(values.after) },
  ].map((v) => ({
    ...v,
    sha256: hash(v.exe),
    dependencies: ["pdfium.dll", "libsumatrapdf.dll"].map((name) => ({
      name,
      sha256: hash(join(dirname(v.exe), name)),
    })),
  }));
  if (JSON.stringify(variants[0]!.dependencies) !== JSON.stringify(variants[1]!.dependencies))
    throw new Error("DLL mismatch");
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
          variants,
          pdf,
          inputSha256: hash(pdf),
          runs,
          status,
          conditions:
            "Light wide page 2, one tab; 24 cycles of 100/1600/25 zoom at 35ms. Independent Bun process samples CPU/memory while UI calls block the driver. Target is idle before measurement. Background CPU subtracts target CPU and includes harness/OS. Warm file cache, matching DLLs, hidden app PDBs, fresh settings. No builds or other GUI checks during measurement.",
          gates,
          rows,
          pairs,
        },
        null,
        2,
      ) + "\n",
    );
  async function gate(id: string) {
    const samples: any[] = [];
    let prev = systemCpuTimes(),
      stable = 0;
    for (const start = performance.now(); performance.now() - start < policy.timeoutMs; ) {
      await Bun.sleep(1000);
      const cpu = systemCpuTimes(),
        memory = systemMemory(),
        dt = total(cpu) - total(prev);
      const busyPercent = dt > 0 ? (100 * (dt - cpu.idleMs + prev.idleMs)) / dt : 100;
      samples.push({ busyPercent, memory });
      prev = cpu;
      stable = busyPercent <= policy.startCpu && memory.loadPercent <= policy.startMemory ? stable + 1 : 0;
      if (stable >= policy.stableSamples) {
        gates.push({ id, accepted: true, samples });
        save();
        return;
      }
      if (samples.length % 10 === 0)
        console.log(`${id}: waiting; CPU ${busyPercent.toFixed(1)}%, memory ${memory.loadPercent}%`);
    }
    gates.push({ id, accepted: false, samples });
    save();
    throw new Error("Host did not reach start conditions");
  }
  async function measure(v: (typeof variants)[number], run: number, attempt: number) {
    const id = `${run}-${attempt}-${v.name}`;
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
      v.exe,
      async (client, proc) => {
        await client.setNotificationsEnabled(false);
        await client.waitForRenderIdle(30000);
        const frame = await waitForFrame(proc.pid!);
        if (!frame) throw new Error("No frame");
        const zoom = async (command: string) => {
          sendCommandSync(frame, cmdId(command));
          await client.waitForRenderIdle(30000);
        };
        await zoom("CmdZoom25");
        await zoom("CmdZoom100");
        await client.request(ControlCommand.TestFavoriteNav, ["goto", 2]);
        await client.waitForRenderIdle(30000);
        for (const command of ["CmdZoom50", "CmdZoom200", "CmdZoom400", "CmdZoom1600", "CmdZoom6400", "CmdZoom100"])
          await zoom(command);
        for (let i = 0; i < 30; i++) sendMessage(findCanvas(frame), 0x0115, 1, 0);
        await client.waitForRenderIdle(30000);
        for (let i = 0; i < 2; i++) {
          sendCommandSync(frame, cmdId("CmdToggleTransparencyGrid"));
          await client.waitForRenderIdle(30000);
        }
        let quiet = 0,
          prev = processGuiResources(proc.pid!);
        for (let i = 0; i < 20 && quiet < 3; i++) {
          await Bun.sleep(500);
          const next = processGuiResources(proc.pid!);
          quiet = target(next) - target(prev) <= 15.625 ? quiet + 1 : 0;
          prev = next;
        }
        if (quiet < 3) throw new Error("Target did not become idle");
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
              const s = pending.slice(0, end);
              pending = pending.slice(end + 1);
              return JSON.parse(s);
            }
            const r = await reader.read();
            if (r.done) throw new Error("Monitor exited: " + (await errors));
            pending += new TextDecoder().decode(r.value);
          }
        }
        async function command(s: string) {
          child.stdin.write(s + "\n");
          await child.stdin.flush();
          return receive();
        }
        try {
          if ((await receive()).event !== "ready") throw new Error("Monitor not ready");
          await command("start");
          const start = performance.now();
          for (let i = 0; i < 24; i++)
            for (const name of ["CmdZoom100", "CmdZoom1600", "CmdZoom25"]) {
              sendCommand(frame, cmdId(name));
              await Bun.sleep(35);
            }
          await client.request(ControlCommand.Ping);
          await client.waitForRenderIdle(30000);
          const elapsedMs = performance.now() - start,
            measured = await command("stop");
          const samples = measured.samples,
            first = samples[0],
            last = samples.at(-1),
            bg = background(samples);
          const reasons: string[] = [];
          if (bg.meanPercent > policy.backgroundMean) reasons.push("background CPU mean");
          if (bg.p95Percent > policy.backgroundP95) reasons.push("background CPU p95");
          if (Math.max(...samples.map((s: any) => s.system.loadPercent)) > policy.memory)
            reasons.push("memory pressure");
          row = {
            id,
            variant: v.name,
            run,
            attempt,
            elapsedMs,
            cpuMs: target(last.resources) - target(first.resources),
            background: bg,
            reasons,
            first,
            last,
            samples,
          };
        } finally {
          child.stdin.end();
          const code = await Promise.race([child.exited, Bun.sleep(2000).then(() => "timeout")]);
          if (code === "timeout") child.kill();
        }
      },
      ["-appdata", settings, "-window-pos", "900x1000@0x0", "-log-to-file", log, pdf],
      { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "0" }, connectTimeoutMs: 30000 },
    );
    const text = readFileSync(log, "utf8");
    if (!text.includes("PDFium 158.0.8111.0: opened") || text.includes("Using MuPDF fallback"))
      throw new Error("Wrong backend");
    rows.push(row);
    save();
    console.log(
      `${id}: target ${row.cpuMs.toFixed(1)}ms; wall ${row.elapsedMs.toFixed(1)}ms; other CPU mean/p95 ${row.background.meanPercent.toFixed(1)}/${row.background.p95Percent.toFixed(1)}%; ${row.reasons.join(",") || "eligible"}`,
    );
    return row;
  }
  const hidden: [string, string][] = [];
  try {
    for (const p of new Set([
      resolve("out/rel64/SumatraPDF.pdb"),
      ...variants.map((v) => v.exe.replace(/\.exe$/i, ".pdb")),
    ])) {
      const dst = p + ".load-hidden";
      if (!p.startsWith(resolve("out") + "\\") || existsSync(dst)) throw new Error("PDB guard");
      if (existsSync(p)) {
        renameSync(p, dst);
        hidden.push([p, dst]);
      }
    }
    for (let run = 0; run < runs; run++) {
      let accepted = false;
      for (let attempt = 0; attempt < policy.attempts && !accepted; attempt++) {
        const ordered = (run + attempt) % 2 ? [...variants].reverse() : variants,
          measured = [];
        for (const v of ordered) measured.push(await measure(v, run, attempt));
        const a = measured.find((r) => r.variant === "before"),
          b = measured.find((r) => r.variant === "after"),
          reasons = [...a.reasons, ...b.reasons];
        if (Math.abs(a.first.system.loadPercent - b.first.system.loadPercent) > policy.pairMemoryDifference)
          reasons.push("pair memory differs");
        accepted = !reasons.length;
        pairs.push({ run, attempt, before: a.id, after: b.id, accepted, reasons });
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
  } catch (e) {
    status = "incomplete: " + String(e);
    save();
    throw e;
  } finally {
    for (const [p, dst] of hidden) renameSync(dst, p);
  }
}

if (process.argv[2] === "--monitor") await monitor(Number(process.argv[3]));
else await main();
