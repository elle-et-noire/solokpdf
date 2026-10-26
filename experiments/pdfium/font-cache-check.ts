// System font cache gate: app-rendered pages must match with the cache off, cold and warm.
// Usage: bun experiments/pdfium/font-cache-check.ts [--exe out/rel64/SumatraPDF.exe] [--runs 3]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : def;
};
const exe = resolve(opt("--exe", "out/rel64/SumatraPDF.exe"));
const runs = Number(opt("--runs", "3"));
const out = resolve("out/solok-font-cache");
const inputs = [
  ["attention", ".work/corpus/attention-1706.03762v7.pdf", "1,4"],
  ["bert", ".work/corpus/independent/bert-1810.04805.pdf", "1"],
  ["ipa", ".work/corpus/independent/ipa-2026-soshiki.pdf", "1"],
] as const;
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// slowest FPDF_LoadPage: the one where PDFium enumerated system fonts
async function render(name: string, pdf: string, pages: string, appdata: string, cache: string, tag: string) {
  mkdirSync(appdata, { recursive: true });
  const log = join(out, `${name}-${tag}.log`);
  const images = await withControlledSumatra(
    exe,
    async (client) => {
      await client.waitForRenderIdle();
      const r = await client.request(ControlCommand.TestConvertToImages, [
        join(out, `${name}-${tag}-<N>.bmp`),
        pages,
        96,
      ]);
      if (r[0] !== 0) throw new Error(`${name} ${tag}: ${r[1]}`);
      return pages.split(",").map((p) => join(out, `${name}-${tag}-${p}.bmp`));
    },
    ["-appdata", appdata, "-log-to-file", log, resolve(pdf)],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_FONT_CACHE: cache, SOLOKPDF_PROFILE: "1" } },
  );
  const text = readFileSync(log, "utf8");
  const pageMs = [...text.matchAll(/PDFium profile: render .* page=([\d.]+) ms/g)].map((m) => Number(m[1]));
  const firstPageMs = Math.max(...pageMs);
  const enumMs = Number(/PdfiumFontCache: \w+ \d+ localized fonts in ([\d.]+) ms/.exec(text)?.[1] ?? NaN);
  const mode = /PdfiumFontCache: (\w+)/.exec(text)?.[1] ?? "off";
  return { tag, mode, firstPageMs, enumMs, hashes: images.map(sha256) };
}

mkdirSync(out, { recursive: true });
const results: unknown[] = [];
let matches = true;
for (let run = 0; run < runs; run++) {
  for (const [name, pdf, pages] of inputs) {
    const appdata = join(out, `appdata-${name}-${run}`);
    rmSync(appdata, { recursive: true, force: true });
    const rows = [
      await render(name, pdf, pages, join(out, "appdata-off"), "0", `${run}-off`),
      await render(name, pdf, pages, appdata, "1", `${run}-cold`),
      await render(name, pdf, pages, appdata, "1", `${run}-warm`),
    ];
    const identical = rows.every((r) => r.hashes.join() === rows[0]!.hashes.join());
    matches &&= identical;
    results.push({ run, name, pdf: resolve(pdf), pages, identical, rows });
    console.log(
      `${name} run=${run} identical=${identical} ` +
        rows.map((r) => `${r.mode}:${r.firstPageMs.toFixed(1)}ms(enum ${r.enumMs.toFixed(1)})`).join(" "),
    );
  }
}
writeFileSync(
  join(out, "results.json"),
  JSON.stringify({ exe, exeSha256: sha256(exe), matches, results }, null, 2) + "\n",
);
if (!matches) {
  console.error("Font cache changed rendered pages");
  process.exitCode = 1;
}
