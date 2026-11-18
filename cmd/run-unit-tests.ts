import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asanBuildJobs, asanDllName, asanMsbuildArgs, findAsanDll } from "./helper/asan-runtime";
import { detectVisualStudio2026, runLogged } from "./util";

type BuildKind = "dbg" | "dbg32" | "asan";

function usage(): never {
  throw new Error("usage: bun cmd/run-unit-tests.ts [-solok] [-dbg | -32 | -asan]");
}

function parseArgs(): { kind: BuildKind; solok: boolean } {
  let kind: BuildKind | undefined;
  let solok = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "-solok") {
      if (solok) usage();
      solok = true;
      continue;
    }
    if (kind) usage();
    if (arg === "-dbg") kind = "dbg";
    else if (arg === "-32") kind = "dbg32";
    else if (arg === "-asan") kind = "asan";
    else usage();
  }
  return { kind: kind ?? "dbg", solok };
}

function copyAsanRuntime(vsRoot: string, outDir: string): void {
  const src = findAsanDll(vsRoot, process.env.SUMATRA_ASAN_TOOLS);
  console.log(`ASan runtime: ${src}`);
  const dst = join(outDir, asanDllName);
  copyFileSync(src, dst);
}

interface UnitTestConfig {
  platform: string;
  target: string;
  exeName: string;
  outDir: string;
  logName: string;
}

// unit tests are compiled into SumatraPDF only in Debug builds, so every
// config here is Debug
function configFor(kind: BuildKind): UnitTestConfig {
  if (kind === "dbg32") {
    return {
      platform: "Win32",
      target: "SumatraPDF",
      exeName: "SumatraPDF.exe",
      outDir: join("out", "dbg32"),
      logName: "unit-tests-dbg32.txt",
    };
  }
  if (kind === "asan") {
    return {
      platform: "x64_asan",
      target: "SumatraPDF-static",
      exeName: "SumatraPDF-static.exe",
      outDir: join("out", "dbg64_asan"),
      logName: "unit-tests-asan.txt",
    };
  }
  return {
    platform: "x64",
    target: "SumatraPDF",
    exeName: "SumatraPDF.exe",
    outDir: join("out", "dbg64"),
    logName: "unit-tests-dbg.txt",
  };
}

function tail(s: string, maxLines: number): string {
  const lines = s.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

async function runAndCapture(
  args: string[],
  cwd: string,
  logPath: string,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stdout + stderr;
  writeFileSync(logPath, output);
  return { exitCode, output };
}

async function buildUpstream(kind: BuildKind, { platform, target, outDir }: UnitTestConfig): Promise<void> {
  const toolsDir = kind === "asan" ? process.env.SUMATRA_ASAN_TOOLS : undefined;
  const toolArgs = asanMsbuildArgs(toolsDir);
  const { msbuildPath, vsRoot } = detectVisualStudio2026(toolsDir);

  const { genDocsForBuild } = await import("./gen-docs");
  await genDocsForBuild();
  const solokSolution = process.env.SUMATRA_SLN;
  await runLogged(join("bin", "premake5.exe"), solokSolution ? ["--with-pdfium", "vs2026"] : ["vs2022"]);
  await runLogged(msbuildPath, [
    solokSolution ?? String.raw`vs2022\SumatraPDF.sln`,
    `/t:${target}`,
    `/p:Configuration=Debug;Platform=${platform}`,
    ...toolArgs,
    kind === "asan" ? `/m:${asanBuildJobs}` : "/m",
  ]);
  if (kind === "asan") {
    copyAsanRuntime(vsRoot, outDir);
  }
}

async function main() {
  const { kind, solok } = parseArgs();
  const config = configFor(kind);
  const { exeName, outDir, logName } = config;
  if (solok) {
    if (kind === "dbg32") throw new Error("SolokPDF pins an x64 PDFium build. Use -dbg or -asan with -solok.");
    if (!process.env.SOLOKPDF_HIDDEN_DESKTOP) {
      throw new Error("Run local SolokPDF unit tests through tools/solokpdf/run-hidden.ts.");
    }
    await runLogged(process.execPath, ["cmd/solok-build.ts", kind === "asan" ? "-asan" : "-dbg"]);
  } else {
    await buildUpstream(kind, config);
  }

  mkdirSync(outDir, { recursive: true });
  const exe = join(process.cwd(), outDir, exeName);
  const logPath = join(process.cwd(), outDir, logName);
  const args = [exe, "-unit-tests", "-for-ai"];
  if (solok) args.push("-for-testing");
  const { exitCode, output } = await runAndCapture(args, outDir, logPath);

  console.log(`${exeName} -unit-tests exit code: ${exitCode}`);
  console.log(`output: ${logPath}`);
  if (exitCode === 0 && output.includes("Passed all ")) {
    console.log("unit tests passed");
    return;
  }
  if (exitCode === 7 || output.includes("unit tests crash") || output.includes("AddressSanitizer")) {
    console.log("unit tests crashed");
  } else if (output.includes("Assertion failed:") || output.includes("Failed ")) {
    console.log("unit tests failed assertions");
  } else {
    console.log("unit tests failed");
  }
  console.log("--- tail ---");
  console.log(tail(output, 80));
  process.exit(exitCode || 1);
}

await main();
