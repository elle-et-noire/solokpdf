import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Visual Studio 18.12 stable catalog, 2026-11-11; keep compiler, CRT and ASan together.
export const asanToolsetPin = {
  version: "14.52.37029",
  toolsVersion: "14.52.37025",
  release: "aad09a18-fd5d-45d3-91e5-9fc87e932d9f",
  packages: [
    ["Tools.HostX64.TargetX64.base", "e8805f002246115e6c5a8444ba87a9f30e86c35943129f798f6deb99825685f8"],
    ["Tools.HostX64.TargetX64.Res.base.enu", "fbeb2488e009141ff915ad300569305efb24a79b7258cdfc50d73c05dc9a934e"],
    ["CRT.Headers.base", "97fac068e1b7d84d2596394523ffd13f4d93878f7313361d39bbf7579a803fe4"],
    ["CRT.x64.Desktop.base", "6e94791c63d5bd58f1495e2e0ab6c37756f1b06fc9400ef72c729ea0661413d3"],
    ["CRT.x64.Store.base", "b42af543b1261f0fce5b88fb9fe876c1e3d7579cf768f37cbd676aa571942a07"],
    ["ASAN.X64.base", "aa306830abd3ce8c7f1a7d67d37b1c2130b447b5028881808a4353f76e39e434"],
  ],
};

export async function fetchAsanTools(): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("MSVC ASan requires Windows x64");
  const dir = resolve(".work/msvc-asan", asanToolsetPin.version);
  mkdirSync(dir, { recursive: true });
  const pin = JSON.stringify(asanToolsetPin, null, 2) + "\n";
  const pinPath = join(dir, "solok-pin.json");
  const extracted = existsSync(pinPath) && readFileSync(pinPath, "utf8") === pin;
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  for (const [name, sha256] of asanToolsetPin.packages) {
    const file = `Microsoft.VC.14.52.${name}.vsix`;
    const archive = join(dir, file);
    let bytes: Uint8Array;
    if (existsSync(archive)) {
      bytes = readFileSync(archive);
    } else {
      const url = `https://download.visualstudio.microsoft.com/download/pr/${asanToolsetPin.release}/${sha256}/${file}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`MSVC ${file} download failed: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sha256) throw new Error(`MSVC ${file} SHA-256 mismatch: ${digest}`);
    writeFileSync(archive, bytes);
    if (!extracted) {
      const unpack = Bun.spawnSync([tar, "-xf", archive, "-C", dir], { stdout: "inherit", stderr: "inherit" });
      if (unpack.exitCode !== 0) throw new Error(`MSVC ${file} extraction failed`);
    }
    console.log(`Verified MSVC ${file}: ${digest}`);
  }
  const tools = join(dir, "Contents", "VC", "Tools", "MSVC", asanToolsetPin.toolsVersion);
  for (const file of [
    "bin/Hostx64/x64/cl.exe",
    "bin/Hostx64/x64/link.exe",
    "bin/Hostx64/x64/1033/clui.dll",
    "bin/Hostx64/x64/clang_rt.asan_dynamic-x86_64.dll",
    "include/vcruntime.h",
    "lib/x64/libcmt.lib",
    "lib/x64/oldnames.lib",
    "lib/x64/clang_rt.asan_dynamic-x86_64.lib",
    "lib/x64/clang_rt.asan_static_runtime_thunk-x86_64.lib",
  ]) {
    if (!existsSync(join(tools, file))) throw new Error(`MSVC package is missing ${file}`);
  }
  writeFileSync(pinPath, pin);
  return tools;
}

if (import.meta.main) console.log(await fetchAsanTools());
