# SolokPDF development log

## Baseline (2026-10-24)

- The initial repository had no commits or files. Its `origin` remains
  `git@github.com:elle-et-noire/solokpdf.git`.
- Added `upstream=https://github.com/sumatrapdfreader/sumatrapdf.git` for future
  merges; no upstream history was rewritten.
- Fetched full SumatraPDF history and checked out branch `solokpdf-dev` at
  `842ea1be52b1a708c3cf60fe8d42a51cab536d34`. No local commits or pushes
  existed when the baseline was captured.
- Read `readme.md`, `agents.md`, Premake definitions, original build/test
  scripts and CI configuration. Only the original Windows application is in scope.
- Environment: VS Community 2026 18.11.1 at `D:\vs2026`, MSVC
  14.51.36231 (v145), Windows SDK 10.0.26100.0. v143 is absent.
- Bun 1.3.11 is installed locally under ignored `.work/tools/`.
  Archive: `https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-windows-x64.zip`.
  Observed SHA-256: `066f8694f8b7d8df592452746d18f01710d4053e93030922dbc6e8c34a8c4b9f`.
  This hash was calculated after download, not independently authenticated.
- Build script imports `minio` even when no website checkout exists. Installed
  `minio@8.0.6` and `prettier@3.6.2` in ignored `.work/build-deps/`.
- Generated VS projects using `bin/premake5.exe vs2022`. Never hand-edit projects.
- Initial failures: VS not on PATH; missing Bun package; sandbox SDK lookup
  denied; missing v143. Build uses a local MSBuild
  `ForceImportBeforeCppProps` override to select installed v145 without
  modifying upstream source. Windows 7 compatibility is unverified.
- Unmodified debug build **passed** (`out/baseline/build-final.log`). Initial
  links of newly created PE files intermittently returned LNK1104; retrying
  without source changes passed. The cause was not established; no security
  settings were changed.
- Original executable/DLLs are preserved under `out/baseline/bin/`.
- Official `bun cmd/run-unit-tests.ts -dbg` **failed on the unmodified baseline**:
  `ClipboardImage_ut.cpp:88`, `len(dib) > sizeof(BITMAPV5HEADER)`, followed by
  access violation at line 90. Do not report the unit suite as passing.
  Raw output: `out/dbg64/unit-tests-dbg.txt`; build/test driver log:
  `out/baseline/unit-test-build.log`. The unrelated test was not changed.

## Engine map from this revision

| Responsibility     | Existing implementation / integration boundary                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine abstraction | `src/shared/EngineBase.{h,cpp}`; ref-counted lifetime; `RenderPage` returns owned `Pixmap`; cached text and asynchronous extraction                                               |
| Engine selection   | `src/shared/EngineCreate.cpp`, `CreateEngineForKind`; PDF, XPS and Markdown currently select MuPDF                                                                                |
| PDF implementation | `src/shared/EngineMupdf.{h,cpp}`; vendored MuPDF 1.28.5; document, page and render locks; per-thread contexts                                                                     |
| Display/navigation | `src/shared/DisplayModel.{h,cpp}`, `DocController`; engine coordinates and navigation history; UI dispatches `Navigate(-1/1)`                                                     |
| Render cache       | `src/shared/RenderCache.{h,cpp}`; queued background tile rendering, abort cookies, cache eviction, postprocessing; engine must support clipped tiles and close during queued work |
| Text               | `src/shared/TextSelection.cpp`, `TextSearch.cpp`; consume engine text with one bounding box per Unicode codepoint                                                                 |
| Links/outline      | Engine methods `GetElements`, `GetElementAtPos`, `GetNamedDest`, `GetToc`; existing destination and TOC types can be reused                                                       |
| Sessions           | `src/TabGroupsManage.cpp`, shared header and generated settings; UI-level tab/session management                                                                                  |
| Build integration  | `premake5.files.lua` and `premake5.lua`; regenerate using official Premake                                                                                                        |

MuPDF-specific annotation/form APIs extend beyond EngineBase. An independent
PDFium engine must report unsupported operations rather than claim parity.
`src/solokpdf/EnginePdfium.cpp` now opens each file-backed PDF using PDFium only.
MuPDF remains available for explicit comparison and fallback, not as a second
live document. Thumbnail/print cloning can temporarily open another PDFium
document, as the existing EngineBase contract permits.

PDFium public `fpdfview.h` requires serialization of **all** calls across the
process, including calls on different documents. A per-document mutex alone
would be insufficient. Destruction must use the same global synchronization.

## Reproduce the original build

```powershell
# From repository root, with local Bun available (or an existing Bun on PATH):
New-Item -ItemType Directory -Force .work/build-deps | Out-Null
. ./tools/solokpdf/env.ps1 -Toolset v145
bun add --cwd .work/build-deps minio@8.0.6 prettier@3.6.2
./bin/premake5.exe vs2022
bun cmd/build.ts -dbg
bun cmd/run-unit-tests.ts -dbg
# All ad-hoc GUI launches must include -for-testing.
./out/dbg64/SumatraPDF.exe -for-testing path/to/paper.pdf
```

With v143 installed, use `-Toolset v143`. The optional website checkout is absent;
the official scripts skip the embedded manual and JavaScript examples.

## Phase 2: independent renderer

Pin: PDFium **158.0.8111.0**, release `chromium/8111`,
[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium/8111).
`cmd/solok-fetch-pdfium.ts` downloads `pdfium-win-x64.tgz`, verifies GitHub's
published SHA-256 **before extraction**, and stages it under `.work/pdfium/`.

```text
https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8111/pdfium-win-x64.tgz
SHA-256 3452d11031050ec65e57f180215b57b9e6d465e3fbedafa8a77ad90885c7d23e
```

The archive's `args.gn` confirms x64 Windows, Release, no V8, no XFA, no
PartitionAlloc. The fixed branch's `build_overrides/pdfium.gni` defaults to
AGG and FreeType (`pdf_use_skia_override=false`). No Skia backend was built or
benchmarked here. Renderer selection must not be guessed: `fpdfview.h` warns
that selecting an unavailable renderer can crash during initialization.

```powershell
. ./tools/solokpdf/env.ps1 -Toolset v145
bun cmd/solok-build-probe.ts
New-Item -ItemType Directory -Force out/render | Out-Null
./out/pdfium-probe/pdfium-render.exe paper.pdf 4 144 out/render/page4.png --repeat 5
# Optional: --lcd, --scale 2 (points-to-pixels), --dll <absolute-or-relative-path>
bun experiments/pdfium/compare.ts .work/corpus/attention-1706.03762v7.pdf
```

`experiments/pdfium/render.cpp` is independent of SumatraPDF. It uses custom
file reads (Unicode paths, bounded offsets), explicit DLL loading, WIC PNG
output, RAII cleanup, dimension/allocation limits and JSON metrics. DPI and
scale are alternatives; 72 DPI equals one pixel per PDF point. `--scale`
overrides the positional DPI. Process memory is sampled before initialization
and after rendering, excluding PNG encoding. It is not a PDFium allocator trace.
The probe intentionally rejects files above 4 GiB and images above 64M pixels.

Corpus: [Attention Is All You Need, arXiv:1706.03762v7](https://arxiv.org/abs/1706.03762v7),
downloaded from `https://arxiv.org/pdf/1706.03762v7` into ignored `.work/corpus/`.
Observed PDF SHA-256:
`bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.
The PDF is not redistributed in Git or the portable package.

Comparison results (`out/pdfium-comparison/`):

- Pages 3 and 4, 96 and 144 DPI, PDFium normal/LCD and the baseline's
  `sumatrapdf-tool draw -A 8` (MuPDF 1.28.5). Matching page pixel dimensions.
- PDFium normal and LCD PNGs are byte-identical in these four comparisons.
- Full pages were visually inspected for body text, fractions, subscripts,
  Greek symbols, vector diagrams and thin lines. No missing formula glyphs or
  displaced content was observed on these pages. This is limited visual evidence,
  not a broad correctness or readability score.
- Normal text appearance differs subtly. A native-display human review at the
  reader's preferred zoom is still needed to choose a rendering preference.
- PNG probe runs report initialization, document/page loading, render samples,
  PNG encoding and process memory separately. Runs varied substantially with
  machine load; raw JSON is retained. For example, the first isolated 144-DPI
  page-3 trial rendered in 26.1 ms, then 16.9–23.2 ms; later runs were slower.
- MuPDF CLI timings include its own I/O/encoding and its memory counters are
  allocator counters. They are **not directly comparable** to the probe's
  render-only time or Windows process counters. Use the UI comparison below.
- Chrome/Edge pixel output was **not measured**. A headless Edge 155 screenshot
  attempt returned an empty gray image, so it was excluded rather than treated
  as a PDF rendering comparison. Chromium's
  [PDFium engine source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/pdf/pdfium/pdfium_engine.cc)
  uses LCD flags but also different bitmap/compositing and form rendering paths.
  Sharing PDFium does not establish identical browser output.

## Phase 3: integration and validation

Build/test commands:

```powershell
. ./tools/solokpdf/env.ps1 -Toolset v145
bun cmd/solok-build.ts -dbg
$env:SUMATRA_TEST_EXE = "$PWD/out/solokpdf-dev/SolokPDF.exe"
bun tests/ad-hoc-pdfium.ts --no-build
Remove-Item Env:SUMATRA_TEST_EXE
./out/solokpdf-dev/SolokPDF.exe -for-testing paper.pdf
$env:SOLOKPDF_ENGINE = 'mupdf'
./out/solokpdf-dev/SolokPDF.exe -for-testing paper.pdf
Remove-Item Env:SOLOKPDF_ENGINE
```

The wrapper regenerates official projects with `--with-pdfium`. Ordinary
`bin/premake5.exe vs2022` regenerates the upstream configuration. Generated
projects should not be hand-edited or relied on as the source of the option.
`cmd/run-unit-tests.ts` also regenerates **without** this option: it is the
upstream unit baseline, not the PDFium build/test entry point. Use the targeted
test above after `solok-build.ts`; `--no-build` prevents the common test runner
from replacing the experimental build with an upstream one.

Implementation details:

- All PDFium calls, initialization, document/page close and shutdown share one
  process-wide mutex. PDFium is dynamically loaded only when selected.
- File handle and custom reader outlive the document. Pages/text pages/render
  handles are closed after each operation; no second engine's PDF is retained.
- Existing cache owns BGRA pixmaps; progressive render pause callbacks consume
  an atomic AbortCookie. Queued cancellation is checked after acquiring the
  mutex; render-close precedes page-close. No detached PDFium worker is added.
- Existing EngineBase reference counting and RenderCache close synchronization
  govern lifetime. Text extraction has one UTF-8 codepoint/rectangle pair.
- CropBox/intrinsic rotation are normalized through PDFium's coordinate API;
  view rotation uses the existing engine transform. Coordinate quantization
  is below 0.01 point in the targeted fixture.
- Owned page links, cached named destinations and bounded bookmark trees use
  existing destination/TOC types. The UI and Tab Groups implementation are reused.
- The DLL stays mapped for the process lifetime to avoid loader churn; PDFium
  global state shuts down when its last engine closes.

`tests/ad-hoc-pdfium.ts` passed on the renamed portable debug executable:

- Synthetic two-page fixture with offset CropBoxes, intrinsic 90-degree
  rotation, named/internal destination, URI link and bookmark.
- Win32 page display and screenshot, zoom, additional rotation, text search,
  text selection geometry, view/print bitmap generation, bookmark navigation,
  Back/Forward command path (the commands bound to Alt+Left/Right).
- Two tabs saved using the Tab Groups dialog, closed and restored in the same
  process. Cross-process persistence is not covered by this test.
- Close with pending high-zoom render requests; normal process shutdown.
- Malformed PDF rejected without a crash; missing PDFium DLL reports the
  attempted path/Windows error and MuPDF fallback still finds the fixture text.
- An isolated `SumatraPDF-settings.txt` sentinel stays unchanged.

The test uses `-for-testing` and isolated appdata, and never kills unrelated
SumatraPDF processes. High-DPI virtual control testing needs
`setProcessDpiAware()`; without it, coordinates and captures were clipped and
Tab Groups clicks missed their controls. The application itself was unchanged.
An early ownership error (`defaultExt` was a literal rather than owned memory)
was caught by this test and corrected; it now exercises engine destruction.

## Phase 4: measured baseline, optimization incomplete

Run `bun experiments/pdfium/benchmark-ui.ts <pdf>` after both builds exist.
Raw samples are checked in as `docs/solokpdf-benchmark-2026-10-24.json`.

Machine: Windows 10.0.26300 / 26H2, Intel i7-1260P, 16 logical processors,
15.7 GiB RAM. Debug x64, v145, same 900×1000 requested window, 100% zoom,
same PDF, fresh identical isolated settings, warm OS file cache. Three process
launches per configuration and PDF-tab count. Application PDBs were temporarily
unavailable for **all** variants to avoid asymmetric debugger symbol memory;
the script restores them in `finally`. Shared DLLs and their PDBs are unchanged.
The first exploratory run with unequal PDB conditions was superseded.

Medians (MiB = 1,048,576 bytes):

| Configuration    | PDF tabs | Process start → first render idle, ms | Page 4 request → idle, ms | 12 scroll lines → idle, ms | Private Bytes after all tabs visited, MiB | Working set, MiB |
| ---------------- | -------: | ------------------------------------: | ------------------------: | -------------------------: | ----------------------------------------: | ---------------: |
| Original MuPDF   |        1 |                                 670.7 |                      79.6 |                      632.1 |                                      87.3 |            119.7 |
| Original MuPDF   |        4 |                                 846.1 |                      72.7 |                      458.8 |                                     117.7 |            168.8 |
| SolokPDF, MuPDF  |        1 |                                 652.0 |                      82.9 |                      455.9 |                                      87.3 |            120.6 |
| SolokPDF, MuPDF  |        4 |                                 791.7 |                      83.6 |                      463.0 |                                     113.0 |            164.1 |
| SolokPDF, PDFium |        1 |                                 907.3 |                      53.0 |                      463.6 |                                      98.7 |            123.6 |
| SolokPDF, PDFium |        4 |                                1228.2 |                      55.9 |                      466.3 |                                     148.0 |            173.0 |

These are request-to-idle measurements, including control transport, layout,
render scheduling and polling. They are not raw render time, empty-window
startup, input-to-photon latency or a cold boot benchmark. The scroll batch is
dominated by UI/polling overhead and does not establish smoother scrolling.
Counters cover the entire process, not engine allocations or cache ownership.
Non-active cache bytes and cache eviction sensitivity were not separately
instrumented. Three samples and one paper do not establish general performance.

PDFium navigates faster in this fixture but starts slower and uses more private
memory. The lightweight objective is **not achieved yet**. The implementation
already uses lazy file reads and short-lived PDFium page handles, renders into
the final Pixmap buffer, reuses upstream tile/text caches, and bounds output
allocations. No speculative cache tuning was applied. Next: larger math/scan
corpora, page/font/cache profiling and cancellation latency.

### Release comparison (2026-10-25)

Run `bun experiments/pdfium/benchmark-ui.ts --release <pdf>`. Same settings,
machine, three runs and counter definitions as above, using the same optimized
SolokPDF executable with the two engine choices. No unmodified upstream Release
binary was built; these numbers must not be compared against the Debug baseline
as an engine-only change. Raw data:
`docs/solokpdf-benchmark-release-2026-10-25.json`.

| Release engine | PDF tabs | First render idle, ms | Page 4 → idle, ms | 12 scroll lines → idle, ms | Private Bytes, MiB | Working set, MiB |
| -------------- | -------: | --------------------: | ----------------: | -------------------------: | -----------------: | ---------------: |
| MuPDF          |        1 |                 698.3 |              60.3 |                      483.5 |               85.3 |            115.5 |
| MuPDF          |        4 |                 930.5 |              51.0 |                      480.3 |              105.3 |            154.6 |
| PDFium         |        1 |                1047.6 |              54.9 |                      472.4 |              104.6 |            127.4 |
| PDFium         |        4 |                1622.2 |              55.1 |                      456.8 |              138.4 |            161.5 |

There is no established Release navigation-speed win: the difference is small
and changes direction at four tabs. PDFium startup and private memory remain
higher. Next work should profile document/outline destination loading, font
caches and serialization costs before changing cache policy. The current code
eagerly loads a target page to normalize bookmark coordinates; deferring that
until navigation is a profiling candidate, not a measured fix.

## Phase 5: portable development identity

Both Debug and Release builds completed and passed the targeted GUI validation.
Release produced `out/solokpdf-portable/SolokPDF.exe` (14,285,312 bytes). This host
initially denied file reads/process creation (`EPERM`/access denied) after the
build; a later retry succeeded without security or ACL changes. The cause is
unresolved. Logs: `out/solok-release-retry.log`,
`out/pdfium-release-gui-test.log`. Debug and Release measurements are separated
above.

Portable packages are `out/SolokPDF-experimental-x64.zip` (Release) and
`out/SolokPDF-experimental-debug-x64.zip` (Debug), excluding PDBs, settings/history
and downloaded PDFs. The debug executable is 26,628,096 bytes; PDFium DLL is
7,586,816 bytes. Archives contain dependencies, documentation and notices.
The extracted package is additionally checked for default PDFium document
display/search and normal shutdown, without relying on a PDB or a source tree.

- `kAppName` and executable identity change only with `SOLOKPDF_PDFIUM`.
  The underlying upstream target name remains for a small build-system diff;
  the staging wrapper names the runnable application `SolokPDF.exe`.
- `SolokPDF-settings.txt`, local `SolokPDF` / `SolokPDF-data`, instance-map and
  DDE service names are separate. Existing settings are not migrated or overwritten.
- Upstream binary update checks are disabled for this fork. Installer and file
  associations are not configured or validated; use the portable application.
- Copyright/license files remain unchanged. The package includes root notices,
  vendored license files and all PDFium `licenses/` texts plus the pin manifest.
  MuPDF and its AGPL obligations remain because the fallback/library remain.
- No binary, downloaded PDF, build cache, PDB or archive is added to Git.

## Known limitations and next work

- PDFium currently handles ordinary file-backed PDFs. Stream/data factories,
  shell preview/filter DLLs and PDFs generated inside other document engines
  retain their upstream paths. Files above 4 GiB fall back.
- Password UI, page labels, automatic URL detection, PDF link Contents tooltips,
  remote-file/embedded links, non-XYZ Fit destinations, initial OpenAction and
  some permissions metadata remain incomplete.
- Interactive forms/widgets, JavaScript/XFA, annotation editing, signatures,
  attachments, PDF editing/merging and advanced object-level dark rendering
  need PDFium implementations. Unsupported features are reported in document
  properties; MuPDF is the explicit compatibility route. Basic annotation
  appearances are rendered, but form widget appearances are not promised.
- View tiles use integer page extents; fractional-zoom tile seams, arbitrary
  UserUnit/page-box combinations and rotated text selection need broader tests.
- Normal rendering is opaque white. The transparency-grid path uses alpha;
  full transparent-page compositing parity and advanced dark-mode parity are
  not established.
- Print **bitmap generation** passed. Physical printers, print dialogs,
  spooler behavior and export workflows were not comprehensively tested.
- Tab Groups in-process save/restore passed. Disk persistence, restart/session
  recovery, inactive-tab cache accounting and long-run leak stress remain.
- Chrome/Edge comparisons and broad malformed-PDF fuzzing
  remain. A passing close stress check is not an exhaustive proof against races.
- The existing clipboard unit-test failure was observed on the unchanged baseline;
  its cause is unresolved. The complete unit suite is not green. No tests were
  removed or disabled.
- Saving file data after the original path is renamed/deleted is not
  implemented by the new engine yet. Its open file handle also does not share
  in-place writes; producer/reload workflows need further work.

The first development milestone (native build, PDFium pages in the original
UI, MuPDF comparison, reproducible steps and explicit gaps) has been reached.
Full feature/performance parity and release readiness have not been reached.
