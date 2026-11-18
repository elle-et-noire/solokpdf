// E102: crash dumps are written out of process, so a thread parked inside the
// loader can't hang them. A whole-process crash (CrashMe) with such a thread
// still exits with a .dmp holding the exception and comment streams; a voice
// engine crash that ends only its thread writes one too and the app keeps running.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dlopen, ptr } from "bun:ffi";
import { ControlClient, ControlCommand, uniquePipeName } from "./control.ts";
import { drainProcStderr, EXE, IS_ASAN, pollUntil, runStandalone, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";
import { killAndWait } from "./win-automation.ts";
import { testWindowPos } from "./winapi.ts";

const kMdmpSignature = 0x504d444d; // "MDMP"
const kThreadListStream = 3;
const kExceptionStream = 6;
const kSystemInfoStream = 7;
const kCommentStreamA = 10;
const kAccessViolation = 0xc0000005;
const kCrashExitCode = 1;
const kExitTimeoutMs = 20_000 * SLOW_BUILD_FACTOR;

type Dump = { exceptionCode: number; exceptionThread: number; comment: string };

function checkFallbackContext(b: Buffer): void {
  const dbghelp = dlopen("dbghelp.dll", {
    MiniDumpReadDumpStream: { args: ["ptr", "u32", "ptr", "ptr", "ptr"], returns: "bool" },
  });
  try {
    const address = ptr(b);
    const stream = (type: number): Buffer => {
      const data = new BigUint64Array(1);
      const size = new Uint32Array(1);
      if (!dbghelp.symbols.MiniDumpReadDumpStream(address, type, null, ptr(data), ptr(size))) {
        throw new Error(`DbgHelp could not read minidump stream ${type}`);
      }
      const start = Number(data[0]) - address;
      if (start < 0 || start + size[0]! > b.length) throw new Error(`minidump stream ${type} exceeds file`);
      return b.subarray(start, start + size[0]!);
    };
    const exception = stream(kExceptionStream);
    const thread = stream(kThreadListStream);
    const arch = stream(kSystemInfoStream).readUInt16LE(0);
    const addressAtFault = exception.readBigUInt64LE(24);
    const contextSize = exception.readUInt32LE(160);
    const contextRva = exception.readUInt32LE(164);
    if (contextRva + contextSize > b.length) throw new Error("fallback context exceeds file");
    const context = b.subarray(contextRva, contextRva + contextSize);
    // Instruction pointer fields in the Windows SDK CONTEXT layouts.
    const offsets: Record<number, number> = { 0: 184, 9: 248, 12: 264 }; // x86, x64, arm64
    const pcOffset = offsets[arch];
    if (pcOffset === undefined) throw new Error(`unknown minidump architecture ${arch}`);
    const pc = arch === 0 ? BigInt(context.readUInt32LE(pcOffset)) : context.readBigUInt64LE(pcOffset);
    if (
      thread.readUInt32LE(0) !== 1 ||
      thread.readUInt32LE(4) !== exception.readUInt32LE(0) ||
      exception.readBigUInt64LE(40) !== 1n || // write
      exception.readBigUInt64LE(48) !== 0n || // null address
      addressAtFault === 0n ||
      pc !== addressAtFault
    ) {
      throw new Error("fallback dump has an inconsistent fault address, thread or CPU context");
    }
  } finally {
    dbghelp.close();
  }
}

function readDump(path: string): Dump {
  const b = readFileSync(path);
  if (b.readUInt32LE(0) !== kMdmpSignature) {
    throw new Error(`${path}: not a minidump`);
  }
  const nStreams = b.readUInt32LE(8);
  const dirRva = b.readUInt32LE(12);
  const res: Dump = { exceptionCode: 0, exceptionThread: 0, comment: "" };
  for (let i = 0; i < nStreams; i++) {
    const e = dirRva + i * 12;
    const type = b.readUInt32LE(e);
    const size = b.readUInt32LE(e + 4);
    const rva = b.readUInt32LE(e + 8);
    if (type === kExceptionStream) {
      res.exceptionThread = b.readUInt32LE(rva);
      res.exceptionCode = b.readUInt32LE(rva + 8);
    } else if (type === kCommentStreamA) {
      res.comment = b.subarray(rva, rva + size).toString("latin1");
    }
  }
  return res;
}

// "Minidump: <path>" from the report the crash handler writes to stderr
function dumpPathsIn(stderr: string): string[] {
  return [...stderr.matchAll(/^Minidump: (.+?)\r?$/gm)].map((m) => m[1]!);
}

function checkDump(path: string, commentPart?: string): Dump {
  if (!existsSync(path)) {
    throw new Error(`crash-dump-helper: no dump at ${path}`);
  }
  const d = readDump(path);
  rmSync(path, { force: true });
  if (d.exceptionCode !== kAccessViolation || !d.exceptionThread) {
    throw new Error(
      `crash-dump-helper: ${path}: exception 0x${d.exceptionCode.toString(16)} thread ${d.exceptionThread}`,
    );
  }
  if (commentPart && !d.comment.includes(commentPart)) {
    throw new Error(`crash-dump-helper: ${path}: comment lacks '${commentPart}'`);
  }
  return d;
}

async function launch(testMode?: string, appdata?: string) {
  const pipe = uniquePipeName();
  const p = testWindowPos();
  const args = [EXE, "-for-testing", "-window-pos", `${p.dx}x${p.dy}@${p.x}x${p.y}`, "-dbg-control", pipe];
  if (appdata) args.push("-appdata", appdata);
  const env = { ...process.env, SOLOKPDF_TEST_CRASH_HANDLER: testMode, SOLOKPDF_TEST_CRASH_DIR: appdata };
  const proc = Bun.spawn(args, { env, stdout: "ignore", stderr: "pipe" });
  const stderr = drainProcStderr(proc.stderr);
  const client = await ControlClient.connect(pipe);
  return { proc, client, stderr };
}

async function crashWithUnavailableDiagnostics(mode: "report-stop" | "heap-lock" | "no-helper", parkLoader = false) {
  const appdata = mkdtempSync(tmpPath(`crash-dump-helper-${mode}-`));
  const { proc, client } = await launch(mode, appdata);
  try {
    if (mode === "heap-lock") {
      void client.request(ControlCommand.TestCrashHandler, ["heap-lock"]).catch(() => {});
    } else {
      if (parkLoader) await parkInLoader(client);
      client.crashMe();
    }
    const code = await exitCodeWithin(proc, kExitTimeoutMs);
    if (code !== kCrashExitCode) throw new Error(`crash-dump-helper: ${mode}: expected exit 1, got ${code}`);
    const paths = [...new Bun.Glob("**/*.dmp").scanSync(appdata)];
    if (paths.length !== 1) throw new Error(`crash-dump-helper: ${mode}: expected one dump, got ${paths.length}`);
    const path = join(appdata, paths[0]!);
    if (mode === "no-helper") checkFallbackContext(readFileSync(path));
    const dump = checkDump(path);
    if (mode !== "no-helper" && dump.comment) throw new Error(`${mode}: the report did not stop`);
  } finally {
    client.close();
    await killAndWait(proc);
    rmSync(appdata, { recursive: true, force: true });
  }
}

async function parkInLoader(client: ControlClient) {
  const res = await client.request(ControlCommand.TestParkInLoader);
  if (res[0] !== 0) throw new Error(`crash-dump-helper: TestParkInLoader: ${res[1]}`);
}

async function checkCrashControl(client: ControlClient, action: string) {
  const res = await client.request(ControlCommand.TestCrashHandler, [action]);
  if (res[0] !== 0) throw new Error(`crash-dump-helper: ${action}: ${res[1]}`);
}

async function exitCodeWithin(proc: Bun.Subprocess, ms: number): Promise<number | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const res = await Promise.race([
    proc.exited,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
  clearTimeout(timer);
  return res;
}

async function crashWithLoaderParked(): Promise<void> {
  const { proc, client, stderr } = await launch();
  try {
    await checkCrashControl(client, "private-handles");
    await parkInLoader(client);
    client.crashMe();
    const code = await exitCodeWithin(proc, kExitTimeoutMs);
    if (code === "timeout") {
      throw new Error(`crash-dump-helper: a crash with a thread parked in the loader hung (${kExitTimeoutMs} ms)`);
    }
    if (code !== kCrashExitCode) {
      throw new Error(`crash-dump-helper: crash exit code ${code}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
  const paths = dumpPathsIn(await stderr);
  if (paths.length !== 1) {
    throw new Error(`crash-dump-helper: expected one Minidump: line, got ${paths.length}`);
  }
  checkDump(paths[0]!, "Type: crash (minidump)");
}

async function restoreExceptionFilter() {
  const { proc, client } = await launch();
  try {
    await checkCrashControl(client, "restore-filter");
    await client.quit();
    const code = await exitCodeWithin(proc, kExitTimeoutMs);
    if (code !== 0) throw new Error(`crash-dump-helper: after uninstall, exit ${code}`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testHelperWatchdog() {
  const appdata = mkdtempSync(tmpPath("crash-dump-helper-stop-"));
  const { proc, client } = await launch("helper-stop", appdata);
  try {
    client.crashMe();
    await pollUntil(
      () => [...new Bun.Glob("*.suspended").scanSync(appdata)].length,
      (n) => n === 1,
      { timeoutMs: 5000, error: "the helper did not suspend the faulting thread" },
    );
    const code = await exitCodeWithin(proc, kExitTimeoutMs);
    if (code !== kCrashExitCode) throw new Error(`stopped helper: expected exit 1, got ${code}`);
  } finally {
    client.close();
    await killAndWait(proc);
    rmSync(appdata, { recursive: true, force: true });
  }
}

async function endCrashedEngineThread(): Promise<void> {
  const { proc, client, stderr } = await launch();
  try {
    await client.request(ControlCommand.TestTtsEngineCrash, ["crash"]);
    await pollUntil(
      async () => String((await client.request(ControlCommand.TestTtsEngineCrash, ["state"]))[1] ?? ""),
      (s) => s === "crashed=1 voice=''",
      { timeoutMs: 10_000 * SLOW_BUILD_FACTOR, error: (s) => `crash-dump-helper: engine crash state ${s}` },
    );
    await client.quit();
    const code = await exitCodeWithin(proc, kExitTimeoutMs);
    if (code !== 0) {
      throw new Error(`crash-dump-helper: after an ended engine thread, exit ${code}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
  const paths = dumpPathsIn(await stderr);
  if (paths.length !== 1) {
    throw new Error(`crash-dump-helper: expected one Minidump: line, got ${paths.length}`);
  }
  checkDump(paths[0]!, "crashed thread ended");
}

export async function testit(): Promise<void> {
  // ASan builds install no crash handler
  if (IS_ASAN) {
    console.log("crash-dump-helper: skipped, ASan builds have no crash handler");
    return;
  }
  await crashWithLoaderParked();
  await crashWithUnavailableDiagnostics("report-stop");
  await crashWithUnavailableDiagnostics("heap-lock");
  await crashWithUnavailableDiagnostics("no-helper");
  await crashWithUnavailableDiagnostics("no-helper", true);
  await endCrashedEngineThread();
  await restoreExceptionFilter();
  await testHelperWatchdog();
}

if (import.meta.main) {
  await runStandalone(testit);
}
