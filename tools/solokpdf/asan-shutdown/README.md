# ASan shutdown probe

Independent E38 reproducer. Build and run through `run-hidden.ts` from an x64
Visual Studio Developer PowerShell. See
[results and commands](../../../docs/solokpdf/asan-shutdown.md).

`run.ps1 -Mode plain` is the control. Both modes pass with MSVC/ASan
`14.52.37029`; installed `19.51.36256.0` fails at shutdown. `-ToolsDir` selects
the matching compiler, libraries and runtime. ASan mode also requires an
intentional heap overflow to fail with an ASan diagnostic. Neither mode builds
SolokPDF. Outputs live in `.work/e38-repro/<compiler-version>`.
