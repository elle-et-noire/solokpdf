import { mkdtempSync, openSync, readSync, rmSync, closeSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

const ERROR_MODE = 0x0001 | 0x0002 | 0x8000;
const CREATE_SUSPENDED = 0x00000004;
const CREATE_NO_WINDOW = 0x08000000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESTDHANDLES = 0x00000100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x00100000;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const JOB_STOP_TIMEOUT_MS = 5000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const RELAY_CHUNK_BYTES = 64 * 1024;

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
  QueryInformationJobObject: {
    args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.bool,
  },
  AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
  IsProcessInJob: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.bool },
  OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
  QueryFullProcessImageNameW: {
    args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.bool,
  },
  ResumeThread: { args: [FFIType.u64], returns: FFIType.u32 },
  GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
  WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.bool },
  TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
  GetErrorMode: { args: [], returns: FFIType.u32 },
  SetErrorMode: { args: [FFIType.u32], returns: FFIType.u32 },
});

export function wide(value: string): Uint16Array {
  return Uint16Array.from({ length: value.length + 1 }, (_, i) => value.charCodeAt(i) || 0);
}

function quote(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/\\+$/g, (slashes) => slashes + slashes)}"`;
}

function check(ok: number | bigint, name: string): void {
  if (!ok || ok === INVALID_HANDLE_VALUE) throw new Error(`${name} failed: ${kernel32.symbols.GetLastError()}`);
}

function openInheritable(path: string, access: number, disposition: number): bigint {
  const sa = new Uint8Array(24);
  const view = new DataView(sa.buffer);
  view.setUint32(0, sa.length, true);
  view.setUint32(16, 1, true);
  const handle = kernel32.symbols.CreateFileW(ptr(wide(path)), access, 0x00000007, ptr(sa), disposition, 0x80, 0);
  check(handle, `CreateFileW(${path})`);
  return BigInt(handle);
}

function activeProcesses(job: bigint): number {
  const accounting = new Uint8Array(48);
  check(
    kernel32.symbols.QueryInformationJobObject(
      job,
      JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
      ptr(accounting),
      accounting.byteLength,
      null,
    ),
    "QueryInformationJobObject",
  );
  return new DataView(accounting.buffer).getUint32(40, true); // ActiveProcesses
}

function readJobProcess(job: bigint, pid: number): JobProcess | undefined {
  const proc = kernel32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
  if (!proc) return kernel32.symbols.GetLastError() === ERROR_INVALID_PARAMETER ? undefined : { pid };
  try {
    const inJob = new Uint32Array(1);
    check(kernel32.symbols.IsProcessInJob(proc, job, ptr(inJob)), "IsProcessInJob");
    if (!inJob[0] || kernel32.symbols.WaitForSingleObject(proc, 0) === WAIT_OBJECT_0) return;
    const path = new Uint16Array(32768);
    const size = new Uint32Array([path.length]);
    if (kernel32.symbols.QueryFullProcessImageNameW(proc, 0, ptr(path), ptr(size))) {
      const image = basename(Buffer.from(path.buffer, 0, size[0]! * 2).toString("utf16le"));
      return { pid, image };
    }
    if (kernel32.symbols.WaitForSingleObject(proc, 0) !== WAIT_OBJECT_0) return { pid };
  } finally {
    kernel32.symbols.CloseHandle(proc);
  }
}

function jobProcesses(job: bigint, active: number): JobProcess[] {
  // Two DWORD counts followed by an array of x64 ULONG_PTR process IDs.
  let capacity = active;
  for (;;) {
    const list = new Uint32Array(2 + capacity * 2);
    const ok = kernel32.symbols.QueryInformationJobObject(
      job,
      JOB_OBJECT_BASIC_PROCESS_ID_LIST,
      ptr(list),
      list.byteLength,
      null,
    );
    if (ok) {
      const processes: JobProcess[] = [];
      for (let i = 0; i < list[1]!; i++) {
        const member = readJobProcess(job, list[2 + i * 2]!);
        if (member) processes.push(member);
      }
      return processes;
    }
    const error = kernel32.symbols.GetLastError();
    if (error !== ERROR_MORE_DATA) throw new Error(`could not list remaining test processes: ${error}`);
    capacity = Math.max(capacity * 2, list[0]!);
  }
}

async function waitForEmptyJob(job: bigint, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const active = activeProcesses(job);
    if (!active || Date.now() >= deadline) return active;
    await Bun.sleep(25);
  }
}

async function stopJob(job: bigint): Promise<void> {
  check(kernel32.symbols.TerminateJobObject(job, 1), "TerminateJobObject");
  if (await waitForEmptyJob(job, JOB_STOP_TIMEOUT_MS)) {
    throw new Error("test process tree did not exit after termination");
  }
}

async function relay(
  path: string,
  state: { fd: number; offset: number },
  stream: NodeJS.WriteStream,
  deadline: number,
  interrupted: () => boolean,
): Promise<boolean> {
  if (state.fd < 0) state.fd = openSync(path, "r");
  let copied = false;
  for (let i = 0; i < 4; i++) {
    if (interrupted() || Date.now() >= deadline) break;
    const chunk = Buffer.allocUnsafe(RELAY_CHUNK_BYTES);
    const count = readSync(state.fd, chunk, 0, chunk.length, state.offset);
    if (!count) break;
    copied = true;
    state.offset += count;
    if (!stream.write(chunk.subarray(0, count))) {
      while (stream.writableNeedDrain && !interrupted() && Date.now() < deadline) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 100);
        try {
          await once(stream, "drain", { signal: abort.signal });
        } catch (error) {
          if (!abort.signal.aborted) throw error;
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
  return copied;
}

type JobOptions = {
  timeoutMs: number;
  exitGraceMs?: number;
  desktop?: string;
  env?: Record<string, string | undefined>;
};

type JobResult = {
  exitCode: number;
  timedOut: boolean;
  interrupted: boolean;
  remaining: JobProcess[];
};

type JobProcess = { pid: number; image?: string };

export async function runInJob(args: readonly string[], options: JobOptions): Promise<JobResult> {
  const exe = args[0]!.toLowerCase() === "bun" ? process.execPath : (Bun.which(args[0]!) ?? resolve(args[0]!));
  const cmdline = wide([exe, ...args.slice(1)].map(quote).join(" "));

  const dir = mkdtempSync(join(tmpdir(), "solok-test-job-"));
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
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    stdin = openInheritable("NUL", 0x80000000, 3);
    stdout = openInheritable(stdoutPath, 0x40000000, 2);
    stderr = openInheritable(stderrPath, 0x40000000, 2);

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
    const desktopPath = options.desktop ? wide(options.desktop) : null;
    if (desktopPath) siView.setBigUint64(16, BigInt(ptr(desktopPath)), true);
    siView.setUint32(60, STARTF_USESTDHANDLES, true);
    siView.setBigUint64(80, stdin, true);
    siView.setBigUint64(88, stdout, true);
    siView.setBigUint64(96, stderr, true);
    const pi = new Uint8Array(24);
    const cwd = wide(process.cwd());
    const env = options.env
      ? wide(
          Object.entries(options.env)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value}`)
            .join("\0") + "\0",
        )
      : null;
    const previousErrorMode = kernel32.symbols.GetErrorMode();
    kernel32.symbols.SetErrorMode(previousErrorMode | ERROR_MODE);
    let created: boolean;
    try {
      created = Boolean(
        kernel32.symbols.CreateProcessW(
          ptr(wide(exe)),
          ptr(cmdline),
          null,
          null,
          true,
          CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
          env ? ptr(env) : null,
          ptr(cwd),
          ptr(si),
          ptr(pi),
        ),
      );
    } finally {
      kernel32.symbols.SetErrorMode(previousErrorMode);
    }
    check(created, "CreateProcessW");
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
    const deadline = Date.now() + options.timeoutMs;
    let exited = false;
    while (!interrupted && Date.now() < deadline) {
      await relay(stdoutPath, outState, process.stdout, deadline, () => interrupted);
      await relay(stderrPath, errState, process.stderr, deadline, () => interrupted);
      const wait = kernel32.symbols.WaitForSingleObject(proc, 0);
      if (wait === WAIT_OBJECT_0) {
        check(kernel32.symbols.GetExitCodeProcess(proc, ptr(exitCode)), "GetExitCodeProcess");
        exited = true;
        break;
      }
      if (wait !== WAIT_TIMEOUT) throw new Error(`WaitForSingleObject failed: ${kernel32.symbols.GetLastError()}`);
      await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }

    // Drain the whole owned tree before the next test starts, even after timeout.
    const active = exited && options.exitGraceMs !== undefined ? await waitForEmptyJob(job, options.exitGraceMs) : 0;
    const remaining = active ? jobProcesses(job, active) : [];
    if (!exited || active) await stopJob(job);
    const drainDeadline = Date.now() + 1000;
    while (!interrupted && Date.now() < drainDeadline) {
      const out = await relay(stdoutPath, outState, process.stdout, drainDeadline, () => interrupted);
      const err = await relay(stderrPath, errState, process.stderr, drainDeadline, () => interrupted);
      if (!out && !err) break;
    }
    return { exitCode: exitCode[0]!, timedOut: !exited && !interrupted, interrupted, remaining };
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (thread) kernel32.symbols.CloseHandle(thread);
    if (job) kernel32.symbols.CloseHandle(job);
    if (proc) kernel32.symbols.CloseHandle(proc);
    if (stdin) kernel32.symbols.CloseHandle(stdin);
    if (stdout) kernel32.symbols.CloseHandle(stdout);
    if (stderr) kernel32.symbols.CloseHandle(stderr);
    if (outState.fd >= 0) closeSync(outState.fd);
    if (errState.fd >= 0) closeSync(errState.fd);
    rmSync(dir, { recursive: true, force: true });
  }
}
