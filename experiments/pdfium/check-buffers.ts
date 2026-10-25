import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { variant: { type: "string", default: "after" }, limit: { type: "string", default: "1" } },
});
if (positionals.length !== 1) throw new Error("Pass memory-ui.ts output directory");
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid limit");
const out = positionals[0]!;
const data = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
const rows = data.results
  .filter((r: any) => r.variant === values.variant)
  .map((r: any) => {
    const file = `input-${r.inputNo}-${r.tabs}tabs-run-${r.run}-${r.variant}.log`;
    const bytes = readFileSync(join(out, file));
    const events = [
      ...bytes
        .toString("utf8")
        .matchAll(/PDFium buffers: thread=(\d+) page=(\d+) delta=(-?\d+) live=(\d+) count=(\d+)/g),
    ].map((m) => ({
      delta: Number(m[3]),
      live: Number(m[4]),
      count: Number(m[5]),
    }));
    if (!events.length) throw new Error(`No buffer diagnostics: ${file}`);
    let live = 0,
      count = 0;
    for (const e of events) {
      live += e.delta;
      count += Math.sign(e.delta);
      if (live !== e.live || count !== e.count || live < 0 || count < 0) throw new Error(`Unbalanced trace: ${file}`);
    }
    if (live || count) throw new Error(`Unreleased reservations: ${file}`);
    return {
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      events: events.length,
      peakBytes: Math.max(...events.map((e) => e.live)),
      peakCount: Math.max(...events.map((e) => e.count)),
    };
  });
if (!rows.length) throw new Error("No matching results");
for (const c of data.comparisons) {
  if (!c.dimensionsMatch || c.changedPixels || c.beforeSha256 !== c.afterSha256) throw new Error("Rendering changed");
}
const passed = rows.every((r: any) => r.peakCount <= limit);
writeFileSync(
  join(out, `buffers-${values.variant}.json`),
  JSON.stringify(
    {
      note: "Initial BGRA sizes of active RenderPage calls, counted until return; final storage can be smaller after compaction. Excludes gray-copy scratch, cached/caller-owned output and SDK allocations. Diagnostic runs are excluded from timing/memory aggregates.",
      limit,
      passed,
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ limit, passed, rows }, null, 2));
if (!passed) throw new Error("Concurrent PDFium buffer reservations exceed limit");
