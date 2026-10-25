import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId, loadPng } from "../../tests/util.ts";
import { findCanvas, sendCommand, sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import {
  captureWindowToPng,
  processGuiResources,
  processMemory,
  sendMessage,
  setProcessDpiAware,
  systemMemory,
} from "../../tests/winapi.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    before: { type: "string" },
    after: { type: "string", default: "out/solokpdf-portable/SolokPDF.exe" },
    output: { type: "string", default: "out/solok-memory" },
    runs: { type: "string", default: "3" },
    reverse: { type: "boolean" },
    hold: { type: "string", default: "0" },
    cycles: { type: "string", default: "4" },
    tabs: { type: "string", default: "1,4" },
    window: { type: "string", default: "900x1000" },
    large: { type: "boolean" },
    mixed: { type: "boolean" },
    profile: { type: "boolean" },
    pause: { type: "string", default: "20" },
  },
});
if (!values.before || !positionals.length)
  throw new Error("usage: bun experiments/pdfium/memory-ui.ts --before <exe> [--after <exe>] <pdf> [...pdf]");
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("runs must be a positive integer");
const holdSeconds = Number(values.hold);
const cycles = Number(values.cycles);
const tabCounts = values.tabs.split(",").map(Number);
if (!Number.isInteger(holdSeconds) || holdSeconds < 0) throw new Error("hold must be nonnegative seconds");
if (!Number.isInteger(cycles) || cycles < 1) throw new Error("cycles must be positive");
if (tabCounts.some((n) => ![1, 4].includes(n))) throw new Error("tabs must be 1 and/or 4");
if (!/^\d+x\d+$/.test(values.window)) throw new Error("window must be widthxheight");
if (values.mixed && positionals.length !== 4) throw new Error("mixed requires four independent input paths");
const sampleIntervalMs = 5;
const idleSettleMs = 500;
const zoomPauseMs = Number(values.pause);
if (!Number.isInteger(zoomPauseMs) || zoomPauseMs < 0) throw new Error("pause must be nonnegative milliseconds");
const out = resolve(values.output);
mkdirSync(out, { recursive: true });
setProcessDpiAware();
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const variants = [
  { name: "before", exe: resolve(values.before) },
  { name: "after", exe: resolve(values.after) },
].map((v) => ({
  ...v,
  sha256: sha256(v.exe),
  dependencies: ["pdfium.dll", "libsumatrapdf.dll"].map((name) => ({
    name,
    sha256: sha256(join(dirname(v.exe), name)),
  })),
}));
if (JSON.stringify(variants[0]!.dependencies) !== JSON.stringify(variants[1]!.dependencies))
  throw new Error("Before/after DLL hashes differ");
const sources = positionals.map((file, i) => {
  const path = resolve(file);
  const copies = Array.from({ length: 4 }, (_, tab) => join(out, `input-${i}-tab-${tab}.pdf`));
  for (const copy of copies) copyFileSync(path, copy);
  return { path, sha256: sha256(path), copies };
});
const inputs = values.mixed ? [{ ...sources[0]!, copies: sources.map((s) => s.copies[0]!) }] : sources;
type Memory = ReturnType<typeof processMemory>;
const results: unknown[] = [];
const comparisons: unknown[] = [];
const hidden: [string, string][] = [];
function compareImages(inputNo: number, name: string, beforeFile: string, afterFile: string): void {
  const a = loadPng(beforeFile),
    b = loadPng(afterFile);
  const dimensionsMatch = a.w === b.w && a.h === b.h && a.nComp === b.nComp;
  let changedPixels = 0;
  if (dimensionsMatch) {
    for (let pixel = 0; pixel < a.w * a.h; pixel++) {
      const offset = pixel * a.nComp;
      if (a.data.subarray(offset, offset + a.nComp).some((v, c) => v !== b.data[offset + c])) changedPixels++;
    }
  }
  comparisons.push({
    inputNo,
    name,
    beforeFile,
    afterFile,
    width: a.w,
    height: a.h,
    dimensionsMatch,
    changedPixels,
    beforeSha256: sha256(beforeFile),
    afterSha256: sha256(afterFile),
  });
  save();
  if (!dimensionsMatch || changedPixels)
    throw new Error(`Rendering changed: ${basename(beforeFile)} (${changedPixels} pixels)`);
}
function save(): void {
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      {
        variants,
        inputs,
        sources,
        workload: {
          holdSeconds,
          cycles,
          tabCounts,
          large: Boolean(values.large),
          mixed: Boolean(values.mixed),
          profile: Boolean(values.profile),
          zoomPauseMs,
        },
        conditions: `Release x64; identical DLLs; app PDBs hidden; fresh settings; ${values.window} requested window; DPI-aware capture; 100% initial zoom; PDFium default fonts/AA/colors; warm file cache; alternating variant order, starting ${values.reverse ? "after" : "before"}; ${sampleIntervalMs}ms requested memory polling begins at control connection (1000ms during hold); memory snapshots ${idleSettleMs}ms after visible render idle; idle excludes predictive work; whole-process counters, not allocator attribution`,
        results,
        comparisons,
      },
      null,
      2,
    ) + "\n",
  );
}
try {
  for (const file of new Set([
    resolve("out/rel64/SumatraPDF.pdb"),
    ...variants.map((v) => v.exe.replace(/\.exe$/i, ".pdb")),
  ])) {
    if (!file.startsWith(resolve("out") + "\\")) throw new Error("PDB outside workspace output");
    const dest = file + ".memory-hidden";
    if (existsSync(dest)) throw new Error(`Restore interrupted measurement PDB: ${dest}`);
    if (!existsSync(file)) continue;
    renameSync(file, dest);
    hidden.push([file, dest]);
  }
  for (let run = 0; run < runs; run++) {
    for (const [inputNo, input] of inputs.entries()) {
      for (const tabs of tabCounts) {
        const captures = new Map<string, string>();
        for (const variant of Boolean(run % 2) !== Boolean(values.reverse) ? [...variants].reverse() : variants) {
          const id = `input-${inputNo}-${tabs}tabs-run-${run}-${variant.name}`;
          const settings = join(out, id);
          mkdirSync(settings, { recursive: true });
          writeFileSync(
            join(settings, "SolokPDF-settings.txt"),
            "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n",
          );
          const log = join(out, id + ".log");
          const start = performance.now();
          await withControlledSumatra(
            variant.exe,
            async (client, proc) => {
              const samples: { ms: number; phase: string; memory: Memory }[] = [];
              let phase = "startup";
              let lastSample = 0;
              const sample = () => {
                if (phase === "hold" && performance.now() - lastSample < 1000) return;
                lastSample = performance.now();
                samples.push({ ms: lastSample - start, phase, memory: processMemory(proc.pid!) });
              };
              const snapshot = () => ({
                memory: processMemory(proc.pid!),
                gui: processGuiResources(proc.pid!),
                system: systemMemory(),
              });
              sample();
              const timer = setInterval(sample, sampleIntervalMs);
              try {
                await client.setNotificationsEnabled(false);
                const firstRenderInfo = await client.waitForRenderIdle();
                const firstIdleMs = performance.now() - start;
                await Bun.sleep(idleSettleMs);
                const firstMemory = processMemory(proc.pid!);
                const dpi = await client.request(ControlCommand.TestDpi, ["state"]);
                if (dpi[0] !== 0) throw new Error(`Cannot read DPI: ${dpi}`);
                const frame = await waitForFrame(proc.pid!);
                if (!frame) throw new Error("No frame");
                const canvas = findCanvas(frame);
                if (!canvas) throw new Error("No canvas");
                const info = await client.request(ControlCommand.TestPageInfo);
                const pages = Number(/pages=(\d+)/.exec(String(info[1]))?.[1]);
                if (!pages) throw new Error(`Invalid page info: ${info}`);
                const capture = (name: string) => {
                  if (run !== 0 || (tabs !== 1 && !holdSeconds)) return;
                  const file = join(out, `${id}-${name}.png`);
                  if (!captureWindowToPng(canvas, file)) throw new Error("Capture failed");
                  captures.set(`${variant.name}-${name}`, file);
                };
                const goto = async (page: number) => {
                  const res = await client.request(ControlCommand.TestFavoriteNav, ["goto", page]);
                  if (res[0] !== 0) throw new Error(`Navigation failed: ${res}`);
                  await client.waitForRenderIdle();
                };
                const zoomInfo: { command: string; info: string }[] = [];
                const zoom = async (name: string) => {
                  sendCommandSync(frame, cmdId(name));
                  zoomInfo.push({ command: name, info: await client.waitForRenderIdle() });
                };
                const nextTab = async () => {
                  for (let attempt = 0; attempt < tabs + 1; attempt++) {
                    sendCommandSync(frame, cmdId("CmdNextTab"));
                    const next = await client.request(ControlCommand.TestCurrentTab);
                    if (next[0] !== 0) continue;
                    await client.waitForRenderIdle();
                    return;
                  }
                  throw new Error("No document tab after switching");
                };
                phase = "appearance";
                capture("page1-100");
                await zoom("CmdZoom25");
                capture("page1-25");
                await zoom("CmdZoom100");
                await goto(Math.min(4, pages));
                capture("page4-100");
                await zoom("CmdZoom50");
                capture("page4-50");
                await zoom("CmdZoom200");
                capture("page4-200");
                await zoom("CmdZoom400");
                capture("page4-400");
                if (values.large) {
                  await zoom("CmdZoom1600");
                  capture("page4-1600");
                  await zoom("CmdZoom6400");
                  capture("page4-6400");
                }
                await zoom("CmdZoom100");
                for (let i = 0; i < 30; i++) sendMessage(canvas, 0x0115, 1, 0);
                await client.waitForRenderIdle();
                capture("scrolled-100");
                sendCommandSync(frame, cmdId("CmdToggleTransparencyGrid"));
                await client.waitForRenderIdle();
                capture("transparent-100");
                sendCommandSync(frame, cmdId("CmdToggleTransparencyGrid"));
                await client.waitForRenderIdle();
                phase = "tabs";
                const tabSwitchMs: number[] = [];
                const visited = new Set<string>();
                for (let i = 0; i < tabs; i++) {
                  const current = await client.request(ControlCommand.TestCurrentTab);
                  if (current[0] !== 0) throw new Error(`No current tab: ${current}`);
                  visited.add(String(current[1]).replace(/ page=\d+$/, ""));
                  if (tabs === 1) break;
                  const switched = performance.now();
                  await nextTab();
                  tabSwitchMs.push(performance.now() - switched);
                }
                if (visited.size !== tabs) throw new Error(`Visited ${visited.size}/${tabs} tabs`);
                await Bun.sleep(idleSettleMs);
                const allTabsMemory = processMemory(proc.pid!);
                const retention: { stage: string; ms: number; counters: ReturnType<typeof snapshot> }[] = [];
                const record = (stage: string) =>
                  retention.push({ stage, ms: performance.now() - start, counters: snapshot() });
                record("after-tabs");
                const reactivationMs: number[] = [];
                if (holdSeconds) {
                  capture("before-hold");
                  phase = "hold";
                  for (let second = 1; second <= holdSeconds; second++) {
                    await Bun.sleep(1000);
                    if (second % 10 === 0 || second === holdSeconds) record(`hold-${second}s`);
                  }
                  capture("after-hold");
                  phase = "reactivate";
                  for (let cycle = 0; cycle < cycles; cycle++) {
                    for (let tab = 0; tab < tabs; tab++) {
                      const switched = performance.now();
                      await nextTab();
                      reactivationMs.push(performance.now() - switched);
                    }
                    await Bun.sleep(idleSettleMs);
                    record(`reactivate-${cycle + 1}`);
                  }
                  capture("reactivated");
                }
                phase = "zoom-cancel";
                const stressCpu = processGuiResources(proc.pid!);
                const stressStart = performance.now();
                for (let cycle = 0; cycle < cycles; cycle++) {
                  for (const command of values.large
                    ? ["CmdZoom100", "CmdZoom1600", "CmdZoom25"]
                    : ["CmdZoom400", "CmdZoom200", "CmdZoom100"]) {
                    sendCommand(frame, cmdId(command));
                    await Bun.sleep(zoomPauseMs);
                  }
                }
                await client.request(ControlCommand.Ping);
                await client.waitForRenderIdle();
                const stressToIdleMs = performance.now() - stressStart;
                const stressEndCpu = processGuiResources(proc.pid!);
                const stressCpuMs =
                  stressEndCpu.kernelCpuMs + stressEndCpu.userCpuMs - stressCpu.kernelCpuMs - stressCpu.userCpuMs;
                await Bun.sleep(idleSettleMs);
                sample();
                const afterStressMemory = processMemory(proc.pid!);
                record("after-stress");
                phase = "close-pending";
                sendCommand(frame, cmdId(values.large ? "CmdZoom100" : "CmdZoom400"));
                await Bun.sleep(zoomPauseMs);
                const closeStart = performance.now();
                sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
                const closed = await client.request(ControlCommand.TestCurrentTab);
                if (closed[0] === 0) throw new Error(`Document still open: ${closed}`);
                const closeMs = performance.now() - closeStart;
                await Bun.sleep(idleSettleMs);
                record("closed-500ms");
                if (holdSeconds) {
                  phase = "closed-hold";
                  await Bun.sleep(5000);
                  record("closed-5500ms");
                }
                results.push({
                  inputNo,
                  tabs,
                  run,
                  variant: variant.name,
                  dpi,
                  pageInfo: info,
                  firstRenderInfo,
                  zoomInfo,
                  firstIdleMs,
                  firstMemory,
                  allTabsMemory,
                  tabSwitchMs,
                  stressToIdleMs,
                  stressCpuMs,
                  afterStressMemory,
                  closeMs,
                  retention,
                  reactivationMs,
                  sampledPeakPrivateBytes: Math.max(...samples.map((s) => s.memory.privateBytes)),
                  samples,
                });
                console.log(
                  `${id}: peak private ${(Math.max(...samples.map((s) => s.memory.privateBytes)) / 1048576).toFixed(1)} MiB; zoom→idle ${stressToIdleMs.toFixed(1)} ms`,
                );
              } finally {
                clearInterval(timer);
              }
            },
            [
              "-appdata",
              settings,
              "-window-pos",
              `${values.window}@0x0`,
              "-log-to-file",
              log,
              ...input.copies.slice(0, tabs),
            ],
            {
              env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: values.profile ? "1" : "0" },
              connectTimeoutMs: 30_000,
            },
          );
          const text = readFileSync(log, "utf8");
          if (!text.includes("PDFium 158.0.8111.0: opened") || text.includes("Using MuPDF fallback"))
            throw new Error(`PDFium was not used: ${log}`);
          save();
          if (holdSeconds && run === 0) {
            for (const stage of ["after-hold", "reactivated"]) {
              compareImages(
                inputNo,
                `${variant.name}-${stage}-unchanged`,
                captures.get(`${variant.name}-before-hold`)!,
                captures.get(`${variant.name}-${stage}`)!,
              );
            }
          }
        }
        for (const [name, beforeFile] of captures) {
          if (!name.startsWith("before-")) continue;
          const afterFile = captures.get(name.replace("before-", "after-"))!;
          compareImages(inputNo, name, beforeFile, afterFile);
        }
      }
    }
  }
} finally {
  for (const [file, dest] of hidden) renameSync(dest, file);
}
