// Working set and commit by mapped file / image / private memory for each engine, at render idle.
// Usage: bun experiments/pdfium/memory-map.ts [--output dir] [--variants pdfium,mupdf] <pdf>...
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId } from "../../tests/util.ts";
import { sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import { processMemoryMap, type MemoryRegionGroup } from "../../tests/winapi.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    exe: { type: "string", default: "out/solokpdf-portable/SolokPDF.exe" },
    output: { type: "string", default: "out/solok-memory-map" },
    variants: { type: "string", default: "pdfium,mupdf" },
  },
});
const exe = resolve(values.exe!);
const out = resolve(values.output!);
const pdfs = (positionals.length ? positionals : [".work/corpus/independent/bert-1810.04805.pdf"]).map((p) =>
  resolve(p),
);
const prefs =
  "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n";
mkdirSync(out, { recursive: true });

const mib = (n: number) => (n / 1048576).toFixed(1);
const maps: Record<string, MemoryRegionGroup[]> = {};
const closedMaps: Record<string, MemoryRegionGroup[]> = {};
for (const variant of values.variants!.split(",")) {
  const settings = join(out, variant);
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "SolokPDF-settings.txt"), prefs);
  const args = ["-window-pos", "900x1000@0x0", "-appdata", settings, ...pdfs];
  const env = { ...process.env, SOLOKPDF_ENGINE: variant.startsWith("pdfium") ? "pdfium" : variant };
  await withControlledSumatra(exe, (client) => client.waitForRenderIdle(), args, { env });
  maps[variant] = await withControlledSumatra(
    exe,
    async (client, proc) => {
      await client.setNotificationsEnabled(false);
      await client.waitForRenderIdle();
      await Bun.sleep(1000);
      const open = processMemoryMap(proc.pid!);
      const frame = await waitForFrame(proc.pid!);
      if (!frame) throw new Error("No frame");
      sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
      if ((await client.request(ControlCommand.TestCurrentTab))[0] === 0) throw new Error("Document still open");
      await Bun.sleep(1000);
      closedMaps[variant] = processMemoryMap(proc.pid!);
      return open;
    },
    args,
    { env },
  );
}

// groups whose working set differs most between the first two variants
const [a, b] = Object.keys(maps) as [string, string];
const key = (g: MemoryRegionGroup) => g.kind + " " + (g.file.split("\\").pop() || "");
const rows = new Map<string, { a?: MemoryRegionGroup; b?: MemoryRegionGroup }>();
for (const g of maps[a]!) rows.set(key(g), { ...rows.get(key(g)), a: g });
for (const g of maps[b]!) rows.set(key(g), { ...rows.get(key(g)), b: g });
const total = (m: MemoryRegionGroup[], k: "workingSet" | "committed") => m.reduce((s, g) => s + g[k], 0);
console.log(`total WS ${a} ${mib(total(maps[a]!, "workingSet"))} / ${b} ${mib(total(maps[b]!, "workingSet"))} MiB`);
console.log(
  `closed WS ${a} ${mib(total(closedMaps[a]!, "workingSet"))} / ${b} ${mib(total(closedMaps[b]!, "workingSet"))} MiB`,
);
console.log(`committed ${a} ${mib(total(maps[a]!, "committed"))} / ${b} ${mib(total(maps[b]!, "committed"))} MiB`);
for (const kind of ["image", "mapped", "private"]) {
  const ws = (m: MemoryRegionGroup[]) => m.filter((g) => g.kind === kind).reduce((s, g) => s + g.workingSet, 0);
  console.log(`  ${kind}: ${mib(ws(maps[a]!))} / ${mib(ws(maps[b]!))}`);
}
const diffs = [...rows.entries()]
  .map(([k, r]) => ({ k, d: (r.a?.workingSet ?? 0) - (r.b?.workingSet ?? 0), a: r.a, b: r.b }))
  .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
  .slice(0, 15);
for (const r of diffs)
  console.log(`${mib(r.d).padStart(6)}  ${r.k}  WS ${mib(r.a?.workingSet ?? 0)}/${mib(r.b?.workingSet ?? 0)}`);
writeFileSync(join(out, "results.json"), JSON.stringify({ exe, pdfs, maps, closedMaps }, null, 2) + "\n");
