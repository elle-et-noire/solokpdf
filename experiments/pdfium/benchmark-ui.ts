import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId } from "../../tests/util.ts";
import { waitForFrame, sendCommand, findCanvas } from "../../tests/win-automation.ts";
import { processMemory, sendMessage, captureWindowToPng } from "../../tests/winapi.ts";

const release = process.argv.includes("--release");
const input = resolve(
  process.argv.slice(2).find((arg) => arg !== "--release") ?? ".work/corpus/attention-1706.03762v7.pdf",
);
const out = resolve(release ? "out/pdfium-benchmark-release" : "out/pdfium-benchmark");
const appDir = release ? "out/solokpdf-portable" : "out/solokpdf-dev";
mkdirSync(out, { recursive: true });
const pdfs = Array.from({ length: 4 }, (_, i) => join(out, `paper-${i + 1}.pdf`));
for (const pdf of pdfs) copyFileSync(input, pdf);
const variants = [
  ...(!release ? [{ name: "baseline-mupdf", exe: resolve("out/baseline/bin/SumatraPDF.exe"), engine: "mupdf" }] : []),
  { name: "integrated-mupdf", exe: resolve(appDir, "SolokPDF.exe"), engine: "mupdf" },
  { name: "integrated-pdfium", exe: resolve(appDir, "SolokPDF.exe"), engine: "pdfium" },
];
const results: unknown[] = [];
const hiddenPdbs: [string, string][] = [];
try {
  for (const file of [
    release ? "out/rel64/SumatraPDF.pdb" : "out/dbg64/SumatraPDF.pdb",
    join(appDir, "SolokPDF.pdb"),
  ]) {
    const source = resolve(file);
    const dest = source + ".benchmark-hidden";
    if (!source.startsWith(resolve("out") + "\\") || !dest.startsWith(resolve("out") + "\\"))
      throw new Error("PDB path outside workspace output");
    if (existsSync(dest)) throw new Error(`Restore the PDB left by an interrupted benchmark: ${dest}`);
    if (existsSync(source)) {
      renameSync(source, dest);
      hiddenPdbs.push([source, dest]);
    }
  }
  for (let run = 0; run < 3; run++) {
    for (const variant of variants) {
      for (const tabs of [1, 4]) {
        const id = `${variant.name}-${tabs}tabs-${run}`;
        const settings = join(out, id);
        mkdirSync(settings, { recursive: true });
        const prefs =
          "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n";
        writeFileSync(join(settings, "SumatraPDF-settings.txt"), prefs);
        writeFileSync(join(settings, "SolokPDF-settings.txt"), prefs);
        const start = performance.now();
        await withControlledSumatra(
          variant.exe,
          async (client, proc) => {
            const connected = performance.now() - start;
            await client.setNotificationsEnabled(false);
            await client.waitForRenderIdle();
            const firstIdle = performance.now() - start;
            const firstMemory = processMemory(proc.pid!);
            const frame = await waitForFrame(proc.pid!);
            if (!frame) throw new Error("No Win32 frame");
            const nav = performance.now();
            await client.request(ControlCommand.TestFavoriteNav, ["goto", 4]);
            await client.waitForRenderIdle();
            const page4 = performance.now() - nav;
            const canvas = findCanvas(frame);
            const scroll = performance.now();
            for (let i = 0; i < 12; i++) sendMessage(canvas, 0x0115, 1, 0);
            await client.waitForRenderIdle();
            const scrollBatch = performance.now() - scroll;
            let activated = 1;
            for (let i = 0; activated < tabs && i < tabs * 2; i++) {
              sendCommand(frame, cmdId("CmdNextTab"));
              const current = await client.request(ControlCommand.TestCurrentTab);
              if (current[0] !== 0) continue;
              await client.waitForRenderIdle();
              activated++;
            }
            if (activated !== tabs) throw new Error("Could not activate all document tabs");
            const allTabsMemory = processMemory(proc.pid!);
            if (run === 0 && tabs === 1) captureWindowToPng(frame, join(out, `${variant.name}.png`));
            const row = {
              variant: variant.name,
              run,
              tabs,
              control_connected_ms: connected,
              first_render_idle_ms: firstIdle,
              page4_request_to_idle_ms: page4,
              scroll_12_lines_to_idle_ms: scrollBatch,
              first_memory: firstMemory,
              after_activating_all_tabs_memory: allTabsMemory,
            };
            results.push(row);
            console.log(JSON.stringify(row));
          },
          [
            "-window-pos",
            "900x1000@0x0",
            "-appdata",
            settings,
            "-log-to-file",
            join(out, id + ".log"),
            ...pdfs.slice(0, tabs),
          ],
          { env: { ...process.env, SOLOKPDF_ENGINE: variant.engine } },
        );
        writeFileSync(
          join(out, "results.json"),
          JSON.stringify(
            {
              input,
              conditions: `${release ? "Release" : "Debug"} x64; application PDBs temporarily unavailable for all variants; same 900x1000 window; 100% virtual zoom; fresh isolated settings; process starts, warm OS file cache; request-to-render-idle includes control/polling/UI work; not input-to-photon latency; memory is whole-process`,
              results,
            },
            null,
            2,
          ),
        );
      }
    }
  }
} finally {
  for (const [source, dest] of hiddenPdbs) renameSync(dest, source);
}
