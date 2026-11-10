import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const asanDllName = "clang_rt.asan_dynamic-x86_64.dll";

export function findAsanDll(vsRoot: string): string {
  // Match the default toolset selected by detectVisualStudio2026.
  const versionFile = join(vsRoot, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt");
  const version = readFileSync(versionFile, "utf8").trim();
  const path = join(vsRoot, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "x64", asanDllName);
  if (!existsSync(path)) {
    throw new Error(`could not find MSVC ${version} ASan runtime: ${path}`);
  }
  return path;
}
