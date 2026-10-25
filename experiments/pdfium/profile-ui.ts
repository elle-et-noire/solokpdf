import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { processMemory } from "../../tests/winapi.ts";

const exe = resolve("out/solokpdf-dev/SolokPDF.exe");
const out = resolve("out/solok-phase4-profile");
const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error("usage: bun experiments/pdfium/profile-ui.ts <pdf> [...pdf]");
mkdirSync(out, { recursive: true });
const results: unknown[] = [];
for (const input of inputs) {
  const pdf = resolve(input);
  const settings = join(out, basename(pdf) + ".settings");
  const log = join(out, basename(pdf) + ".log");
  mkdirSync(settings, { recursive: true });
  writeFileSync(
    join(settings, "SolokPDF-settings.txt"),
    "UiLanguage = en\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\n",
  );
  const samples: unknown[] = [];
  await withControlledSumatra(
    exe,
    async (client, proc) => {
      await client.setNotificationsEnabled(false);
      await client.waitForRenderIdle();
      const firstMemory = processMemory(proc.pid!);
      const info = await client.request(ControlCommand.TestPageInfo);
      const pages = Number(/pages=(\d+)/.exec(String(info[1]))?.[1]);
      if (!pages) throw new Error(`Invalid page info: ${info}`);
      for (const page of [...new Set([4, Math.ceil(pages / 2), pages, 1])]) {
        const nav = await client.request(ControlCommand.TestFavoriteNav, ["goto", page]);
        if (nav[0] !== 0) throw new Error(`Navigation failed: ${nav}`);
        await client.waitForRenderIdle();
        samples.push({ page, memory: processMemory(proc.pid!) });
      }
      results.push({ pdf, pages, firstMemory, samples });
    },
    ["-appdata", settings, "-window-pos", "900x1000@0x0", "-log-to-file", log, pdf],
    {
      env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "1" },
    },
  );
  const phases = readFileSync(log, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("PDFium profile:"));
  if (!phases.length) throw new Error(`No PDFium profile samples; rebuild the Debug executable: ${log}`);
  console.log(basename(pdf) + "\n" + phases.join("\n"));
}
writeFileSync(
  join(out, "results.json"),
  JSON.stringify(
    { exe, note: "Diagnostic Debug runs with logging; not a Release performance comparison.", results },
    null,
    2,
  ) + "\n",
);
