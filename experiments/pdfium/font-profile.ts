import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve("out/solok-font-attribution");
const probe = resolve("out/pdfium-probe/pdfium-render.exe");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const inputs = [
  ["paper-1", ".work/corpus/attention-1706.03762v7.pdf", 1],
  ["paper-4", ".work/corpus/attention-1706.03762v7.pdf", 4],
  ["bert", ".work/corpus/independent/bert-1810.04805.pdf", 1],
  ["ipa", ".work/corpus/independent/ipa-2026-soshiki.pdf", 1],
  ["aliases", "out/solok-phase4-font-check/fonts.pdf", 1],
] as const;
mkdirSync(out, { recursive: true });
const results: unknown[] = [];
let matches = true;
for (let run = 0; run < 3; run++) {
  for (const [name, pdf, page] of inputs) {
    const rows = [];
    for (const profile of run % 2 ? [true, false] : [false, true]) {
      const png = join(out, `${name}-${run}-${profile}.png`);
      const proc = Bun.spawnSync(
        [probe, resolve(pdf), String(page), "96", png, "--lcd", ...(profile ? ["--font-profile"] : [])],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (proc.error || proc.exitCode !== 0) throw new Error(`${proc.error ?? proc.stderr.toString()}`);
      rows.push({ profile, png, sha256: hash(png), metrics: JSON.parse(proc.stdout.toString()) });
    }
    const identical = rows[0]!.sha256 === rows[1]!.sha256;
    matches &&= identical;
    results.push({ run, name, pdf: resolve(pdf), inputSha256: hash(pdf), page, identical, rows });
    writeFileSync(
      join(out, "results.json"),
      JSON.stringify(
        {
          probe,
          probeSha256: hash(probe),
          dllSha256: hash(join(out, "../pdfium-probe/pdfium.dll")),
          note: "Standalone default-v1 callback diagnostic with internal-style face-name lengths, not application startup. Enumeration and data times may overlap. Data bytes are callback transfers, not retained SDK allocations. Any PNG mismatch rejects the callback path for application use and limits attribution to the probe.",
          matches,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(name, run, { identical, ...rows.find((r) => r.profile)!.metrics.font_profile });
  }
}
if (!matches) {
  console.error("Default-v1 callback path changed pixels; application adoption rejected.");
  process.exitCode = 1;
}
