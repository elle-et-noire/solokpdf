# E38: ASan process shutdown

2026-11-11: corrected by using Microsoft's MSVC/ASan `14.52.37029` package.
SolokPDF's ASan wrapper downloads the matching compiler, CRT and runtime into
`.work/msvc-asan`; Visual Studio's installed tools remain unchanged.
[Correction evidence](data/e38-correction-2026-11-11.json).

## Correction

The independent probe fails with installed ASan `19.51.36256.0` and passes with
`19.52.37029.0`. Each runtime was checked three times with legacy hooks both
disabled and enabled, alongside non-ASan controls. Both explicit unload and
process shutdown must preserve the block and zero the extended bytes. The
corrected runtime also rejected an intentional heap overflow in all six ASan
runs.

The Debug ASan application passed `atomic-pdf-save`'s original
`pdfium-small-w` case 40 consecutive times, then all 14 save cases. These local
runs used the hidden desktop and the existing ASan options/suppressions.
The updated ASan workflow adds this save/shutdown check; hosted validation
has not been run for this change.

`cmd/solok-fetch-asan.ts` pins six official VSIX packages and verifies their
catalog SHA-256 digests. Build arguments select the same tools directory for
compilation, linking and runtime staging. An incomplete toolset fails instead
of falling back. ASan builds use two MSBuild workers to bound memory use.
Dav1d's compatibility header now guards Clang's `__has_include_next` separately,
as required by the new MSVC preprocessor.

Replacing only the DLL in an old executable fails at startup (`0xC0000139`):
the toolset's imports changed. Rebuild with the matching libraries. The pinned
packages come from the
[Microsoft stable catalog](https://aka.ms/vs/18/stable/channel), snapshot
`VisualStudio/18.12.0+12405.243`.

## Original findings

[Original evidence](data/e38-shutdown-2026-11-11.json) records the affected runtime.

`atomic-pdf-save` reproduced native exit `0xC0000409`, fast-fail parameter
`0x23` (`FAST_FAIL_UNEXPECTED_HEAP_EXCEPTION`). Microsoft public PDBs resolve
the application failure to:

```text
MSCTF!CicFlsCallback
  MSCTF!TLS::InternalDestroyTLS
    MSCTF!CInputProfileManager::~CInputProfileManager
      ASan!__asan_wrap_RtlReAllocateHeap
        ntdll!RtlReAllocateHeap
          ntdll!RtlpHpReallocComputeSizes
```

This runs under `LdrShutdownProcess`, after the application's cleanup marker.
MSVC ASan runtime `19.51.36256.0` bypasses its allocation-ownership handling
when `__sanitizer::IsProcessTerminating()` is true and calls the original
`RtlReAllocateHeap`. Its local PDB and disassembly identify that branch;
the wrapper return address in the failed application is RVA `0x907f3`.

An independent EXE/DLL probe allocates a block that
`__sanitizer_get_ownership` identifies as ASan-owned. It reallocates that block
through `RtlReAllocateHeap` during DLL cleanup. Explicit `FreeLibrary` succeeds;
process shutdown fails. The same source without ASan succeeds in both phases.
Both values of `windows_hook_legacy_allocators` produce the ASan failure.
Each of the four conditions was repeated three times. After an interruption
and Windows DLL updates, one further run per condition gave the same results;
the evidence distinguishes the retained stack images from the newer system files.

Together, the probe and application stack identify an incompatible ASan-to-system
heap handoff during process termination. The probe reports a null reallocation;
it does not reproduce the application's exact fast-fail on every allocation.
It contains no SolokPDF, PDFium or MuPDF code. No product memory-safety conclusion
beyond this shutdown path follows from it.

## Reproduce

Use an x64 Visual Studio Developer PowerShell, outside the sandbox. The script
builds only a small Debug probe, stages the compiler's ASan runtime, and requires
the hidden runner:

```powershell
. ./tools/solokpdf/env.ps1
$env:ASAN_OPTIONS = 'windows_hook_legacy_allocators=0'
bun cmd/solok-fetch-asan.ts
$tools = Join-Path $PWD '.work/msvc-asan/14.52.37029/Contents/VC/Tools/MSVC/14.52.37025'
bun tools/solokpdf/run-hidden.ts -- pwsh -NoProfile -File tools/solokpdf/asan-shutdown/run.ps1 -Mode plain -ToolsDir $tools
bun tools/solokpdf/run-hidden.ts -- pwsh -NoProfile -File tools/solokpdf/asan-shutdown/run.ps1 -Mode asan -ToolsDir $tools
```

Repeat with `windows_hook_legacy_allocators=1`. Both modes must pass; ASan mode
also requires the expected overflow diagnostic from its negative test.
Omit `-ToolsDir` to compare the installed compiler/runtime. The affected
runtime passes ASan's explicit unload, prints `asan-owned=1` and
`realloc=failed` during shutdown, and fails the script. The child can exit zero
after a failed reallocation; the script still rejects that result. A native
crash also fails. Outputs are under `.work/e38-repro/<compiler-version>`.
The independent diagnostic remains outside the normal test suites.

## Application recheck

```powershell
bun cmd/solok-build.ts -asan
$env:SUMATRA_TEST_EXE = Join-Path $PWD 'out/dbg64_asan/SumatraPDF-static.exe'
$env:ASAN_OPTIONS = 'windows_hook_legacy_allocators=0:suppressions="' + (Join-Path $PWD 'asan.supp') + '"'
bun tools/solokpdf/run-hidden.ts -- bun tests/atomic-pdf-save.ts --no-build
```

Instrumentation and failure checks remain enabled. Legacy hooks remain disabled
for the print-dialog reason. No suppression, IME disabling, runtime binary patch
or forced-success exit was added. No local Release build or full suite was run.

Microsoft documents the
[allocator hooks](https://learn.microsoft.com/en-us/cpp/sanitizers/asan-runtime?view=msvc-170).
The termination branch above was read from the installed MSVC runtime, not
inferred from upstream LLVM's differing implementation.
