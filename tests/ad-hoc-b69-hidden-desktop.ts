import { dlopen, FFIType, ptr } from "bun:ffi";

const user32 = dlopen("user32.dll", {
  GetThreadDesktop: { args: [FFIType.u32], returns: FFIType.u64 },
  GetUserObjectInformationW: {
    args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.bool,
  },
  OpenInputDesktop: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
  CloseDesktop: { args: [FFIType.u64], returns: FFIType.bool },
  CreateWindowExW: {
    args: [
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.u64,
      FFIType.u64,
      FFIType.u64,
      FFIType.ptr,
    ],
    returns: FFIType.u64,
  },
  IsWindowVisible: { args: [FFIType.u64], returns: FFIType.bool },
  DestroyWindow: { args: [FFIType.u64], returns: FFIType.bool },
});
const kernel32 = dlopen("kernel32.dll", {
  GetCurrentThreadId: { args: [], returns: FFIType.u32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  GetErrorMode: { args: [], returns: FFIType.u32 },
});

const ERROR_MODE = 0x0001 | 0x0002 | 0x8000;

function wide(value: string): Uint16Array {
  return new Uint16Array([...value].map((char) => char.charCodeAt(0)).concat(0));
}

function desktopName(handle: bigint): string {
  const buf = new Uint16Array(128);
  if (!user32.symbols.GetUserObjectInformationW(handle, 2, ptr(buf), buf.byteLength, null)) {
    throw new Error(`GetUserObjectInformationW: ${kernel32.symbols.GetLastError()}`);
  }
  return String.fromCharCode(...buf.subarray(0, buf.indexOf(0)));
}

export async function testit(): Promise<void> {
  if (!process.env.SOLOKPDF_HIDDEN_DESKTOP) {
    console.log("SKIP B69: hosted CI does not use the local hidden-desktop runner");
    return;
  }
  const current = user32.symbols.GetThreadDesktop(kernel32.symbols.GetCurrentThreadId());
  if (!current) throw new Error("GetThreadDesktop failed");
  const name = desktopName(BigInt(current));
  if (name !== process.env.SOLOKPDF_HIDDEN_DESKTOP) throw new Error(`test runs on ${name}`);
  if ((kernel32.symbols.GetErrorMode() & ERROR_MODE) !== ERROR_MODE) throw new Error("crash UI is not suppressed");

  const input = user32.symbols.OpenInputDesktop(0, false, 0x0001);
  if (!input) throw new Error(`OpenInputDesktop: ${kernel32.symbols.GetLastError()}`);
  try {
    if (desktopName(BigInt(input)) === name) throw new Error("test desktop is visible");
  } finally {
    user32.symbols.CloseDesktop(input);
  }

  const klass = wide("STATIC");
  const title = wide("B69 hidden window probe");
  const window = user32.symbols.CreateWindowExW(0, ptr(klass), ptr(title), 0x10000000, 0, 0, 100, 100, 0, 0, 0, null);
  if (!window) throw new Error(`CreateWindowExW: ${kernel32.symbols.GetLastError()}`);
  try {
    if (!user32.symbols.IsWindowVisible(window)) throw new Error("probe window is not visible on its desktop");
    console.log(`PASS: visible probe window belongs to hidden desktop ${name}`);
  } finally {
    user32.symbols.DestroyWindow(window);
  }
}

if (import.meta.main) await testit();
