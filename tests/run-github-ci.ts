// The suite the daily GitHub Actions job runs (.github/workflows/windows-daily.yml).
//
// Two things make it different from run-all.ts:
//
//  - it does not stop at the first failure. A daily run is only useful if it
//    tells us everything that broke, so every test runs and the failures are
//    listed at the end (and the process exits non-zero, so the run is marked
//    failed and we get notified).
//  - the app window covers the whole work area instead of half of it. A
//    hosted runner's screen is small and nobody is looking at it, so there is
//    nothing to stay out of the way of, and tests get room for toolbars,
//    sidebars and dialogs.
//
// It does not build: the workflow builds (debug ASan) and points
// SUMATRA_TEST_EXE at the resulting exe.
//
// Run:  bun tests/run-github-ci.ts [test-name ...]
//
// Naming tests (on the command line, or through the workflow's "tests" input)
// runs only those, which is how a single CI failure is iterated on without
// waiting for the whole suite.

import { existsSync } from "node:fs";
import { runInJob } from "../tools/solokpdf/run-job.ts";
import { EXE, formatDuration, resetTestTimes, runTest, type NamedTest } from "./util.ts";
import { getWorkArea, setTestWindowLayout, testWindowPos } from "./winapi.ts";
import { tests as allTests } from "./run-all.ts";

// Tests that need something a hosted runner doesn't have. Keep the reason with
// the name: it is what tells the next person whether it is still true.
export const excludedTests: Record<string, string> = {
  // "Microsoft Print to PDF" is a Windows client feature; the runner images are
  // Windows Server and don't have it (nor any other printer)
  "issue-4967": "prints through Microsoft Print to PDF",
  "issue-5065": "prints through Microsoft Print to PDF",
  "issue-5353": "prints through Microsoft Print to PDF",
  "print-auto-rotate": "prints through Microsoft Print to PDF",
  "issue-6150": "prints through Microsoft Print to PDF",
  "issue-6323": "opens the system printer dialog and needs an installed printer",
  // a TeX distribution is a big install we don't want on the runner; the LaTeX
  // suite itself (tests/latex.ts) is only in run-pre-release, not here
  "issue-5040": "needs pdflatex (MiKTeX / TeX Live)",
  // agents.md flags this one as focus-dependent even on a developer machine;
  // on a runner nothing has focus. Re-enable if it turns out to be fine.
  // (issue-1136 was the other one; it now waits on the home page's own state
  // over -dbg-control instead of on focus, so it runs here.)
  "issue-2254": "depends on keyboard focus, flaky without an interactive desktop",
  "issue-6279": "drives the system Save dialog on an administrative share, untried on a runner",
  // the daily job builds SumatraPDF-static.exe, which embeds no installer payload
  "issue-6025": "installer UI needs the embedded libsumatrapdf.dll, which the static CI exe does not have",
};

// MuPDF features PDFium tabs lack by design (backlog B21, B27)
const pdfiumExcludedTests: Record<string, string> = {
  "issue-5937": "Engineering Drawing Enhancement is hidden on PDFium tabs",
  "issue-6361": "raster CAD detection needs the MuPDF enhance pass",
  "issue-3731": "PDFium has no external-stream image loader",
};

function excludeReason(name: string): string | undefined {
  return excludedTests[name] ?? (process.env.SOLOKPDF_ENGINE === "mupdf" ? undefined : pdfiumExcludedTests[name]);
}

export function ciTests(): NamedTest[] {
  return allTests.filter(([name]) => !excludeReason(name));
}

const kTestTimeoutMs = 5 * 60 * 1000;
const kProcessExitGraceMs = 250;
// WebView2, the Windows print thunk and the MSVC PDB server can outlive their callers.
const backgroundImages = new Set(["msedgewebview2.exe", "splwow64.exe", "mspdbsrv.exe"]);

const enum WorkerExit {
  Passed = 0,
  Failed = 1,
  Skipped = 3,
  Partial = 4,
}

export async function runCiWorker([name, fn]: NamedTest): Promise<number> {
  setTestWindowLayout("workArea");
  const skip = await runTest(name, fn);
  if (skip) return skip.scope === "all" ? WorkerExit.Skipped : WorkerExit.Partial;
  return WorkerExit.Passed;
}

type CiJob = { name: string; command: string[] };

export async function runCiJobs(jobs: CiJob[], timeoutMs = kTestTimeoutMs) {
  const counts = { passed: 0, partial: 0, skipped: 0, failures: [] as string[] };
  for (const { name, command } of jobs) {
    console.log(`\n========== ${name} ==========`);
    const result = await runInJob(command, { timeoutMs, exitGraceMs: kProcessExitGraceMs });
    if (result.interrupted) throw new Error("CI test run interrupted");
    const background = [];
    const leaks = [];
    for (const { image, pid } of result.remaining) {
      const label = `${image ?? "unknown"} (${pid})`;
      if (image && backgroundImages.has(image.toLowerCase())) background.push(label);
      else leaks.push(label);
    }
    if (background.length) console.log(`${name}: cleaned up background processes: ${background.join(", ")}`);
    if (result.timedOut) {
      console.error(`❌ ${name} timed out after ${formatDuration(timeoutMs)}`);
    } else if (leaks.length) {
      console.error(`❌ ${name} left processes running: ${leaks.join(", ")} (worker exit ${result.exitCode})`);
    } else if (result.exitCode === WorkerExit.Passed) {
      counts.passed++;
      continue;
    } else if (result.exitCode === WorkerExit.Skipped) {
      counts.skipped++;
      continue;
    } else if (result.exitCode === WorkerExit.Partial) {
      counts.partial++;
      continue;
    } else {
      console.error(`❌ ${name} worker exited with code ${result.exitCode}`);
    }
    counts.failures.push(name);
  }
  return counts;
}

async function testit(requested?: NamedTest[]): Promise<void> {
  const tests = requested ?? ciTests();
  setTestWindowLayout("workArea");
  resetTestTimes();

  const wa = getWorkArea();
  const pos = testWindowPos();
  console.log(`exe:       ${EXE}`);
  console.log(`work area: ${wa.right - wa.left}x${wa.bottom - wa.top}`);
  console.log(`window:    ${pos.dx}x${pos.dy} at ${pos.x},${pos.y}`);
  if (!existsSync(EXE)) {
    throw new Error(`${EXE} doesn't exist: build it first (bun cmd/build.ts -asan -dbg)`);
  }

  const excluded = requested ? [] : allTests.filter(([name]) => excludeReason(name));
  console.log(`running ${tests.length} tests, ${excluded.length} excluded before execution`);
  for (const [name] of excluded) {
    console.log(`  ${name}: ${excludeReason(name)}`);
  }

  const t0 = performance.now();
  const forwarded = process.argv.slice(2).filter((arg) => arg.startsWith("-"));
  const jobs = tests.map(([name]) => ({
    name,
    command: [process.execPath, import.meta.path, "--ci-worker", name, ...forwarded],
  }));
  const { passed, partial, skipped, failures } = await runCiJobs(jobs);
  const elapsed = formatDuration(performance.now() - t0);
  console.log(
    `\nrun-github-ci: ${passed} passed, ${partial} partial, ${skipped} skipped, ${failures.length} failed, ${excluded.length} excluded in ${elapsed}`,
  );
  if (failures.length) {
    throw new Error(`${failures.length} test(s) failed: ${failures.join(", ")}`);
  }
}

function namedTest(name: string): NamedTest {
  const test = allTests.find(([testName]) => testName === name);
  if (!test) throw new Error(`no test named '${name}' (it must be registered in run-all.ts)`);
  return test;
}

// names given on the command line, if any: "issue-1195" or "issue-1195,issue-906"
function testsFromArgs(argv: string[]): NamedTest[] | undefined {
  const names = argv
    .slice(2)
    .flatMap((a) => a.split(","))
    .map((a) => a.trim())
    .filter((a) => a && !a.startsWith("-"));
  if (names.length === 0) {
    return undefined;
  }
  return names.map(namedTest);
}

if (import.meta.main) {
  let exitCode: number;
  try {
    if (process.argv[2] === "--ci-worker") {
      // Exit after the test's own cleanup even if its event loop has leftover handles.
      exitCode = await runCiWorker(namedTest(process.argv[3]!));
    } else {
      await testit(testsFromArgs(process.argv));
      exitCode = WorkerExit.Passed;
    }
  } catch (e) {
    console.error(`\n${(e as Error)?.message ?? e}`);
    exitCode = WorkerExit.Failed;
  }
  process.exit(exitCode);
}
