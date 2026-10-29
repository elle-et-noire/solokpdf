import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Row = { id: string; openMs?: number; firstIdleMs?: number };
type Pair = { pdf: string; ids: string[]; accepted: boolean };

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const root = process.argv[2];
if (!root) throw new Error("Pass output directory");

const summary: any[] = [];
for (const kind of ["normal", "direct"]) {
  const result = JSON.parse(readFileSync(join(root, kind, "results.json"), "utf8"));
  if (result.status !== "complete") throw new Error(`${kind}: ${result.status}`);
  const rows = new Map<string, Row>(result.rows.map((row: Row): [string, Row] => [row.id, row]));
  for (const pdf of result.pdfs) {
    const pairs = result.pairs.filter((pair: Pair) => pair.pdf === pdf.path);
    const deltas = pairs.map((pair: Pair) => {
      const pdfium = pair.ids.map((id) => rows.get(id)!).find((row) => row.id.endsWith("-pdfium"));
      const mupdf = pair.ids.map((id) => rows.get(id)!).find((row) => row.id.endsWith("-mupdf"));
      if (!pdfium || !mupdf) throw new Error(`Incomplete pair: ${pair.ids.join(", ")}`);
      return {
        deltaMs: kind === "normal" ? pdfium.openMs! - mupdf.openMs! : pdfium.firstIdleMs! - mupdf.firstIdleMs!,
        accepted: pair.accepted,
      };
    });
    if (pairs.length !== result.runs)
      throw new Error(`${kind}: expected ${result.runs} pairs for ${pdf.path}, got ${pairs.length}`);
    summary.push({
      kind,
      pdf: basename(pdf.path),
      sha256: pdf.sha256,
      pairs: pairs.length,
      qualifying: deltas.filter((delta) => delta.accepted).length,
      medianDeltaMs: median(deltas.map((delta) => delta.deltaMs)),
      qualifyingMedianDeltaMs: median(deltas.filter((delta) => delta.accepted).map((delta) => delta.deltaMs)),
    });
  }
}

writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
const display = (value: number | null) => (value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}`);
const markdown = [
  "## SolokPDF startup: PDFium − MuPDF",
  "",
  "| Measurement | PDF | All pairs median (ms) | Qualifying median (ms) | Qualifying / total |",
  "| --- | --- | ---: | ---: | ---: |",
  ...summary.map(
    (item) =>
      `| ${item.kind} | ${item.pdf} | ${display(item.medianDeltaMs)} | ${display(item.qualifyingMedianDeltaMs)} | ${item.qualifying} / ${item.pairs} |`,
  ),
  "",
  "Hosted-runner timings show relative gaps and trends, not absolute startup times. Non-qualifying pairs remain in the all-pairs median.",
  "",
].join("\n");
writeFileSync(process.env.GITHUB_STEP_SUMMARY ?? join(root, "summary.md"), markdown, { flag: "a" });
console.log(markdown);
