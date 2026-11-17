// E102: crash dumps are written out of process, so a thread parked inside the
// loader can't hang them. A whole-process crash (CrashMe) with such a thread
// still exits with a .dmp holding the exception and comment streams; a voice
// engine crash that ends only its thread writes one too and the app keeps running.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { ControlClient, ControlCommand, uniquePipeName } from "./control.ts";
import { drainProcStderr, EXE, IS_ASAN, pollUntil, runStandalone, SLOW_BUILD_FACTOR } from "./util.ts";
import { killAndWait } from "./win-automation.ts";
import { testWindowPos } from "./winapi.ts";

const kMdmpSignature = 0x504d444d; // "MDMP"
const kExceptionStream = 6;
const kCommentStreamA = 10;
const kAccessViolation = 0xc0000005;
const kCrashExitCode = 1;
const kExitTimeoutMs = 20_000 * SLOW_BUILD_FACTOR;

type Dump = { exceptionCode: number; exceptionThread: number; comment: string };

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

function checkDump(path: string, commentPart: string): void {
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
  if (!d.comment.includes(commentPart)) {
    throw new Error(`crash-dump-helper: ${path}: comment lacks '${commentPart}'`);
  }
}

async function launch(): Promise<{ proc: Bun.Subprocess; client: ControlClient; stderr: Promise<string> }> {
  const pipe = uniquePipeName();
  const p = testWindowPos();
  const args = [EXE, "-for-testing", "-window-pos", `${p.dx}x${p.dy}@${p.x}x${p.y}`, "-dbg-control", pipe];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const stderr = drainProcStderr(proc.stderr);
  const client = await ControlClient.connect(pipe);
  return { proc, client, stderr };
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
    const res = await client.request(ControlCommand.TestParkInLoader);
    if (res[0] !== 0) {
      throw new Error(`crash-dump-helper: TestParkInLoader: ${res[1]}`);
    }
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
  await endCrashedEngineThread();
}

if (import.meta.main) {
  await runStandalone(testit);
}
