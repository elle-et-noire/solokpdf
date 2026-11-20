import { dlopen, FFIType, ptr } from "bun:ffi";
import { runInJob, wide } from "./run-job.ts";

const DESKTOP_ALL_ACCESS = 0x01ff;
const DESKTOP_READOBJECTS = 0x0001;
const UOI_NAME = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const user32 = dlopen("user32.dll", {
  CreateDesktopW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.u64,
  },
  OpenInputDesktop: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
  GetUserObjectInformationW: {
    args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.bool,
  },
  CloseDesktop: { args: [FFIType.u64], returns: FFIType.bool },
});
const kernel32 = dlopen("kernel32.dll", {
  GetLastError: { args: [], returns: FFIType.u32 },
});

function check(ok: number | bigint, name: string): void {
  if (!ok) throw new Error(`${name} failed: ${kernel32.symbols.GetLastError()}`);
}

function desktopName(handle: bigint): string {
  const buf = new Uint16Array(128);
  check(
    user32.symbols.GetUserObjectInformationW(handle, UOI_NAME, ptr(buf), buf.byteLength, null),
    "GetUserObjectInformationW",
  );
  return String.fromCharCode(...buf.subarray(0, buf.indexOf(0)));
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
  const name = `SolokPDFTests-${process.pid}-${Date.now().toString(36)}`;
  const desktop = BigInt(user32.symbols.CreateDesktopW(ptr(wide(name)), null, null, 0, DESKTOP_ALL_ACCESS, null));
  check(desktop, "CreateDesktopW");
  try {
    const input = BigInt(user32.symbols.OpenInputDesktop(0, false, DESKTOP_READOBJECTS));
    check(input, "OpenInputDesktop");
    try {
      if (desktopName(input) === desktopName(desktop)) throw new Error("test desktop is the input desktop");
    } finally {
      check(user32.symbols.CloseDesktop(input), "CloseDesktop(input)");
    }

    const result = await runInJob(argv.slice(commandAt), {
      timeoutMs: timeout,
      desktop: `WinSta0\\${name}`,
      env: { ...process.env, SOLOKPDF_HIDDEN_DESKTOP: name },
    });
    if (result.timedOut) console.error(`hidden test timed out after ${timeout} ms`);
    return result.timedOut || result.interrupted ? 124 : result.exitCode;
  } finally {
    check(user32.symbols.CloseDesktop(desktop), "CloseDesktop(test)");
  }
}

process.exitCode = await main();
