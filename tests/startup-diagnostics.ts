import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { EXE, ROOT } from "./util.ts";
import { enumWindows, getClassName, getWindowPid, getWindowText } from "./winapi.ts";

const kCaptureTimeoutMs = 15_000;

function findCdb(): string | undefined {
  const paths = [
    Bun.which("cdb.exe"),
    String.raw`C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe`,
    String.raw`C:\Program Files\Windows Kits\10\Debuggers\x64\cdb.exe`,
  ];
  return paths.find((path): path is string => !!path && existsSync(path));
}

async function runCapture(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, _NT_SYMBOL_PATH: `${dirname(EXE)};${join(ROOT, "out", "dbg64")}` },
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    const timer = setTimeout(() => proc.kill(), kCaptureTimeoutMs);
    const exit = await proc.exited;
    clearTimeout(timer);
    return `command: ${args.join(" ")}\nexit: ${exit}\n${await stdout}\n${await stderr}`;
  } catch (error) {
    return `capture failed: ${error}\n`;
  }
}

export async function captureStartupFailure(pid: number, pipe: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const windows: string[] = [];
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) === pid) windows.push(`${hwnd} ${getClassName(hwnd)} ${getWindowText(hwnd)}`);
    return true;
  });
  const dump = join(dir, "startup.dmp");
  const cdb = findCdb();
  let result = "";
  if (cdb) {
    result = await runCapture([cdb, "-p", String(pid), "-c", `.dump /m "${dump}"; ~*kb; qd`]);
  }
  if (!existsSync(dump) || statSync(dump).size === 0) {
    result += "\nTrying MiniDumpWriteDump.\n";
    result += await runCapture([process.execPath, join(ROOT, "tests", "write-startup-dump.ts"), String(pid), dump]);
  }
  if (process.env.GITHUB_ACTIONS) {
    try {
      copyFileSync(EXE, join(dir, "app.exe"));
    } catch (error) {
      result += `\ncopy executable: ${error}`;
    }
  }
  for (const name of process.env.GITHUB_ACTIONS ? ["SumatraPDF.pdb", "libsumatrapdf.pdb"] : []) {
    let src = join(ROOT, "out", "dbg64", name);
    if (!existsSync(src) && name === "SumatraPDF.pdb") {
      src = join(dirname(EXE), basename(EXE).replace(/\.exe$/i, ".pdb"));
    }
    if (existsSync(src)) {
      try {
        copyFileSync(src, join(dir, name));
      } catch (error) {
        result += `\ncopy ${name}: ${error}`;
      }
    }
  }
  writeFileSync(
    join(dir, "startup-diagnostics.txt"),
    `pid: ${pid}\npipe: ${pipe}\nwindows:\n${windows.join("\n")}\n${result}\n`,
  );
}
