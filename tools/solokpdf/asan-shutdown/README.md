# ASan shutdown probe

Independent E38 reproducer. Build and run through `run-hidden.ts` from an x64
Visual Studio Developer PowerShell. See
[results and commands](../../../docs/solokpdf/asan-shutdown.md).

`run.ps1 -Mode plain` is the control; `-Mode asan` must also pass once the
runtime is corrected. It currently fails at process shutdown. Neither mode
builds SolokPDF. Outputs live in `.work/e38-repro`.
