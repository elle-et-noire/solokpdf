# E38: ASan process shutdown

2026-11-11: the shutdown allocator path is isolated; a runtime correction is
still required. E38 remains open. [Evidence](data/e38-shutdown-2026-11-11.json).

## Findings

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
bun tools/solokpdf/run-hidden.ts -- pwsh -NoProfile -File tools/solokpdf/asan-shutdown/run.ps1 -Mode plain
bun tools/solokpdf/run-hidden.ts -- pwsh -NoProfile -File tools/solokpdf/asan-shutdown/run.ps1 -Mode asan
```

Repeat with `windows_hook_legacy_allocators=1`. Plain mode should pass.
The affected runtime passes ASan's explicit unload, prints `asan-owned=1` and
`realloc=failed` during shutdown, and fails the script. The child can exit zero
after a failed reallocation; the script still rejects that result. A native
crash also fails. This diagnostic is outside the normal test suites because
the current runtime has no passing shutdown result.

## Remaining correction

Correct or replace the MSVC ASan runtime, then require both probe phases to
pass and repeat the application's `atomic-pdf-save` case through the hidden
runner. Preserve instrumentation, existing failure checks and the print-dialog
reason for disabling legacy hooks. Enabling those hooks alone does not correct
the probe. No suppression, IME disabling, runtime binary patch or forced-success
exit was added. No replacement runtime is installed locally.

Microsoft documents the
[allocator hooks](https://learn.microsoft.com/en-us/cpp/sanitizers/asan-runtime?view=msvc-170).
The termination branch above was read from the installed MSVC runtime, not
inferred from upstream LLVM's differing implementation.
