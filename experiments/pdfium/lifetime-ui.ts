import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId, loadPng } from "../../tests/util.ts";
import { findCanvas, sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import {
  captureWindowToPng,
  processGuiResources,
  processMemory,
  sendCopyDataW,
  setProcessDpiAware,
  systemMemory,
} from "../../tests/winapi.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    before: { type: "string" },
    after: { type: "string" },
    output: { type: "string", default: "out/solok-lifetime" },
    hold: { type: "string", default: "600" },
    cycles: { type: "string", default: "32" },
    reverse: { type: "boolean" },
    only: { type: "string", default: "all" },
  },
});
if (!values.before || !values.after || positionals.length !== 4)
  throw new Error("Pass --before, --after and four PDFs");
const holdSeconds = Number(values.hold),
  cycles = Number(values.cycles);
if (!Number.isInteger(holdSeconds) || holdSeconds < 0 || !Number.isInteger(cycles) || cycles < 1)
  throw new Error("Invalid hold/cycles");
if (!["all", "before", "after"].includes(values.only)) throw new Error("only must be all, before or after");
const settleMs = 500,
  holdIntervalMs = 1000,
  recordSeconds = 10,
  kCopyDataDdeW = 0x44646557;
const out = resolve(values.output);
mkdirSync(out, { recursive: true });
setProcessDpiAware();
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
  throw new Error("Different DLLs");
const inputs = positionals.map((file, i) => {
  const path = resolve(file),
    copy = join(out, `input-${i}.pdf`);
  copyFileSync(path, copy);
  return { path, copy, sha256: hash(path) };
});
const results: unknown[] = [],
  comparisons: unknown[] = [];
const save = () =>
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      {
        variants,
        inputs,
        holdSeconds,
        cycles,
        only: values.only,
        conditions:
          "Release x64; matched DLLs; app PDBs hidden; fresh settings; requested 900x1000; PDFium fonts/flags/colors unchanged; CPU, handle and system-pressure snapshots; hold is bounded, not proof of leak freedom",
        results,
        comparisons,
      },
      null,
      2,
    ) + "\n",
  );
const hidden: [string, string][] = [];
try {
  for (const path of new Set([
    resolve("out/rel64/SumatraPDF.pdb"),
    ...variants.map((v) => v.exe.replace(/\.exe$/i, ".pdb")),
  ])) {
    if (!path.startsWith(resolve("out") + "\\")) throw new Error("PDB outside output directory");
    const dest = path + ".lifetime-hidden";
    if (existsSync(dest)) throw new Error(`Restore PDB: ${dest}`);
    if (existsSync(path)) {
      renameSync(path, dest);
      hidden.push([path, dest]);
    }
  }
  for (const variant of values.reverse ? [...variants].reverse() : variants) {
    if (values.only !== "all" && variant.name !== values.only) continue;
    const settings = join(out, variant.name);
    mkdirSync(settings, { recursive: true });
    writeFileSync(
      join(settings, "SolokPDF-settings.txt"),
      "UiLanguage = en\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\nCheckForUpdates = false\n",
    );
    const log = join(out, variant.name + ".log");
    await withControlledSumatra(
      variant.exe,
      async (client, proc) => {
        await client.setNotificationsEnabled(false);
        const frame = await waitForFrame(proc.pid!);
        if (!frame) throw new Error("No frame");
        const canvas = findCanvas(frame);
        if (!canvas) throw new Error("No canvas");
        const start = performance.now();
        const snapshots: unknown[] = [],
          openMs: number[] = [],
          closeMs: number[] = [],
          switchMs: number[] = [];
        const snap = (stage: string) => {
          snapshots.push({
            stage,
            ms: performance.now() - start,
            memory: processMemory(proc.pid!),
            resources: processGuiResources(proc.pid!),
            system: systemMemory(),
          });
          save();
        };
        const result: Record<string, unknown> = {
          variant: variant.name,
          snapshots,
          openMs,
          closeMs,
          switchMs,
          completed: false,
        };
        results.push(result);
        const capture = (name: string) => {
          const path = join(out, `${variant.name}-${name}.png`);
          if (!captureWindowToPng(canvas, path)) throw new Error("Capture failed");
          return path;
        };
        const open = async () => {
          for (const input of inputs) {
            if (!sendCopyDataW(frame, kCopyDataDdeW, `[Open("${input.copy}",0,1,0)]`))
              throw new Error("DDE open failed");
            await client.waitForRenderIdle(30000);
          }
          const seen = new Set<string>();
          for (let i = 0; i < inputs.length; i++) {
            const tab = await client.request(ControlCommand.TestCurrentTab);
            if (tab[0] !== 0) throw new Error("No current document");
            seen.add(String(tab[1]).replace(/ page=\d+$/, ""));
            const switching = performance.now();
            for (let attempt = 0; attempt <= inputs.length; attempt++) {
              sendCommandSync(frame, cmdId("CmdNextTab"));
              const next = await client.request(ControlCommand.TestCurrentTab);
              if (next[0] === 0) break;
            }
            await client.waitForRenderIdle(30000);
            switchMs.push(performance.now() - switching);
          }
          if (seen.size !== inputs.length) throw new Error("Not all documents visited");
        };
        const close = async () => {
          const closing = performance.now();
          sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
          const tab = await client.request(ControlCommand.TestCurrentTab);
          if (tab[0] === 0) throw new Error("Document still open");
          closeMs.push(performance.now() - closing);
        };
        await Bun.sleep(settleMs);
        snap("empty-start");
        const firstOpen = performance.now();
        await open();
        openMs.push(performance.now() - firstOpen);
        const dpi = await client.request(ControlCommand.TestDpi, ["state"]);
        const pageInfo = await client.request(ControlCommand.TestPageInfo);
        result.dpi = dpi;
        result.pageInfo = pageInfo;
        await Bun.sleep(settleMs);
        const firstCapture = capture("before-hold");
        snap("open-start");
        for (let second = 1; second <= holdSeconds; second++) {
          await Bun.sleep(holdIntervalMs);
          if (second % recordSeconds === 0 || second === holdSeconds) {
            snap(`hold-${second}s`);
            if (second % 60 === 0) console.log(`${variant.name}: hold ${second}/${holdSeconds}s`);
          }
        }
        const heldCapture = capture("after-hold");
        const a = loadPng(firstCapture),
          b = loadPng(heldCapture);
        const unchanged =
          a.w === b.w &&
          a.h === b.h &&
          a.nComp === b.nComp &&
          a.data.length === b.data.length &&
          a.data.every((value, i) => value === b.data[i]);
        comparisons.push({
          variant: variant.name,
          firstCapture,
          heldCapture,
          unchanged,
          beforeSha256: hash(firstCapture),
          afterSha256: hash(heldCapture),
        });
        if (!unchanged) throw new Error("Held view changed");
        await close();
        await Bun.sleep(settleMs);
        snap("first-close");
        for (let cycle = 0; cycle < cycles; cycle++) {
          const opening = performance.now();
          await open();
          openMs.push(performance.now() - opening);
          await Bun.sleep(settleMs);
          snap(`open-${cycle + 1}`);
          await close();
          await Bun.sleep(settleMs);
          snap(`closed-${cycle + 1}`);
          if ((cycle + 1) % 8 === 0) console.log(`${variant.name}: open/close ${cycle + 1}/${cycles}`);
        }
        await Bun.sleep(5000);
        snap("empty-final");
        result.completed = true;
        save();
        console.log(`${variant.name}: completed`);
      },
      ["-appdata", settings, "-window-pos", "900x1000@0x0", "-log-to-file", log],
      { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "0" }, connectTimeoutMs: 30000 },
    );
    const text = readFileSync(log, "utf8");
    if (!text.includes("PDFium 158.0.8111.0: opened") || text.includes("Using MuPDF fallback"))
      throw new Error("Wrong engine");
    save();
  }
} finally {
  for (const [path, dest] of hidden) renameSync(dest, path);
}
