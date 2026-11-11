import { dirname, join, resolve } from "node:path";
import { ROOT, tmpPath } from "./util.ts";
import { outDirName, resolveSources, type BuildFlags } from "../cmd/helper/ng-compile";
import { forPlatform, targets } from "../cmd/helper/ng-targets";
import type { Platform } from "../cmd/helper/ng-toolchain";
import { isShared, sharedFiles } from "../cmd/helper/ng-shared";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { asanDllName, asanMsbuildArgs, findAsanDll } from "../cmd/helper/asan-runtime";
import { detectVisualStudio2026 } from "../cmd/util";

function run(args: string[], script = "build.ts"): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", join(ROOT, "cmd", script), ...args], { cwd: ROOT });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function checkAsanRuntime(): void {
  const root = mkdtempSync(tmpPath("asan-runtime-"));
  const version = "14.51.36231";
  const versionFile = join(root, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt");
  const runtime = join(root, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "x64", asanDllName);
  const write = (path: string, data: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  try {
    write(versionFile, `${version}\r\n`);
    for (const installed of ["14.44.35207", version, "14.60.40000"]) {
      write(join(root, "VC", "Tools", "MSVC", installed, "bin", "Hostx64", "x64", asanDllName), installed);
    }
    write(join(root, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "arm64", asanDllName), "ARM64");
    write(join(root, "VC", "Tools", "Llvm", "x64", "lib", "clang", "21", "lib", "windows", asanDllName), "LLVM");
    assert.equal(findAsanDll(root), runtime, "ASan runtime must match the default MSVC toolset");

    const tools = join(root, "portable tools", "14.52.37025");
    const replacement = join(tools, "bin", "Hostx64", "x64", asanDllName);
    write(replacement, "corrected runtime");
    assert.equal(findAsanDll(root, tools), resolve(replacement), "explicit toolset must supply the ASan runtime");
    assert.deepEqual(asanMsbuildArgs(), []);
    assert.throws(() => asanMsbuildArgs(tools), /MSVC toolset is missing/);
    for (const file of [
      "bin/Hostx64/x64/cl.exe",
      "bin/Hostx64/x64/link.exe",
      "include/vcruntime.h",
      "lib/x64/libcmt.lib",
    ]) {
      write(join(tools, file), "matched tools");
    }
    assert.deepEqual(asanMsbuildArgs(tools), [
      `/p:VCToolsInstallDir=${resolve(tools)}\\`,
      "/p:VCToolsVersion=14.52.37025",
      "/p:PreferredToolArchitecture=x64",
    ]);
    assert.throws(() => asanMsbuildArgs(root), /invalid MSVC tools directory/);
    rmSync(replacement);
    assert.throws(() => findAsanDll(root, tools), /ASan runtime/, "missing explicit runtime must not use the default");

    rmSync(runtime);
    assert.throws(
      () => findAsanDll(root),
      (error: unknown) => error instanceof Error && error.message.includes(runtime),
      "missing runtime must not use another toolset",
    );
    rmSync(versionFile);
    assert.throws(() => findAsanDll(root), /Microsoft\.VCToolsVersion\.default\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function checkVs2026Configs(): void {
  if (process.platform !== "win32") return;

  const generate = Bun.spawnSync([join(ROOT, "bin", "premake5.exe"), "--with-pdfium", "vs2026"], { cwd: ROOT });
  check(generate.exitCode === 0, `VS2026 generation failed:\n${generate.stderr}`);

  const { msbuildPath } = detectVisualStudio2026();
  // Validate the solution-to-project mapping without compiling the application.
  for (const config of ["Debug", "Release"]) {
    const validate = Bun.spawnSync(
      [
        msbuildPath,
        join(ROOT, "vs2026", "SumatraPDF.slnx"),
        "/t:SumatraPDF-static:_CheckForInvalidConfigurationAndPlatform",
        `/p:Configuration=${config};Platform=x64_asan`,
        "/nologo",
        "/v:minimal",
      ],
      { cwd: ROOT },
    );
    check(
      validate.exitCode === 0,
      `VS2026 ${config} ASan configuration failed:\n${validate.stdout}\n${validate.stderr}`,
    );
  }
}

export async function testit(): Promise<void> {
  checkAsanRuntime();
  checkVs2026Configs();

  const noArgs = run([]);
  check(noArgs.code === 0, `no-argument exit code: ${noArgs.code}`);
  check(noArgs.stdout.includes("Usage: bun cmd/build.ts"), "no-argument invocation did not print usage");

  const unknown = run(["-not-a-build-option"]);
  check(unknown.code !== 0, "unknown option succeeded");
  check(unknown.stderr.includes("unknown option: -not-a-build-option"), "unknown option did not print an error");
  check(unknown.stderr.includes("Usage: bun cmd/build.ts"), "unknown option did not print usage");

  const conflict = run(["-dbg", "-rel"]);
  check(conflict.code !== 0, "conflicting configurations succeeded");
  check(conflict.stderr.includes("cannot be used together"), "configuration conflict did not explain the error");

  for (const flag of ["-mingw", "-wine", "-win"]) {
    const removed = run([flag]);
    check(removed.code !== 0 && removed.stderr.includes("unknown option"), `${flag} is still supported`);
  }

  const ngHelp = run([], "ng-build.ts");
  check(ngHelp.code === 0 && ngHelp.stdout.includes("Usage: bun cmd/ng-build.ts"), "ng did not print usage");
  const ngUnknown = run(["-unknown"], "ng-build.ts");
  check(ngUnknown.code !== 0 && ngUnknown.stderr.includes("unknown option"), "ng accepted an unknown option");
  const ngConflict = run(["-dbg", "-rel"], "ng-build.ts");
  check(
    ngConflict.code !== 0 && ngConflict.stderr.includes("cannot be used together"),
    "ng accepted conflicting configs",
  );

  const makeLzsa = targets.find((target) => target.name === "MakeLZSA");
  check(makeLzsa?.systemDeps === "archive", "MakeLZSA pulls desktop system dependencies");

  const flags: BuildFlags = { debug: true, asan: false, clang: false, clean: false, verbose: false };
  for (const plat of ["win", "mac", "linux", "wasm"] as Platform[]) {
    check(outDirName(plat, flags) === `${plat}/dbg`, `wrong ng debug directory for ${plat}`);
    check(outDirName(plat, { ...flags, debug: false }) === `${plat}/rel`, `wrong ng release directory for ${plat}`);
    check(outDirName(plat, { ...flags, asan: true }) === `${plat}/dbg-asan`, `wrong ng ASan directory for ${plat}`);
  }
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  for (const target of targets) {
    for (const plat of ["win", "mac", "linux", "wasm"] as Platform[]) {
      if (target.platforms && !target.platforms.includes(plat)) continue;
      for (const src of resolveSources(forPlatform(target, plat), plat, fail)) {
        check(
          !src.startsWith("src/") || src.startsWith("src/ng/") || isShared(src),
          `${target.name} uses unlisted originals`,
        );
      }
    }
  }
  for (const src of sharedFiles) {
    check(existsSync(join(ROOT, src)), `shared source missing: ${src}`);
    check(!existsSync(join(ROOT, src.replace(/^src\//, "src/ng/"))), `shared source still duplicated: ${src}`);
  }
  console.log("PASS: unified build CLI validation");
}

if (import.meta.main) {
  try {
    await testit();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
