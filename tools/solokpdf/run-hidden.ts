import { mkdtempSync, openSync, readSync, rmSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

const DESKTOP_NAME = "SolokPDFTests";
const DESKTOP_PATH = `WinSta0\\${DESKTOP_NAME}`;
const DESKTOP_ALL_ACCESS = 0x01ff;
const CREATE_SUSPENDED = 0x00000004;
const CREATE_NO_WINDOW = 0x08000000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESTDHANDLES = 0x00000100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const user32 = dlopen("user32.dll", {
  CreateDesktopW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.u64,
  },
  OpenDesktopW: { args: [FFIType.ptr, FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
  CloseDesktop: { args: [FFIType.u64], returns: FFIType.bool },
});
const kernel32 = dlopen("kernel32.dll", {
  CreateFileW: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
    returns: FFIType.u64,
  },
  CreateProcessW: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.bool,
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.bool,
  },
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
  SetInformationJobObject: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
  AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
  ResumeThread: { args: [FFIType.u64], returns: FFIType.u32 },
  GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
  WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.bool },
  TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
});

function wide(value: string): Uint16Array {
  return Uint16Array.from({ length: value.length + 1 }, (_, i) => value.charCodeAt(i) || 0);
}

function quote(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/\\+$/g, (slashes) => slashes + slashes)}"`;
}

function check(ok: number | bigint, name: string): void {
  if (!ok || ok === INVALID_HANDLE_VALUE) throw new Error(`${name} failed: ${kernel32.symbols.GetLastError()}`);
}

function outputFile(path: string): bigint {
  const sa = new Uint8Array(24);
  const view = new DataView(sa.buffer);
  view.setUint32(0, sa.length, true);
  view.setUint32(16, 1, true);
  const handle = kernel32.symbols.CreateFileW(ptr(wide(path)), 0x40000000, 0x00000007, ptr(sa), 2, 0x80, 0);
  check(handle, `CreateFileW(${path})`);
  return BigInt(handle);
}

function relay(path: string, state: { fd: number; offset: number }, stream: NodeJS.WriteStream): void {
  if (state.fd < 0) state.fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const count = readSync(state.fd, chunk, 0, chunk.length, state.offset);
    if (!count) break;
    state.offset += count;
    stream.write(chunk.subarray(0, count));
  }
}

async function main(): Promise<number> {
  if (process.platform !== "win32") throw new Error("Windows only");
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const commandAt = separator >= 0 ? separator + 1 : argv.findIndex((arg) => !arg.startsWith("--timeout-ms="));
  if (commandAt < 0 || !argv[commandAt]) {
    console.error("usage: bun tools/solokpdf/run-hidden.ts [--timeout-ms=N] -- command [args...]");
    return 2;
  }
  const timeoutArg = argv.slice(0, commandAt).find((arg) => arg.startsWith("--timeout-ms="));
  const timeout = timeoutArg ? Number(timeoutArg.slice("--timeout-ms=".length)) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("invalid timeout");
  const args = argv.slice(commandAt);
  const exe = args[0]!.toLowerCase() === "bun" ? process.execPath : (Bun.which(args[0]!) ?? resolve(args[0]!));
  const cmdline = wide([exe, ...args.slice(1)].map(quote).join(" "));
  const desktopName = wide(DESKTOP_NAME);
  let desktop = BigInt(user32.symbols.CreateDesktopW(ptr(desktopName), null, null, 0, DESKTOP_ALL_ACCESS, null));
  if (!desktop) desktop = BigInt(user32.symbols.OpenDesktopW(ptr(desktopName), 0, false, DESKTOP_ALL_ACCESS));
  check(desktop, "CreateDesktopW/OpenDesktopW");

  const dir = mkdtempSync(join(tmpdir(), "solok-hidden-"));
  const stdoutPath = join(dir, "stdout.txt");
  const stderrPath = join(dir, "stderr.txt");
  let stdin = 0n;
  let stdout = 0n;
  let stderr = 0n;
  let job = 0n;
  let proc = 0n;
  let thread = 0n;
  const outState = { fd: -1, offset: 0 };
  const errState = { fd: -1, offset: 0 };
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    if (job) kernel32.symbols.TerminateJobObject(job, 1);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const sa = new Uint8Array(24);
    new DataView(sa.buffer).setUint32(0, sa.length, true);
    new DataView(sa.buffer).setUint32(16, 1, true);
    stdin = BigInt(kernel32.symbols.CreateFileW(ptr(wide("NUL")), 0x80000000, 0x00000007, ptr(sa), 3, 0x80, 0));
    check(stdin, "CreateFileW(NUL)");
    stdout = outputFile(stdoutPath);
    stderr = outputFile(stderrPath);

    job = BigInt(kernel32.symbols.CreateJobObjectW(null, null));
    check(job, "CreateJobObjectW");
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    check(
      kernel32.symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limits), limits.length),
      "SetInformationJobObject",
    );

    const si = new Uint8Array(104);
    const siView = new DataView(si.buffer);
    siView.setUint32(0, si.length, true);
    const desktopPath = wide(DESKTOP_PATH);
    siView.setBigUint64(16, BigInt(ptr(desktopPath)), true);
    siView.setUint32(60, STARTF_USESTDHANDLES, true);
    siView.setBigUint64(80, stdin, true);
    siView.setBigUint64(88, stdout, true);
    siView.setBigUint64(96, stderr, true);
    const pi = new Uint8Array(24);
    const cwd = wide(process.cwd());
    const env = wide(
      Object.entries({ ...process.env, SOLOKPDF_HIDDEN_DESKTOP: DESKTOP_NAME })
        .map(([key, value]) => `${key}=${value}`)
        .join("\0") + "\0",
    );
    check(
      kernel32.symbols.CreateProcessW(
        ptr(wide(exe)),
        ptr(cmdline),
        null,
        null,
        true,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        ptr(env),
        ptr(cwd),
        ptr(si),
        ptr(pi),
      ),
      "CreateProcessW",
    );
    const piView = new DataView(pi.buffer);
    proc = piView.getBigUint64(0, true);
    thread = piView.getBigUint64(8, true);
    try {
      check(kernel32.symbols.AssignProcessToJobObject(job, proc), "AssignProcessToJobObject");
    } catch (error) {
      kernel32.symbols.TerminateProcess(proc, 1);
      throw error;
    }
    if (kernel32.symbols.ResumeThread(thread) === 0xffffffff) throw new Error("ResumeThread failed");
    kernel32.symbols.CloseHandle(thread);
    thread = 0n;
    kernel32.symbols.CloseHandle(stdin);
    stdin = 0n;
    kernel32.symbols.CloseHandle(stdout);
    stdout = 0n;
    kernel32.symbols.CloseHandle(stderr);
    stderr = 0n;

    const exitCode = new Uint32Array(1);
    const deadline = Date.now() + timeout;
    while (!interrupted) {
      relay(stdoutPath, outState, process.stdout);
      relay(stderrPath, errState, process.stderr);
      const wait = kernel32.symbols.WaitForSingleObject(proc, 0);
      if (wait === WAIT_OBJECT_0) {
        check(kernel32.symbols.GetExitCodeProcess(proc, ptr(exitCode)), "GetExitCodeProcess");
        break;
      }
      if (wait !== WAIT_TIMEOUT) throw new Error(`WaitForSingleObject failed: ${kernel32.symbols.GetLastError()}`);
      if (Date.now() >= deadline) {
        console.error(`hidden test timed out after ${timeout} ms`);
        stop();
        break;
      }
      await Bun.sleep(100);
    }
    relay(stdoutPath, outState, process.stdout);
    relay(stderrPath, errState, process.stderr);
    return interrupted ? 124 : exitCode[0]!;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (thread) kernel32.symbols.CloseHandle(thread);
    if (job) kernel32.symbols.CloseHandle(job);
    if (proc) kernel32.symbols.CloseHandle(proc);
    if (stdin) kernel32.symbols.CloseHandle(stdin);
    if (stdout) kernel32.symbols.CloseHandle(stdout);
    if (stderr) kernel32.symbols.CloseHandle(stderr);
    if (desktop) user32.symbols.CloseDesktop(desktop);
    if (outState.fd >= 0) closeSync(outState.fd);
    if (errState.fd >= 0) closeSync(errState.fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
