// Zoom latency: zoom command -> render idle, PDFium vs MuPDF, same Release exe, engine order alternated.
// Usage: bun experiments/pdfium/zoom-ui.ts [--runs 5] [--output dir] [--variants pdfium,mupdf] <pdf>
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { withControlledSumatra } from "../../tests/control.ts";
import { cmdId } from "../../tests/util.ts";
import { sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    exe: { type: "string", default: "out/solokpdf-portable/SolokPDF.exe" },
    output: { type: "string", default: "out/solok-zoom" },
    runs: { type: "string", default: "5" },
    variants: { type: "string", default: "pdfium,mupdf" },
  },
});
const exe = resolve(values.exe!);
const out = resolve(values.output!);
const pdf = resolve(positionals[0] ?? ".work/corpus/attention-1706.03762v7.pdf");
const variants = values.variants!.split(",");
const steps = ["CmdZoom200", "CmdZoom400", "CmdZoom800", "CmdZoom150", "CmdZoomFitWidth", "CmdZoom100"];
mkdirSync(out, { recursive: true });

const prefs =
  "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n";
const variantEnv = (variant: string) => ({
  ...process.env,
  SOLOKPDF_ENGINE: variant.startsWith("pdfium") ? "pdfium" : variant,
});

async function measure(variant: string, run: number) {
  const settings = join(out, `${variant}-${run}`);
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "SolokPDF-settings.txt"), prefs);
  const args = ["-window-pos", "900x1000@0x0", "-appdata", settings, pdf];
  const env = variantEnv(variant);
  // first launch fills the font cache
  await withControlledSumatra(exe, (client) => client.waitForRenderIdle(), args, { env });
  return withControlledSumatra(
    exe,
    async (client, proc) => {
      await client.setNotificationsEnabled(false);
      await client.waitForRenderIdle();
      const frame = await waitForFrame(proc.pid!);
      if (!frame) throw new Error("No frame");
      const row: Record<string, number> = {};
      for (const step of steps) {
        const start = performance.now();
        sendCommandSync(frame, cmdId(step));
        await client.waitForRenderIdle();
        row[step] = performance.now() - start;
      }
      return row;
    },
    args,
    { env },
  );
}

const rows: any[] = [];
for (let run = 0; run < Number(values.runs); run++) {
  const ordered = run % 2 ? [...variants].reverse() : variants;
  for (const variant of ordered) {
    const row = { variant, run, ...(await measure(variant, run)) };
    rows.push(row);
    console.log(variant, run, steps.map((s) => `${s.slice(3)}=${(row as any)[s].toFixed(0)}`).join(" "));
  }
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const medians = Object.fromEntries(
  variants.map((v) => [
    v,
    Object.fromEntries(steps.map((s) => [s, med(rows.filter((r) => r.variant === v).map((r) => r[s]))])),
  ]),
);
writeFileSync(join(out, "results.json"), JSON.stringify({ exe, pdf, steps, medians, rows }, null, 2) + "\n");
console.log(JSON.stringify(medians, null, 1));
