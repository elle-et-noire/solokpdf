import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlClient, ControlCommand, uniquePipeName } from "../../tests/control.ts";
import { cmdId } from "../../tests/util.ts";
import { sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import {
  enumWindows,
  findChildWindow,
  getControlText,
  getWindowPid,
  getWindowText,
  killAndWait,
  processGuiResources,
  processMemory,
  setProcessDpiAware,
  systemCpuTimes,
  systemMemory,
} from "../../tests/winapi.ts";
import { background, hash, policy, sampleMs } from "./normal-startup-ui.ts";

const mib = 1048576;
const monitorScript = resolve("experiments/pdfium/normal-startup-ui.ts");
const total = (c: ReturnType<typeof systemCpuTimes>) => c.kernelMs + c.userMs;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      exe: { type: "string", default: "out/solokpdf-portable/SolokPDF.exe" },
      output: { type: "string", default: "out/solok-direct-startup" },
      runs: { type: "string", default: "3" },
      profile: { type: "boolean" },
      warm: { type: "boolean" },
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
    })),
    variants = ["pdfium", "mupdf"];
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
          profile: !!values.profile,
          warm: !!values.warm,
          status,
          conditions:
            "Same Release exe/DLLs; PDF passed on process command line; -for-testing; fresh isolated settings; 900x1000, 100% zoom; warm OS file cache; app PDBs hidden. Launch to render idle includes control and polling. Independent Bun monitor is ready before target spawn and attaches immediately after it. First memory sample at render idle, second after 1s; cache info is read after monitoring; close sample after 1s. Background includes harness/OS and excludes target CPU. Profile runs are diagnostic only.",
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
    for (const start = performance.now(); performance.now() - start < policy.timeoutMs;) {
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

  // unmeasured launch with the same settings dir, so the measured one finds a warm font cache
  async function warmUp(settings: string, pdf: string, engine: string) {
    const pipe = uniquePipeName(),
      proc = Bun.spawn(
        [exe, "-for-testing", "-dbg-control", pipe, "-appdata", settings, "-window-pos", "900x1000@0x0", pdf],
        { stdout: "ignore", stderr: "ignore", env: { ...process.env, SOLOKPDF_ENGINE: engine } },
      );
    try {
      const client = await ControlClient.connect(pipe, 30000);
      await client.waitForRenderIdle(30000);
      await client.quit();
      await Promise.race([proc.exited, Bun.sleep(30000)]);
    } finally {
      if (proc.exitCode === null) await killAndWait(proc);
    }
  }

  async function measure(pdf: (typeof pdfs)[number], run: number, attempt: number, engine: string) {
    const id = `${pdfs.indexOf(pdf)}-${run}-${attempt}-${engine}`;
    await gate(id);
    const settings = join(out, id),
      log = join(out, id + ".log");
    mkdirSync(settings, { recursive: true });
    writeFileSync(
      join(settings, "SolokPDF-settings.txt"),
      "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n",
    );
    if (values.warm) {
      await warmUp(settings, pdf.path, engine);
      await gate(id + "-warm");
    }
    const monitor = Bun.spawn([process.execPath, monitorScript, "--monitor", "0"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const errors = new Response(monitor.stderr).text(),
      reader = monitor.stdout.getReader();
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
      monitor.stdin.write(value + "\n");
      await monitor.stdin.flush();
      return receive();
    }
    let proc: Bun.Subprocess | undefined, client: ControlClient | undefined, row: any;
    try {
      if ((await receive()).event !== "ready") throw new Error("Monitor not ready");
      const pipe = uniquePipeName(),
        launchEpochMs = Date.now(),
        launch = performance.now();
      proc = Bun.spawn(
        [
          exe,
          "-for-testing",
          "-dbg-control",
          pipe,
          "-appdata",
          settings,
          "-window-pos",
          "900x1000@0x0",
          "-log-to-file",
          log,
          pdf.path,
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
          env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_PROFILE: values.profile ? "1" : "0" },
        },
      );
      const stderr = new Response(proc.stderr).text();
      await command(`start ${proc.pid}`);
      client = await ControlClient.connect(pipe, 30000);
      const connectedMs = performance.now() - launch;
      await client.setNotificationsEnabled(false);
      await client.waitForRenderIdle(30000);
      const firstIdleMs = performance.now() - launch,
        first = { memory: processMemory(proc.pid), resources: processGuiResources(proc.pid) };
      await Bun.sleep(1000);
      const settled = { memory: processMemory(proc.pid), resources: processGuiResources(proc.pid) },
        samples = (await command("stop")).samples,
        bg = background(samples),
        monitorLagMs = samples[0].epochMs - launchEpochMs,
        reasons: string[] = [];
      if (bg.meanPercent > policy.backgroundMean) reasons.push("background CPU mean");
      if (bg.p95Percent > policy.backgroundP95) reasons.push("background CPU p95");
      if (Math.max(...samples.map((s: any) => s.system.loadPercent)) > policy.memory) reasons.push("memory pressure");
      if (monitorLagMs > sampleMs / 2) reasons.push("monitor attached late");

      const frame = await waitForFrame(proc.pid);
      if (!frame) throw new Error("No frame");
      sendCommandSync(frame, cmdId("CmdDebugToggleCacheInfo"));
      let cacheWindow = 0,
        cache = "";
      try {
        for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
          await client.request(ControlCommand.Ping);
          enumWindows((hwnd) => {
            if (getWindowPid(hwnd) === proc!.pid && getWindowText(hwnd) === "Cache Info") cacheWindow = hwnd;
            return true;
          });
          const edit = cacheWindow && findChildWindow(cacheWindow, "Edit");
          cache = edit ? getControlText(edit) : "";
          if (cache.startsWith("Cached objects:")) break;
          await Bun.sleep(20);
        }
        if (!cache.startsWith("Cached objects:")) throw new Error("No cache snapshot");
      } finally {
        if (cacheWindow) sendCommandSync(frame, cmdId("CmdDebugToggleCacheInfo"));
      }
      const pixels = /Pixel storage: (\d+) bytes \((\d+) measured, (\d+) unknown\)/.exec(cache);
      sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
      if ((await client.request(ControlCommand.TestCurrentTab))[0] === 0) throw new Error("Document still open");
      await Bun.sleep(1000);
      const closed = { memory: processMemory(proc.pid), resources: processGuiResources(proc.pid) };
      row = {
        id,
        pdf: pdf.path,
        run,
        attempt,
        engine,
        connectedMs,
        firstIdleMs,
        monitorLagMs,
        first,
        settled,
        closed,
        cache,
        pixelBytes: pixels ? Number(pixels[1]) : null,
        measuredObjects: pixels ? Number(pixels[2]) : null,
        unknownObjects: pixels ? Number(pixels[3]) : null,
        background: bg,
        reasons,
        samples,
      };
      await client.quit();
      client = undefined;
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<"timeout">((done) => {
          exitTimer = setTimeout(() => done("timeout"), 30000);
        }),
      ]);
      clearTimeout(exitTimer);
      if (exitCode === "timeout") throw new Error("Target did not exit");
      if (exitCode !== 0) throw new Error("Target exit code " + exitCode + "\n" + (await stderr));
    } finally {
      if (client) {
        try {
          await client.quit();
        } catch {
          if (proc) await killAndWait(proc);
        }
      }
      if (proc && proc.exitCode === null) await killAndWait(proc);
      monitor.stdin.end();
      const code = await Promise.race([monitor.exited, Bun.sleep(2000).then(() => "timeout")]);
      if (code === "timeout") monitor.kill();
    }
    const appLog = readFileSync(log, "utf8");
    if (
      engine === "pdfium" &&
      (!appLog.includes("PDFium 158.0.8111.0: opened") || appLog.includes("Using MuPDF fallback"))
    )
      throw new Error("PDFium was not used");
    row.fontCache = /PdfiumFontCache: (\w+)/.exec(appLog)?.[1] ?? null;
    if (values.profile) row.phases = appLog.split(/\r?\n/).filter((line) => line.startsWith("PDFium profile:"));
    rows.push(row);
    save();
    console.log(
      `${id}: first idle ${row.firstIdleMs.toFixed(1)}ms, private ${(row.settled.memory.privateBytes / mib).toFixed(1)} MiB, pixels ${((row.pixelBytes ?? 0) / mib).toFixed(1)} MiB, other CPU ${row.background.meanPercent.toFixed(1)}/${row.background.p95Percent.toFixed(1)}%, font cache ${row.fontCache ?? "-"}, ${row.reasons.join(",") || "eligible"}`,
    );
    return row;
  }

  const hidden: [string, string][] = [];
  try {
    for (const path of new Set([resolve("out/rel64/SumatraPDF.pdb"), exe.replace(/\.exe$/i, ".pdb")])) {
      const dest = path + ".direct-startup-hidden";
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

await main();
