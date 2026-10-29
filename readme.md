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
./out/solokpdf-dev/SolokPDF.exe -for-testing paper.pdf
```

The wrapper verifies a pinned Windows x64 PDFium archive, regenerates projects
with official Premake into the ignored `vs2026/` (toolset v145), invokes the
original build script and stages a portable folder with license notices. Debug
output is `out/solokpdf-dev/`; release output is `out/solokpdf-portable/`. PDBs
are for development, not required to run.
Debug and Release GUI integration tests passed. The verified portable Release
archive is `out/SolokPDF-experimental-x64.zip`.

PDFium is the default for PDFs in this build. Set `$env:SOLOKPDF_ENGINE='mupdf'`
to compare using the same UI. Non-PDF formats retain their existing engines.
PDFium failure reports its cause and falls back to MuPDF. One PDF is not kept
open by both engines during normal PDFium viewing; the MuPDF DLL remains for
other formats and shared functionality.

Confirmed: rendering, zoom/rotation, links, navigation history, bookmarks,
selection/search, multiple tabs, and two-document Tab Groups/session paths
restored after restart. Startup and general memory targets remain unmet.
Annotation editing, interactive forms, JavaScript, signatures and several
advanced PDF features are not implemented in PDFium yet. Password-protected
PDFs currently fall back to MuPDF. This is not a feature-complete replacement.

Settings use `SolokPDF-settings.txt`; local data uses `SolokPDF` / `SolokPDF-data`.
Upstream binary updates are disabled. Installer and association workflows have
not been validated; use the portable build. Existing copyright and license
terms remain, including MuPDF's AGPL obligations; see `AUTHORS` and `COPYING`.

See [build, tests, measurements and limitations](docs/solokpdf-progress.md).
No commits or pushes are made automatically.

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
