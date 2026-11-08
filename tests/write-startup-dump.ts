import { dlopen, FFIType, ptr } from "bun:ffi";

const kernel = dlopen("kernel32.dll", {
  OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
  CreateFileW: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
    returns: FFIType.u64,
  },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const dbghelp = dlopen("dbghelp.dll", {
  MiniDumpWriteDump: {
    args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.bool,
  },
});
const kProcessQueryAndRead = 0x0410;
const kGenericWrite = 0x40000000;
const kShareReadWrite = 3;
const kCreateAlways = 2;
const kFileAttributeNormal = 0x80;
const kInvalidHandle = 0xffffffffffffffffn;
const kDumpWithThreadInfo = 0x1000;

const pid = Number(process.argv[2]);
const path = process.argv[3];
if (!Number.isInteger(pid) || pid <= 0 || !path) throw new Error("expected PID and dump path");
const processHandle = kernel.symbols.OpenProcess(kProcessQueryAndRead, false, pid);
if (!processHandle) throw new Error(`OpenProcess failed: ${kernel.symbols.GetLastError()}`);
try {
  const widePath = Buffer.from(`${path}\0`, "utf16le");
  const file = kernel.symbols.CreateFileW(
    ptr(widePath),
    kGenericWrite,
    kShareReadWrite,
    null,
    kCreateAlways,
    kFileAttributeNormal,
    0n,
  );
  if (file === kInvalidHandle) throw new Error(`CreateFileW failed: ${kernel.symbols.GetLastError()}`);
  try {
    if (!dbghelp.symbols.MiniDumpWriteDump(processHandle, pid, file, kDumpWithThreadInfo, null, null, null)) {
      throw new Error(`MiniDumpWriteDump failed: ${kernel.symbols.GetLastError()}`);
    }
  } finally {
    kernel.symbols.CloseHandle(file);
  }
} finally {
  kernel.symbols.CloseHandle(processHandle);
  dbghelp.close();
  kernel.close();
}
