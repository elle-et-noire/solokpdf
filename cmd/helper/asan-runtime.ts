import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const asanDllName = "clang_rt.asan_dynamic-x86_64.dll";
// Bound the memory used by concurrent ASan compiler processes.
export const asanBuildJobs = 2;

export function findAsanDll(vsRoot: string, toolsDir?: string): string {
  const versionFile = join(vsRoot, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt");
  const tools = toolsDir
    ? resolve(toolsDir)
    : join(vsRoot, "VC", "Tools", "MSVC", readFileSync(versionFile, "utf8").trim());
  const path = join(tools, "bin", "Hostx64", "x64", asanDllName);
  if (!existsSync(path)) {
    throw new Error(`could not find MSVC ASan runtime: ${path}`);
  }
  return path;
}

export function asanMsbuildArgs(toolsDir?: string): string[] {
  if (!toolsDir) return [];
  const tools = resolve(toolsDir);
  const version = basename(tools);
  if (!/^14\.\d+\.\d+$/.test(version)) throw new Error(`invalid MSVC tools directory: ${tools}`);
  for (const file of [
    "bin/Hostx64/x64/cl.exe",
    "bin/Hostx64/x64/link.exe",
    "include/vcruntime.h",
    "lib/x64/libcmt.lib",
  ]) {
    if (!existsSync(join(tools, file))) throw new Error(`MSVC toolset is missing ${file}: ${tools}`);
  }
  return [`/p:VCToolsInstallDir=${tools}\\`, `/p:VCToolsVersion=${version}`, "/p:PreferredToolArchitecture=x64"];
}
