// Opt-in PDFium robustness check: mutated PDFs must not crash or hang the app while it renders
// them and reads their links, outline and text. Build with solok-build.ts, then use --no-build.
// Options: --iterations <n> (default 300), --seed <n> (default 1). Crashing and hanging inputs
// are kept in tests/tmp/pdfium-fuzz/findings/; rerun one with --file <path>.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, ROOT, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

// a request taking longer than this is a hang
const kRequestTimeoutMs = 20000;
const kCorpus = [".work/corpus/attention-1706.03762v7.pdf", ".work/corpus/independent/bert-1810.04805.pdf"];

const kNumbers = [
  "-1",
  "0",
  "1",
  "2147483647",
  "2147483648",
  "-2147483649",
  "1e30",
  "-1e30",
  "0.0000001",
  "99999999999999999999",
];
const kNames = [
  "/XYZ",
  "/Fit",
  "/FitR",
  "/FitH",
  "/FitBH",
  "/GoTo",
  "/GoToR",
  "/URI",
  "/Launch",
  "/Named",
  "/Dest",
  "/D",
  "/First",
  "/Last",
  "/Next",
  "/Prev",
  "/Parent",
  "/Count",
  "/Kids",
  "/Nums",
  "/Names",
  "/S",
  "/St",
  "/P",
  "/Rotate",
  "/CropBox",
  "/MediaBox",
  "/Annots",
  "/Rect",
  "/Type",
  "/Page",
  "/Pages",
];

// xorshift32: the same seed gives the same inputs
class Rng {
  constructor(private state: number) {
    if (this.state === 0) this.state = 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  int(n: number): number {
    return this.next() % n;
  }
  pick<T>(a: T[]): T {
    return a[this.int(a.length)]!;
  }
}

// Three pages exercising what EnginePdfium wraps: links of every action kind, a nested
// outline with each destination view, named destinations, page labels, an open action,
// page boxes and rotation, rotated text, plain-text URLs and a form field without an appearance.
function richSeed(): string {
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  const text1 =
    "BT /F1 14 Tf 40 700 Td (Needle https://example.com/fuzz and doi 10.1109/X.2015.29) Tj ET " +
    "BT /F1 18 Tf 0.7071 0.7071 -0.7071 0.7071 200 300 Tm (ROTATED) Tj ET";
  const text2 = "BT /F1 12 Tf 60 200 Td (second page mail@example.com) Tj ET";
  const text3 = "BT /F2 12 Tf 60 100 Td (third page) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R /Names << /Dests 16 0 R >> /Dests 17 0 R /PageLabels << /Nums [0 << /S /r >> 1 << /S /D /St 5 /P (A-) >>] >> /OpenAction [4 0 R /XYZ 0 300 null] /AcroForm << /Fields [23 0 R] /NeedAppearances true /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 6 0 R >> >> >> >>",
    "<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R /Annots [12 0 R 13 0 R 14 0 R 15 0 R 18 0 R 19 0 R 23 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /CropBox [20 10 380 290] /Rotate 90 /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /UserUnit 2 /Resources << /Font << /F2 20 0 R >> >> /Contents 21 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream(text1),
    stream(text2),
    "<< /Type /Outlines /First 10 0 R /Last 11 0 R /Count 2 >>",
    "<< /Title (One) /Parent 9 0 R /Next 11 0 R /First 22 0 R /Last 22 0 R /Count 1 /Dest [4 0 R /FitR 10 10 200 100] >>",
    "<< /Title (Two) /Parent 9 0 R /Prev 10 0 R /A << /S /GoTo /D (named) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 650 200 670] /Dest [5 0 R /XYZ null null 2] >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 620 200 640] /A << /S /URI /URI (https://example.com/a) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 590 200 610] /A << /S /GoToR /F (other.pdf) /D [0 /Fit] >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 560 200 580] /A << /S /Launch /F (other.pdf) >> >>",
    "<< /Names [(named) [4 0 R /FitH 100]] >>",
    "<< /old [3 0 R /FitBH 50] >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 530 200 550] /A << /S /Named /N /NextPage >> /Contents (tooltip) >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 500 200 520] /Dest /old >>",
    "<< /Type /Font /Subtype /TrueType /BaseFont /Calibri >>",
    stream(text3),
    "<< /Title (Child) /Parent 10 0 R /Dest [3 0 R /Fit] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (field) /V (form value) /DA (/Helv 12 Tf 0 g) /F 4 /Rect [300 700 500 720] /P 3 0 R /MK << /BC [0 0 0] >> >>",
  ]);
}

function seeds(): { name: string; data: string }[] {
  const list = [{ name: "rich", data: richSeed() }];
  for (const rel of kCorpus) {
    const path = join(ROOT, rel);
    if (existsSync(path)) list.push({ name: rel.split("/").pop()!, data: readFileSync(path, "latin1") });
  }
  return list;
}

// Token-aware edits hit the dictionaries EnginePdfium reads; byte edits hit everything else.
function mutate(data: string, rng: Rng): string {
  const replaceMatch = (re: RegExp, make: (m: string) => string) => {
    const matches = [...data.matchAll(re)];
    if (matches.length === 0) return data;
    const m = rng.pick(matches);
    return data.slice(0, m.index) + make(m[0]) + data.slice(m.index! + m[0].length);
  };
  const n = 1 + rng.int(4);
  for (let i = 0; i < n; i++) {
    const pos = rng.int(Math.max(1, data.length));
    switch (rng.int(8)) {
      case 0:
        data = data.slice(0, pos) + String.fromCharCode(rng.int(256)) + data.slice(pos + 1);
        break;
      case 1:
        data = data.slice(0, pos) + data.slice(pos + 1 + rng.int(64));
        break;
      case 2:
        data = data.slice(0, pos) + data.slice(pos, pos + 1 + rng.int(256)) + data.slice(pos);
        break;
      case 3:
        data = data.slice(0, Math.max(16, pos));
        break;
      case 4:
        data = replaceMatch(/-?\d+(\.\d+)?/g, () => rng.pick(kNumbers));
        break;
      case 5:
        data = replaceMatch(/\/[A-Za-z]+/g, () => rng.pick(kNames));
        break;
      case 6:
        // dangling, self and cyclic references
        data = replaceMatch(/\d+ 0 R/g, () => `${rng.pick([0, 1, 2, 9, 10, 11, 22, 999999, rng.int(30)])} 0 R`);
        break;
      default:
        data = replaceMatch(/\[[^\[\]]*\]/g, () => rng.pick(["[]", "[null]", "[0]", "[/XYZ]", "[(x) 1 2]"]));
        break;
    }
  }
  return data;
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    Bun.sleep(kRequestTimeoutMs).then(() => {
      throw new Error(`hang: ${what} took over ${kRequestTimeoutMs} ms`);
    }),
  ]);
}

// Each request opens its own engine on the file; failing to open or render is fine, dying is not.
// per request kind, how many inputs got far enough to succeed: shows the mutations still reach the code
const gSucceeded = new Map<string, number>();

// The unmutated rich seed must succeed with output, or the harness isn't reaching the code it means to.
async function exercise(client: ControlClient, path: string, isSeed: boolean): Promise<void> {
  const calls: [ControlCommand, (string | number)[], string][] = [
    [ControlCommand.TestRenderViewPrint, [path], "render"],
    [ControlCommand.TestPageLinks, [path, 1], "links p1"],
    [ControlCommand.TestPageLinks, [path, 2], "links p2"],
    [ControlCommand.TestGetToc, [path], "toc"],
    [ControlCommand.TestSearch, [path, "e"], "search"],
  ];
  for (const [cmd, args, what] of calls) {
    const r = await withTimeout(client.request(cmd, args), what);
    if (r[0] === 0) gSucceeded.set(what, (gSucceeded.get(what) ?? 0) + 1);
    if (isSeed && what !== "links p2" && (r[0] !== 0 || String(r[1] ?? "").trim() === "")) {
      throw new Error(`seed ${what} failed: ${r[0]} ${String(r[1] ?? "").trim()}`);
    }
  }
}

type Session = Awaited<ReturnType<typeof launchControlled>>;

async function launch(dir: string): Promise<Session> {
  return await launchControlled(["-appdata", dir]);
}

export async function testit(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: false,
    options: { iterations: { type: "string" }, seed: { type: "string" }, file: { type: "string" } },
  });
  const iterations = Number(values.iterations ?? 300);
  const seed = Number(values.seed ?? 1);
  const dir = tmpPath("pdfium-fuzz");
  const findingsDir = join(dir, "findings");
  rmSync(join(dir, "inputs"), { recursive: true, force: true });
  mkdirSync(join(dir, "inputs"), { recursive: true });
  mkdirSync(findingsDir, { recursive: true });

  const rng = new Rng(seed);
  const base = seeds();
  const inputs: string[] = [];
  if (typeof values.file === "string") {
    inputs.push(values.file);
  } else {
    for (let i = 0; i < iterations; i++) {
      const s = base[i % base.length]!;
      const path = join(dir, "inputs", `${String(i).padStart(4, "0")}-${s.name.replace(/\.pdf$/, "")}.pdf`);
      writeFileSync(path, i < base.length ? s.data : mutate(s.data, rng), "latin1");
      inputs.push(path);
    }
  }

  const findings: string[] = [];
  let session = await launch(dir);
  try {
    for (const [i, path] of inputs.entries()) {
      try {
        await exercise(session.client, path, typeof values.file !== "string" && i === 0);
      } catch (e) {
        const kept = join(findingsDir, `seed${seed}-${path.split(/[\\/]/).pop()}`);
        copyFileSync(path, kept);
        findings.push(`${kept}: ${(e as Error).message}`);
        console.log(`FINDING ${kept}: ${(e as Error).message}`);
        session.client.close();
        await killAndWait(session.proc);
        session = await launch(dir);
      }
      if ((i + 1) % 50 === 0) console.log(`${i + 1}/${inputs.length} inputs, ${findings.length} findings`);
    }
    await session.client.quit();
  } finally {
    session.client.close();
    await killAndWait(session.proc).catch(() => {});
  }
  const ok = [...gSucceeded].map(([what, n]) => `${what} ${n}`).join(", ");
  console.log(`${inputs.length} inputs (seed ${seed}), ${findings.length} findings; succeeded: ${ok}`);
  if (findings.length > 0) throw new Error(`crashes or hangs:\n${findings.join("\n")}`);
}

if (import.meta.main) await runStandalone(testit);
