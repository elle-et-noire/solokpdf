# SolokPDF (experimental Windows fork)

SolokPDF is derived from [SumatraPDF](https://github.com/sumatrapdfreader/sumatrapdf).
It retains the original Win32 UI and adds an independent PDFium PDF engine.
The `src/ng/` application is outside this project’s scope.

Build the portable development version:

```powershell
# Install Bun first. These build-only packages stay outside the source tree.
New-Item -ItemType Directory -Force .work/build-deps | Out-Null
. ./tools/solokpdf/env.ps1
bun add --cwd .work/build-deps minio@8.0.6 prettier@3.6.2
bun cmd/solok-build.ts -dbg            # or -rel
```

The wrapper verifies a pinned Windows x64 PDFium archive, regenerates projects
with official Premake into the ignored `vs2026/` (toolset v145), invokes the
original build script and stages a portable folder with license notices. Debug
output is `out/solokpdf-dev/`; release output is `out/solokpdf-portable/`. PDBs
are for development, not required to run.
The release wrapper creates `out/SolokPDF-experimental-x64.zip`. Recorded build
and test results are in [history](docs/solokpdf/history.md).

For local test builds, `bun cmd/solok-build.ts -quick` updates
`out/dbg64/SumatraPDF.exe` and `pdfium.dll` without staging the portable folder.
For ASan, `bun cmd/solok-build.ts -asan` builds `SumatraPDF-static.exe` and
stages PDFium and the ASan runtime in `out/dbg64_asan/`; see the
[ASan test procedure](docs/solokpdf/testing.md#asan-builds).
Run app-launching tests through the [hidden-desktop runner](docs/solokpdf/testing.md).
Keep `-for-testing` on ad-hoc launches; physical checks follow the
[owner's manual acceptance procedure](docs/solokpdf/testing.md#owners-manual-acceptance-f1f3).

PDFium is the default for PDFs in this build. Set `$env:SOLOKPDF_ENGINE='mupdf'`
to compare using the same UI. Non-PDF formats retain their existing engines.
PDFium failure reports its cause and falls back to MuPDF. One PDF is not kept
open by both engines during normal PDFium viewing; the MuPDF DLL remains for
other formats and shared functionality.

PDFium also opens password-protected PDFs, attached PDFs, `.p7m` and Kindle
Print Replica. Annotations, forms, document JavaScript, signatures, redaction,
attachments and the PDF tools work on PDFium tabs through a MuPDF editor of the
same file, loaded only when needed. XFA and GoToE are unsupported in both
engines. See [limitations](docs/solokpdf/limitations.md) for remaining gaps.

Settings use `SolokPDF-settings.txt`; local data uses `SolokPDF` / `SolokPDF-data`.
Upstream binary updates are disabled. Default-app association works through
`Applications\\SolokPDF.exe`; installer behavior remains unvalidated. Use the
portable build. Existing copyright and license terms remain, including MuPDF's
AGPL obligations; see `AUTHORS` and `COPYING`.

See [SolokPDF docs](docs/solokpdf/README.md) for current status, open work,
test setup and measurements. See the [current architecture](docs/solokpdf/architecture.md)
and [design review plan](docs/solokpdf/refactoring-plan.md) for responsibilities and planned changes.
Bookmarks and favorites use virtual trees in Debug
and Release, following the document's scrollbar mode. See the
[tree migration](docs/solokpdf/tree-view-replacement-plan.md) for validation
results and the owner's completed physical-device checks.

## Original SumatraPDF project

[![Build](https://github.com/sumatrapdfreader/sumatrapdf/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/sumatrapdfreader/sumatrapdf/actions/workflows/build.yml)

## SumatraPDF Reader

SumatraPDF is a multi-format (PDF, EPUB, MOBI, CBZ, CBR, FB2, CHM, XPS, DjVu) reader
for Windows under (A)GPLv3 license, with some code under BSD license (see
AUTHORS).

More Information:

- [Website](https://www.sumatrapdfreader.org/free-pdf-reader)
- [Manual](https://www.sumatrapdfreader.org/manual)
- [Developer Information](https://www.sumatrapdfreader.org/docs/Contribute-to-SumatraPDF)
