import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId, loadPng } from "../../tests/util.ts";
import { findCanvas, sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import {
  captureWindowToPng,
  packCoords,
  postMessage,
  processGuiResources,
  processMemory,
  sendMessage,
  setProcessDpiAware,
  systemCpuTimes,
  systemMemory,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
  WM_KEYDOWN,
  WM_COMMAND,
  VK_HOME,
} from "../../tests/winapi.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    before: { type: "string", default: "out/solok-finish-after-release/SolokPDF.exe" },
    after: { type: "string", default: "out/solok-ownership-after-release/SolokPDF.exe" },
    output: { type: "string", default: "out/solok-tabgroup" },
    runs: { type: "string", default: "4" },
    counts: { type: "string", default: "4,8,16" },
    profile: { type: "boolean" },
  },
});
if (positionals.length !== 4) throw new Error("Pass four corpus PDFs");
if (cpus().length > 64) throw new Error("System CPU accounting requires one processor group");
if (systemCpuTimes().idleMs === 0) throw new Error("System idle counter is unavailable");
const runs = Number(values.runs),
  counts = values.counts.split(",").map(Number);
if (!Number.isInteger(runs) || runs < 1 || counts.some((n) => ![4, 8, 16].includes(n)))
  throw new Error("Invalid runs/counts");
const out = resolve(values.output);
if (existsSync(join(out, "results.json"))) throw new Error("Use a fresh output directory");
mkdirSync(out, { recursive: true });
setProcessDpiAware();
const sampleMs = 20,
  settleMs = 500,
  requestTimeoutMs = 60000;
const gateSampleMs = 1000,
  gateStableSamples = 3,
  gateTimeoutMs = 180000;
const maxStartCpuPercent = 10,
  maxBackgroundMean = 10,
  maxBackgroundP95 = 20;
const maxMemoryLoad = 90,
  maxStartMemoryLoad = 85,
  maxPairStartMemoryDifference = 3;
const maxPairAttempts = 3;
const backgroundWindowMs = 200;
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const variants = [
  { name: "before", exe: resolve(values.before) },
  { name: "after", exe: resolve(values.after) },
].map((v) => ({
  ...v,
  sha256: hash(v.exe),
  dependencies: ["pdfium.dll", "libsumatrapdf.dll"].map((name) => ({ name, sha256: hash(join(dirname(v.exe), name)) })),
}));
if (JSON.stringify(variants[0]!.dependencies) !== JSON.stringify(variants[1]!.dependencies))
  throw new Error("DLL mismatch");
const inputs = positionals.map((path) => ({ path: resolve(path), sha256: hash(path) }));
const copies = Array.from({ length: Math.max(...counts) }, (_, i) => {
  const input = inputs[i % inputs.length]!,
    path = join(out, `document-${String(i).padStart(2, "0")}-${basename(input.path)}`);
  copyFileSync(input.path, path);
  return { path, source: i % inputs.length, sha256: input.sha256 };
});
type HostCpu = ReturnType<typeof systemCpuTimes>;
type Sample = {
  ms: number;
  phase: string;
  memory: ReturnType<typeof processMemory>;
  resources: ReturnType<typeof processGuiResources>;
  system: ReturnType<typeof systemMemory>;
  cpu: HostCpu;
};
const results: any[] = [],
  pairs: any[] = [],
  comparisons: any[] = [];
function save() {
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      {
        variants,
        inputs,
        copies,
        runs,
        counts,
        profile: Boolean(values.profile),
        logicalProcessors: cpus().length,
        policy: {
          sampleMs,
          settleMs,
          gateSampleMs,
          gateStableSamples,
          gateTimeoutMs,
          maxStartCpuPercent,
          maxBackgroundMean,
          maxBackgroundP95,
          maxMemoryLoad,
          maxStartMemoryLoad,
          maxPairStartMemoryDifference,
          maxPairAttempts,
          backgroundWindowMs,
        },
        conditions:
          "Fresh process/settings; warm file cache; matched DLLs; raw/staged app PDBs hidden; 900x1000 requested; default zoom 100; PDFium unchanged; generated persisted TabGroups loaded through Restore UI; four distinct sources repeated under independent paths. Active-ready means final selected tab fully rendered and control responsive after all group entries opened. Background CPU includes harness; total CPU minus target process, normalized across logical processors. Captures occur after timing. No frequency/paging/disk isolation.",
        systemCpuReference:
          "https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getsystemtimes",
        results,
        pairs,
        comparisons,
      },
      null,
      2,
    ) + "\n",
  );
}
const totalCpu = (c: HostCpu) => c.kernelMs + c.userMs;
const processCpu = (r: Sample["resources"]) => r.kernelCpuMs + r.userCpuMs;
const percentile = (a: number[], p: number) =>
  [...a].sort((a, b) => a - b)[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)]!;
async function gate() {
  const samples: any[] = [],
    start = performance.now();
  let prev = systemCpuTimes(),
    stable = 0;
  while (performance.now() - start < gateTimeoutMs) {
    await Bun.sleep(gateSampleMs);
    const cpu = systemCpuTimes(),
      memory = systemMemory(),
      total = totalCpu(cpu) - totalCpu(prev);
    const busyPercent = total > 0 ? (100 * (total - cpu.idleMs + prev.idleMs)) / total : 100;
    samples.push({ ms: performance.now() - start, busyPercent, memory });
    stable = busyPercent <= maxStartCpuPercent && memory.loadPercent <= maxStartMemoryLoad ? stable + 1 : 0;
    if (stable >= gateStableSamples) return samples;
    prev = cpu;
    if (samples.length % 10 === 0)
      console.log(`Waiting for background load: CPU ${busyPercent.toFixed(1)}%, memory ${memory.loadPercent}%`);
  }
  throw new Error("Host did not reach the predefined start conditions");
}
function background(samples: Sample[]) {
  const first = samples[0]!,
    last = samples.at(-1)!;
  const totalMs = totalCpu(last.cpu) - totalCpu(first.cpu);
  const busyMs = totalMs - (last.cpu.idleMs - first.cpu.idleMs);
  const otherMs = Math.max(0, busyMs - (processCpu(last.resources) - processCpu(first.resources)));
  let anchor = first;
  const percents: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i]!;
    const elapsed = b.ms - anchor.ms;
    if (elapsed < backgroundWindowMs && (i !== samples.length - 1 || elapsed < backgroundWindowMs / 2)) continue;
    const total = totalCpu(b.cpu) - totalCpu(anchor.cpu);
    if (total <= 0) continue;
    const busy = total - (b.cpu.idleMs - anchor.cpu.idleMs);
    const other = Math.max(0, busy - (processCpu(b.resources) - processCpu(anchor.resources)));
    percents.push((100 * other) / total);
    anchor = b;
  }
  return {
    meanPercent: (100 * otherMs) / totalMs,
    p95Percent: percentile(percents, 0.95),
    maxPercent: Math.max(...percents),
    intervals: percents.length,
  };
}
async function measure(variant: (typeof variants)[number], count: number, run: number, attempt: number) {
  const preflight = await gate(),
    id = `${count}tabs-run-${run}-attempt-${attempt}-${variant.name}`;
  const settings = join(out, id);
  mkdirSync(settings, { recursive: true });
  const files = copies.slice(0, count);
  const group = `TabGroups [\n [\n  Name = measured group\n  TabFiles [\n${files.map((f) => `   [\n    Path = ${f.path}\n   ]\n`).join("")}  ]\n ]\n]\n`;
  writeFileSync(
    join(settings, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n" +
      group,
  );
  const log = join(out, id + ".log");
  let result: any;
  await withControlledSumatra(
    variant.exe,
    async (client, proc) => {
      await client.setNotificationsEnabled(false);
      const frame = await waitForFrame(proc.pid!);
      if (!frame) throw new Error("No frame");
      const canvas = findCanvas(frame);
      if (!canvas) throw new Error("No canvas");
      sendCommandSync(frame, cmdId("CmdTabGroupRestore"));
      const tree = await client.virtTree(),
        list = tree.find((r) => r.kind === "virtCtrlListBox"),
        button = tree.find((r) => r.kind === "virtCtrlButton" && r.text === "Restore");
      if (!list || !button) throw new Error("No Restore dialog controls");
      sendMessage(list.hwnd, WM_KEYDOWN, VK_HOME, 0);
      await client.request(ControlCommand.Ping);
      const start = performance.now(),
        samples: Sample[] = [];
      let phase = "restore";
      const take = () => {
        const s = {
          ms: performance.now() - start,
          phase,
          memory: processMemory(proc.pid!),
          resources: processGuiResources(proc.pid!),
          system: systemMemory(),
          cpu: systemCpuTimes(),
        };
        samples.push(s);
        return s;
      };
      const initial = take(),
        timer = setInterval(take, sampleMs);
      const point = packCoords(
        button.rect.x + Math.floor(button.rect.dx / 2),
        button.rect.y + Math.floor(button.rect.dy / 2),
      );
      try {
        postMessage(button.hwnd, WM_MOUSEMOVE, 0, point);
        postMessage(button.hwnd, WM_LBUTTONDOWN, 1, point);
        postMessage(button.hwnd, WM_LBUTTONUP, 0, point);
        let finalSelected = false;
        for (const deadline = Date.now() + requestTimeoutMs; Date.now() < deadline; ) {
          const current = await client.request(ControlCommand.TestCurrentTab);
          if (current[0] === 0 && String(current[1]).includes(files.at(-1)!.path)) {
            finalSelected = true;
            break;
          }
          await Bun.sleep(20);
        }
        if (!finalSelected) throw new Error("Restoration did not reach the last document");
        const readyInfo = await client.waitForRenderIdle(requestTimeoutMs),
          activeReadyMs = performance.now() - start;
        const ready = take();
        await Bun.sleep(settleMs);
        const restored = take();
        const dpi = await client.request(ControlCommand.TestDpi, ["state"]);
        phase = "visit";
        const switchMs: number[] = [],
          seen = new Set<string>();
        const next = async () => {
          for (let tries = 0; tries < 3; tries++) {
            postMessage(frame, WM_COMMAND, cmdId("CmdNextTab"), 0);
            const current = await client.request(ControlCommand.TestCurrentTab);
            if (current[0] !== 0) continue;
            const match = /^path=(.*) page=\d+$/.exec(String(current[1]));
            if (!match) throw new Error("Invalid current tab");
            await client.waitForRenderIdle(requestTimeoutMs);
            return match[1]!;
          }
          throw new Error("No document tab");
        };
        for (let i = 0; i < count; i++) {
          const switching = performance.now(),
            path = await next();
          switchMs.push(performance.now() - switching);
          seen.add(path);
        }
        if (seen.size !== count || files.some((f) => !seen.has(f.path)))
          throw new Error(`Wrong restored group: ${seen.size}/${count}`);
        await Bun.sleep(settleMs);
        const visited = take();
        phase = "capture";
        const captures: any[] = [];
        if (run === 0) {
          for (let i = 0; i < count; i++) {
            const path = await next(),
              index = files.findIndex((f) => f.path === path);
            if (index < 0) throw new Error("Unexpected capture tab");
            const file = join(out, `${id}-document-${index}.png`);
            if (!captureWindowToPng(canvas, file)) throw new Error("Capture failed");
            captures.push({ index, file, sha256: hash(file) });
          }
        }
        phase = "closed";
        sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
        if ((await client.request(ControlCommand.TestCurrentTab))[0] === 0) throw new Error("Tabs not closed");
        await Bun.sleep(settleMs);
        const closed = take();
        const measured = samples.filter((s) => s.phase === "restore" || s.phase === "visit");
        const bg = background(measured),
          memoryLoads = measured.map((s) => s.system.loadPercent);
        const reasons: string[] = [];
        if (bg.meanPercent > maxBackgroundMean) reasons.push("background CPU mean");
        if (bg.p95Percent > maxBackgroundP95) reasons.push("background CPU p95");
        if (Math.max(...memoryLoads) > maxMemoryLoad) reasons.push("memory pressure");
        const restoreSamples = samples.filter((s) => s.phase === "restore");
        result = {
          id,
          variant: variant.name,
          count,
          run,
          attempt,
          preflight,
          dpi,
          readyInfo,
          activeReadyMs,
          initial,
          ready,
          restored,
          visited,
          closed,
          switchMs,
          background: bg,
          reasons,
          captures,
          restoreCpuMs: processCpu(ready.resources) - processCpu(initial.resources),
          restorePeakPrivateBytes: Math.max(...restoreSamples.map((s) => s.memory.privateBytes)),
          restorePeakWorkingSetBytes: restored.memory.peakWorkingSetBytes,
          sampleMaxGapMs: Math.max(...measured.slice(1).map((s, i) => s.ms - measured[i]!.ms)),
          samples,
        };
      } finally {
        clearInterval(timer);
      }
    },
    ["-appdata", settings, "-window-pos", "900x1000@0x0", "-log-to-file", log],
    {
      env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: values.profile ? "1" : "0" },
      connectTimeoutMs: 30000,
    },
  );
  const text = readFileSync(log, "utf8");
  const opened = [...text.matchAll(/PDFium 158\.0\.8111\.0: opened '([^']+)'/g)].map((m) => m[1]!);
  const paths = new Set(opened);
  if (paths.size !== count || files.some((f) => !paths.has(f.path)) || text.includes("Using MuPDF fallback")) {
    throw new Error("Wrong engine/open paths");
  }
  result.engineOpenCount = opened.length;
  results.push(result);
  save();
  console.log(
    `${id}: ready ${result.activeReadyMs.toFixed(1)}ms; peak Private ${(result.restorePeakPrivateBytes / 1048576).toFixed(1)}MiB; background mean/p95 ${result.background.meanPercent.toFixed(1)}/${result.background.p95Percent.toFixed(1)}%; ${result.reasons.join(",") || "eligible"}`,
  );
  return result;
}
function compare(a: any, b: any) {
  if (JSON.stringify(a.dpi) !== JSON.stringify(b.dpi)) throw new Error("DPI mismatch");
  for (const x of a.captures) {
    const y = b.captures.find((c: any) => c.index === x.index);
    if (!y) throw new Error("Missing paired capture");
    const left = loadPng(x.file),
      right = loadPng(y.file);
    const sameSize = left.w === right.w && left.h === right.h && left.nComp === right.nComp;
    let changedPixels = 0;
    if (sameSize)
      for (let p = 0; p < left.w * left.h; p++) {
        const off = p * left.nComp;
        if (left.data.subarray(off, off + left.nComp).some((v, c) => v !== right.data[off + c])) changedPixels++;
      }
    comparisons.push({
      count: a.count,
      run: a.run,
      attempt: a.attempt,
      index: x.index,
      before: x,
      after: y,
      width: left.w,
      height: left.h,
      sameSize,
      changedPixels,
    });
    save();
    if (!sameSize || changedPixels || x.sha256 !== y.sha256) throw new Error("Restored pixels changed");
  }
}
const hidden: [string, string][] = [];
try {
  for (const pdb of new Set([
    resolve("out/rel64/SumatraPDF.pdb"),
    ...variants.map((v) => v.exe.replace(/\.exe$/i, ".pdb")),
  ])) {
    if (!pdb.startsWith(resolve("out") + "\\")) throw new Error("PDB outside output");
    const dest = pdb + ".tabgroup-hidden";
    if (existsSync(dest)) throw new Error("Interrupted PDB: " + dest);
    if (existsSync(pdb)) {
      renameSync(pdb, dest);
      hidden.push([pdb, dest]);
    }
  }
  for (const count of counts)
    for (let run = 0; run < runs; run++) {
      let accepted = false;
      for (let attempt = 0; attempt < maxPairAttempts && !accepted; attempt++) {
        const ordered = (run + attempt) % 2 ? [...variants].reverse() : variants;
        const rows: any[] = [];
        for (const v of ordered) rows.push(await measure(v, count, run, attempt));
        const a = rows.find((r) => r.variant === "before"),
          b = rows.find((r) => r.variant === "after");
        compare(a, b);
        const reasons = [...a.reasons, ...b.reasons];
        const delta = Math.abs(a.initial.system.loadPercent - b.initial.system.loadPercent);
        if (delta > maxPairStartMemoryDifference) reasons.push("pair starting memory pressure differs");
        accepted = !reasons.length;
        pairs.push({ count, run, attempt, before: a.id, after: b.id, accepted, reasons });
        save();
      }
      if (!accepted) throw new Error("Pair failed background-load criteria after retries");
    }
} finally {
  for (const [pdb, dest] of hidden) renameSync(dest, pdb);
}
