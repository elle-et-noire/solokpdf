# SolokPDF development log

## Current priority and handoff

The move to PDFium is for its current text appearance: the user wants to avoid
MuPDF's thinner-looking text. Preserve PDFium's font selection, antialiasing,
render resolution and color processing. Do not switch the default to MuPDF to
meet memory/startup targets. Font-info v2 remains probe-only because it changes
rendered output.

Opaque views now use an identity gray palette when every rendered pixel is
opaque and R=G=B; other opaque views use BGR. PDFium still renders unchanged BGRA.
The accepted Phase 4 pass keeps row-level cancellation and rejects already-canceled
allocations. A size-cache candidate was rejected for higher large-tile peaks.
The 2026-10-25 single-buffer trial was also rejected: its large-tile savings came
with a light-wide CPU regression and slower group restoration. Its measurements
remain in `solokpdf-phase4-ownership-2026-10-25.json` and the tab-group reports.

The tab-group pass has four qualifying pairs each for 4/8/16 tabs. Restore peaks
fell 2–3 MiB at 4/8 tabs and 13.4 MiB at 16; active-ready time rose in all
three sets. The 16-tab rerun excludes one high-load pair. The render-buffer
trial is rejected for general use, including its light-wide CPU regression.
See `solokpdf-tabgroup-2026-10-25.json` and
`solokpdf-tabgroup-16-idle-2026-10-25.json`.

Resume from `solokpdf-dev` after reading `agents.md`, `readme.md` and this file.
The 2026-10-26 pass adds pixel-payload accounting and independent background-load
monitoring. Its render-gate trial is deferred: a qualifying light-wide comparison
used 10.4% more CPU with unchanged wall time. The active source retains pretrial
rendering. Release/Debug folders and ZIPs were refreshed and checked. Evidence:
`solokpdf-memory-2026-10-26.json`. The frozen pretrial Release remains
`out/solok-finish-after-release/SolokPDF.exe`; the rejected older trial stays at
`out/solok-ownership-after-release/SolokPDF.exe`. General resident-memory and
startup improvements remain unestablished.

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
caches and serialization costs before changing cache policy. At `48eb0f96a`,
bookmark coordinate normalization eagerly loaded the target page.

### Deferred destination coordinates (2026-10-25)

`EnginePdfium.cpp` now copies destination page/coordinates/zoom without loading
the target page's content. `GetRect()` normalizes coordinates on first use and
caches the result under the existing PDFium mutex. No PDFium destination handle
is retained. Rendering, text and tile cache policy are unchanged.

Compared the Release executable from `48eb0f96a` with this change, using identical
PDFium/MuPDF DLLs. Same machine, PDF, requested window, zoom, isolated settings,
warm file cache and PDB exclusion as above. Two rounds of three launches per
variant/tab count; variant order reverses in each round's middle run. No build
ran during measurement. Raw samples, PDF/executable/DLL hashes and round numbers:
`docs/solokpdf-benchmark-lazy-dest-2026-10-25.json`.

Keep the before executable/PDB under `out/solok-phase4-baseline/`, with the same
DLLs as the current portable build, then run:

```powershell
bun experiments/pdfium/benchmark-ui.ts --release --before out/solok-phase4-baseline/SolokPDF.exe --output out/solok-phase4-paired
bun experiments/pdfium/benchmark-ui.ts --release --before out/solok-phase4-baseline/SolokPDF.exe --output out/solok-phase4-paired-repeat
```

Medians of six launches per row; MiB uses process counters:

| Release engine        | PDF tabs | First render idle, ms | Private Bytes at first idle, MiB | Private Bytes after all tabs visited, MiB | Working set after all tabs visited, MiB |
| --------------------- | -------: | --------------------: | -------------------------------: | ----------------------------------------: | --------------------------------------: |
| Before PDFium         |        1 |                1606.0 |                             97.8 |                                     100.9 |                                   124.7 |
| Deferred PDFium       |        1 |                1594.2 |                             96.6 |                                     100.5 |                                   124.4 |
| Before PDFium         |        4 |                2023.2 |                            136.9 |                                     150.2 |                                   174.2 |
| Deferred PDFium       |        4 |                1972.3 |                            134.6 |                                     141.5 |                                   165.6 |
| Current MuPDF control |        1 |                1263.1 |                            103.1 |                                     107.6 |                                   142.6 |
| Current MuPDF control |        4 |                1467.4 |                            123.4 |                                     109.8 |                                   164.1 |

Four-tab private memory after visiting all tabs fell in both rounds
(152.6→141.5 and 147.8→141.4 MiB). The combined median fell 8.7 MiB (5.8%).
One-tab savings are small. Startup timings overlap; the one-tab difference
reversed in round two. These data do not establish a startup-speed improvement.
Page-4 request medians were 46.8→49.1 ms (one tab), 48.7→48.5 ms (four tabs).
PDFium still starts slower than the MuPDF control and uses more private memory
at four tabs. One paper and six launches do not establish general performance.

The expanded `tests/ad-hoc-pdfium.ts` passed before and after in Release and
after the change in Debug,
including the actual deferred TOC-click path, cropped/rotated link coordinates,
search/selection, view/print bitmap generation, history, Tab Groups and close
with pending renders. The benchmark's before/after page-4 screenshots are
byte-identical and were visually inspected. This is limited regression evidence.

Debug and Release builds passed with zero warnings/errors. Fresh executables
initially rejected reads/launches; Debug also hit `LNK1104` on output DLLs/exe.
Retries passed without ACL/security changes. Logs:
`out/solok-phase4-build-{debug,release}.log`,
`out/solok-phase4-test-{debug,release}.log`. Next: profile page/font retention and
test larger math/scan corpora before another cache or startup change.

### Font-loading diagnosis (2026-10-25)

This iteration adds diagnostics; it adopts no new rendering/font policy.
Raw measurements and hashes: `docs/solokpdf-profile-2026-10-25.json`.

`experiments/pdfium/make-corpus.ts` verifies the original paper's hash and creates
two ignored fixtures: 20 copies merged into 300 vector pages (39.5 MiB), and all
15 pages rasterized at 144 DPI in grayscale (2.5 MiB). They exercise size and
image paths, not independent papers, font diversity or real scans. The merged
document's outline differs from the source. Vector regeneration changed bytes
despite the writer's `reproducible` option; exact measured copies were restored
from the benchmark output and their hashes retained. Never regenerate inputs
between compared variants.

Release baselines use the `c80d298c4` implementation, unchanged since the previous
iteration. Same requested window, zoom, settings, warm file cache and PDB
exclusion; three launches per row, fixed MuPDF→PDFium order. These are exploratory
baselines, not before/after optimization results.

| Derived fixture   | Engine | Tabs | First render idle, ms | Private Bytes after all tabs visited, MiB |
| ----------------- | ------ | ---: | --------------------: | ----------------------------------------: |
| Vector, 300 pages | MuPDF  |    1 |                1853.3 |                                      93.0 |
| Vector, 300 pages | PDFium |    1 |                2071.8 |                                     117.2 |
| Vector, 300 pages | MuPDF  |    4 |                2210.9 |                                     126.5 |
| Vector, 300 pages | PDFium |    4 |                2700.9 |                                     172.6 |
| Raster, 15 pages  | MuPDF  |    1 |                1629.3 |                                      97.8 |
| Raster, 15 pages  | PDFium |    1 |                1634.9 |                                      97.4 |
| Raster, 15 pages  | MuPDF  |    4 |                2272.1 |                                     129.3 |
| Raster, 15 pages  | PDFium |    4 |                2034.9 |                                     135.3 |

`SOLOKPDF_PROFILE=1` now enables per-phase logs in `EnginePdfium.cpp`.
`experiments/pdfium/profile-ui.ts` opens each supplied PDF and visits page 4,
the middle, the last page and page 1, recording memory and logs. These Debug
diagnostics retain PDBs and logging; their process counters/times are not
comparable to the Release table.

For the original paper and 300-page fixture, the first page load took 368.8 and
352.6 ms, while bitmap rendering took 8.9 and 7.5 ms. Another renderer waited
384.9 ms on the PDFium mutex in the original-paper run. The raster first-page
load took 2.1 ms. No text-extraction calls appeared during these diagnostic
launches; per-character coordinate conversion was left unchanged.

The paper's first page has an unembedded Times-Roman font. The pinned SDK offers
[per-request system font matching](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_sysfontinfo.h)
(`FPDF_SYSFONTINFO.version=2`), which skips full font enumeration. This is an
experimental API. `pdfium-render.exe --font-info-v2` tests it only in the
standalone probe; the application does not enable it.

`experiments/pdfium/font-check.ts` compares both modes in three rounds, reversing
their order in the middle round. Paper-page-1 load medians fell 262.2→3.7 ms;
page-1/page-4 PNGs matched in all rounds. A generated fixture with the 14 standard
fonts and 16 unembedded TrueType font names/aliases changed nine rows every time:
Calibri, Calibri-Bold, Cambria, CambriaMath, Consolas, SegoeUI, SegoeUI-Bold,
Meiryo and MS-Gothic. The fixture uses Latin text, not Japanese glyph coverage.
The script intentionally exits nonzero on a rendering difference. This candidate
was rejected; the speedup is not an application startup improvement.

The diagnostic Debug build passed with zero warnings/errors. The existing
`tests/ad-hoc-pdfium.ts` passed with profiling disabled and enabled. The optimized
standalone probe also built successfully. Output-file `LNK1104` failures cleared
on retries without ACL/security changes. Logs: `out/solok-phase4-profile-build.log`,
`out/solok-phase4-profile{,-enabled}-test.log`, `out/solok-phase4-font-check.log`.
Next: preserve font-name/style matching while reducing enumeration work, and
attribute the vector-document memory gap before changing cache policy.

### Opaque view bitmap storage (2026-10-25)

PDFium still renders into BGRA with the same fonts, LCD/annotation flags,
resolution and colors. After rendering, opaque view bitmaps are packed to BGR
in place and their allocation is shrunk. RGB bytes are unchanged; rows retain
DWORD alignment. Print and transparent-background bitmaps retain BGRA. Cache
policy and render requests are unchanged.

Shrinking bypasses cache-trimming hooks under the PDFium mutex. If shrinking
fails, the original allocation retains valid compacted pixels. The existing
test helper now copies BGR/RGBA heap images to BGRA for inspection.

Release comparison against `bd4dd4a9c`, with identical DLL hashes, PDFs and
fresh settings; no builds or other tests ran during these final measurements.
Same machine as above, requested 900x1000 window, measured frame DPI 120,
warm file cache and application PDBs temporarily hidden. Two rounds of three
launches per variant/input/tab count; order alternates within each round and
starts in the opposite order in round two. Raw counters, hashes, timings and
pixel comparisons: `docs/solokpdf-memory-2026-10-25.json`.

The workload visits pages 1/4, uses 25/50/100/200/400% zoom, scrolls, toggles
transparency, visits all tabs, then repeats zoom/cancellation and closes tabs
with a pending render. Memory snapshots wait 500 ms after visible render idle;
this does not prove all predictive work is finished. Peaks are sampled whole-
process Private Bytes, with polling requested every 5 ms from control connection.
Synchronous UI calls can delay polling, so short peaks may be missed. These
results are not comparable to the earlier, shorter benchmark workload.

Medians of six launches per row, MiB:

| Fixture           | Tabs | Private Bytes after tab visits, before → after | Sampled peak Private Bytes, before → after |
| ----------------- | ---: | ---------------------------------------------: | -----------------------------------------: |
| Paper             |    1 |                                  123.5 → 119.1 |                              177.1 → 167.1 |
| Paper             |    4 |                                  170.0 → 151.2 |                              207.4 → 196.0 |
| Vector, 300 pages |    1 |                                  131.2 → 132.3 |                              183.9 → 175.9 |
| Vector, 300 pages |    4 |                                  188.4 → 173.3 |                              241.2 → 226.6 |
| Raster, 15 pages  |    1 |                                  122.1 → 105.6 |                              164.7 → 157.9 |
| Raster, 15 pages  |    4 |                                  155.4 → 158.5 |                              201.6 → 191.0 |
| Font aliases      |    1 |                                  134.3 → 129.3 |                              174.6 → 171.5 |
| Font aliases      |    4 |                                  153.7 → 146.0 |                              202.0 → 192.4 |

Four-tab peak medians fell in both rounds for all four inputs; combined savings
are 4.7–6.1%. Post-tab snapshots are not uniformly lower. Four-tab switch-to-idle
medians (ms) were paper 57.8→74.1, vector 76.1→76.7, raster 65.2→70.3 and fonts
42.7→46.1. Packing adds CPU work; these samples show a tab-switch latency cost.
Zoom/cancel median changes across all rows range from -4.4 to +8.6 ms, with
outliers on both sides. Startup/tail-latency improvements are not established.

All 72 image pairs have matching dimensions, pixels and PNG hashes: 64 pairs
from two corpus rounds and eight from the generated odd-width/color/alpha/
rotation fixture. Math, diagrams, standard fonts and aliases are covered;
the alias fixture uses Latin text, not Japanese glyph coverage. Representative
math and transparent images were visually inspected. This remains one paper
and derived/synthetic fixtures, not broad PDF compatibility evidence.

Both final builds passed with zero warnings/errors. `tests/ad-hoc-pdfium.ts`
passed in Release and Debug, including search/selection, cropped/rotated links,
TOC, view/print bitmap generation, history, Tab Groups and pending-render close.
Logs: `out/solok-memory-bgr-final-build-{debug,release}.log` and
`out/solok-memory-final-test-{debug,release}.log`. Earlier PE/PDB access failures
required retries/output backups; no ACL or security settings were changed.

Reproduce with the frozen inputs and the saved before/after executables:

```powershell
$memoryPdfs = @('.work/corpus/attention-1706.03762v7.pdf',
    '.work/corpus/phase4/attention-vector-300.pdf',
    '.work/corpus/phase4/attention-raster-15.pdf',
    'out/solok-phase4-font-check/fonts.pdf')
bun experiments/pdfium/memory-ui.ts --before out/solok-memory-before/SolokPDF.exe --after out/solok-memory-final-release/SolokPDF.exe --output out/solok-memory-final-paired @memoryPdfs
bun experiments/pdfium/memory-ui.ts --before out/solok-memory-before/SolokPDF.exe --after out/solok-memory-final-release/SolokPDF.exe --reverse --output out/solok-memory-final-repeat @memoryPdfs
bun experiments/pdfium/make-memory-fixture.ts
bun experiments/pdfium/memory-ui.ts --before out/solok-memory-before/SolokPDF.exe --after out/solok-memory-final-release/SolokPDF.exe --runs 1 --output out/solok-memory-final-edge out/solok-memory-fixtures/odd-rgb-alpha.pdf
```

A prior render-buffer serialization trial was rejected: memory gains were not
consistent. It is absent from the final code. Its exploratory data are in
`docs/solokpdf-memory-lock-trial-2026-10-25.json`; its first launch overlapped a
functional check and its workload differed, so do not combine it with the
accepted comparison. Next: independent PDFs, inactive-tab/font retention and
larger-tile cancellation costs.

### Lossless gray view bitmap storage (2026-10-25)

After the same PDFium BGRA rendering, opaque view tiles whose every pixel has
R=G=B and A=255 use an 8-bit identity-palette DIB. Each gray level maps to its
original RGB triplet. One differing channel keeps the existing BGR path;
print and transparent images retain BGRA. Fonts, flags, resolution, colors,
render requests and cache policy are unchanged. Allocation failure retains the
original bitmap. The native storage helper lives in `base/Pixmap.cpp` and runs
without cache-trimming hooks under the PDFium mutex.

Compared the Release executable from `e258f5944` with this change, using the same
rebuilt DLLs on both sides. DLL/PDF/executable/source hashes, counters and image
comparisons: `docs/solokpdf-memory-gray-2026-10-25.json`. Frozen inputs and workload
match the previous storage experiment: 1/4 tabs, pages 1/4, 25/50/100/200/400%
zoom, scrolling, transparency, tab visits, zoom cancellation and pending-render
close. Two rounds of three launches per variant/input/tab count, alternating
order and reversing the starting order in round two. Requested window 900x1000,
measured DPI 120, fresh settings, warm file cache and application PDBs hidden.
No build or other test ran during measurement.

Medians of six launches per row; before → after, MiB:

| Fixture           | Tabs | Private after tabs | Working set after tabs | Sampled peak Private | OS peak working set |
| ----------------- | ---: | -----------------: | ---------------------: | -------------------: | ------------------: |
| Paper             |    1 |       123.1 → 95.4 |          146.3 → 118.8 |        166.9 → 129.1 |       189.9 → 153.9 |
| Paper             |    4 |      137.0 → 118.8 |          160.4 → 142.3 |        185.5 → 142.1 |       208.7 → 173.7 |
| Vector, 300 pages |    1 |      113.7 → 110.8 |          137.1 → 134.0 |        170.4 → 142.9 |       193.6 → 166.4 |
| Vector, 300 pages |    4 |      168.2 → 150.0 |          191.7 → 173.6 |        218.8 → 178.2 |       242.6 → 210.1 |
| Raster, 15 pages  |    1 |       102.5 → 86.6 |          125.2 → 109.4 |        150.8 → 112.2 |       176.3 → 135.7 |
| Raster, 15 pages  |    4 |      147.9 → 112.8 |          170.6 → 135.6 |        185.1 → 125.1 |       207.8 → 147.9 |
| Font aliases      |    1 |      120.1 → 115.9 |          143.1 → 139.0 |        162.5 → 136.8 |       185.3 → 159.9 |
| Font aliases      |    4 |      140.4 → 124.6 |          163.7 → 147.7 |        184.7 → 153.4 |       207.8 → 177.1 |

Four-tab post-visit working sets fell 15.9–35.0 MiB (9.5–20.5%), in both rounds
for all four inputs. One-tab vector snapshots reversed between rounds:
137.1→126.8 and 137.0→145.2 MiB. Post-visit savings are not uniform. Small edge
fixtures have only one launch per variant; they establish no memory benefit.
Native DIBs change allocation type, so Private Bytes alone do not measure total
memory savings. Working sets also exclude some kernel costs. OS peak working
sets are cumulative peaks observed before exit; Private peaks use requested
5 ms polling and can miss short allocations during synchronous UI calls.

Four-tab switch-to-idle medians (median per launch, then across six launches)
were paper 52.4→55.5 ms, vector 54.0→54.8, raster 54.3→54.0 and fonts 37.4→36.6.
Zoom/cancel median changes across all rows range from -5.5 to +9.9 ms. One-tab
paper pending-close median increased 87.7→108.3 ms. These data establish no
general startup, close or tail-latency improvement.

All 80 image pairs match dimensions, pixels and PNG hashes: 64 corpus pairs and
16 edge pairs. The new fixture covers 256 gray levels, a one-channel difference,
odd widths and rotation; the existing fixture covers color and alpha. Math,
diagrams, font aliases and gray gradients were visually inspected. The corpus
remains one paper plus derived/synthetic inputs; alias text is Latin, not
Japanese glyph coverage.

`tests/ad-hoc-pdfium.ts` passed with the matched-DLL baseline, three consecutive
Release runs and Debug. A focused harness ran the new gray round-trip/rejection
test plus existing palette/BGR/BGRA tests: 210 checks, zero failures. Full unit
suites were not run. Both final builds passed with zero warnings/errors.
Logs: `out/solok-gray-build-release-final.log`,
`out/solok-gray-build-debug-retry3.log`, `out/solok-gray-test-*-final*.log`,
`out/solok-gray-focused-elevated.log`. PE reads/launches and Debug links needed
retries/output backups, without ACL/security changes. An earlier GUI check
overlapping a build timed out in the missing-DLL fallback; standalone repeats
passed. The access failures and timeout causes remain unresolved.

Reproduce with the frozen inputs and saved executables (do not regenerate inputs
between variants):

```powershell
$grayPdfs = @('.work/corpus/attention-1706.03762v7.pdf',
    '.work/corpus/phase4/attention-vector-300.pdf',
    '.work/corpus/phase4/attention-raster-15.pdf',
    'out/solok-phase4-font-check/fonts.pdf')
bun experiments/pdfium/memory-ui.ts --before out/solok-gray-before/SolokPDF.exe --after out/solok-gray-after-release/SolokPDF.exe --output out/solok-gray-paired @grayPdfs
bun experiments/pdfium/memory-ui.ts --before out/solok-gray-before/SolokPDF.exe --after out/solok-gray-after-release/SolokPDF.exe --reverse --output out/solok-gray-repeat @grayPdfs
bun experiments/pdfium/make-gray-fixture.ts
bun experiments/pdfium/memory-ui.ts --before out/solok-gray-before/SolokPDF.exe --after out/solok-gray-after-release/SolokPDF.exe --runs 1 --output out/solok-gray-edge out/solok-memory-fixtures/gray-near-gray.pdf out/solok-memory-fixtures/odd-rgb-alpha.pdf
```

Next: independent PDFs, long-lived GDI resource counts and larger-tile
cancellation before changing font or cache policy.

### Independent documents, retention and cancellation (2026-10-25)

This continues `d7fd279f3` without changing the application. The same frozen
Release executables and DLLs from the gray-storage comparison are reused;
their hashes and the current engine/pixmap source hashes match the prior record.
Only measurement helpers and fixtures change. Fonts, rendering and cache policy
remain unchanged.

The additional independent inputs are [BERT](https://arxiv.org/pdf/1810.04805)
and IPA's Japanese [2026 organization guide](https://www.ipa.go.jp/security/10threats/omgdg50000008fi8-att/kaisetsu_2026_soshiki.pdf).
Downloaded PDFs remain under `.work/corpus/independent/`, outside Git. Freeze
their SHA-256 values before comparing builds; an unversioned URL may change.
These add real Japanese text and another paper, not broad compatibility coverage.
The IPA file has 64 pages; its font scan lists MS-Gothic, MS-PGothic and
MS-Mincho subsets among 18 fonts. View comparisons primarily cover pages 1/4,
not every font/page or unembedded CJK substitution. Japanese body text and the
BERT page-4 view were also visually inspected.

The standard workload uses the same requested 900x1000 window and measured
120 DPI as before. Two rounds of two launches per variant/input/tab count,
alternating order and reversing the starting order in round two. Fresh settings,
identical DLLs, warm file cache and application PDBs hidden for both variants.
No build or other GUI test ran concurrently. Machine load and OS memory pressure
were not fixed. Medians across four launches, BGR → gray, MiB:

| Input | Tabs | Private after visits | Working set after visits | Sampled peak Private |
| ----- | ---: | -------------------: | -----------------------: | -------------------: |
| BERT  |    1 |        108.4 → 125.3 |            134.4 → 149.1 |        154.1 → 152.8 |
| BERT  |    4 |        147.2 → 150.8 |            173.1 → 175.1 |        180.4 → 184.8 |
| IPA   |    1 |        111.9 → 112.1 |            138.2 → 135.8 |        150.6 → 127.2 |
| IPA   |    4 |        194.4 → 179.5 |            220.6 → 203.7 |        222.1 → 189.4 |

IPA four-tab post-visit working sets and sampled peaks fell in both rounds.
BERT four-tab working sets and peaks reversed direction between rounds;
one-tab BERT working sets rose in both. Gray storage does not establish a
general process-memory reduction. All 32 view comparisons match.
Four-tab switch medians were BERT 56.3→54.2 ms and IPA 67.7→63.9 ms;
zoom/cancel medians were 385.8→390.5 and 381.8→384.3 ms. One BERT gray
pending-close sample took 499.3 ms; no tail-latency improvement is established.

`memory-ui.ts` now records current/peak GDI and USER counts at lifecycle
snapshots, supports mixed-document tabs and a timed hold, and verifies pixels
after holding and reactivating tabs. Its idle responses record actual viewport,
zoom, tile resolution and cache limits. Private Bytes polling remains 5 ms
during activity and changes to 1000 ms during the hold. Synchronous UI calls
can delay polling. Native DIB/kernel costs remain incompletely accounted for.

The retention workload opens the original paper, BERT, the IPA guide and
`tests/issue-6101.pdf` in four separate tabs. After visiting each tab it holds
for 120 seconds, performs 24 cycles of four tab switches, then runs zoom
requests and closes all tabs. Snapshots include 500 ms and 5.5 seconds after
close. This bounds observation to minutes; it does not establish long-run
leak freedom or attribute retained memory to fonts.

Two launches per variant, alternating order; MiB and GDI counts:

| Variant / run | Private after visits → 120 s → reactivation → closed | Working set at 120 s | GDI at 120 s → reactivation → closed |
| ------------- | ---------------------------------------------------: | -------------------: | -----------------------------------: |
| BGR / 0       |                         123.1 → 120.3 → 121.7 → 84.1 |                145.4 |                      217 → 219 → 216 |
| Gray / 0      |                         141.9 → 117.7 → 119.1 → 83.9 |                140.4 |                      218 → 220 → 216 |
| Gray / 1      |                         139.2 → 116.7 → 119.1 → 84.3 |                141.7 |                      217 → 220 → 216 |
| BGR / 1       |                         121.6 → 119.3 → 121.5 → 84.1 |                140.1 |                      216 → 218 → 215 |

Closed values are 5.5 seconds after closing. Gray's immediate post-visit Private
Bytes are higher in both launches; by 120 seconds they are slightly lower.
The working-set direction reverses between runs. A single 500 ms snapshot is
insufficient to claim a retention improvement.

Across all 24 reactivation-cycle snapshots, GDI ranges were 219–219 / 220–220
in run 0 (BGR / gray), and 218–218 / 219–220 in run 1. USER counts stayed within
96–98; closed counts were 89–90. No growing resource trend appeared in this
bounded workload. No inactive-tab eviction or font-lifetime change was made.
All 15 comparisons matched: 11 cross-variant views and four within-variant
hold/reactivation checks. Per-launch reactivation medians were 41.4/43.3 ms
for BGR and 43.4/40.2 ms for gray; no redraw-latency benefit is established.

`make-wide-fixture.ts` creates two 14000x420-point pages (one with odd dimensions
and a small channel difference). Gray levels, text and 2000 diagonal paths
exercise large, shallow tiles. This is synthetic allocation/cancellation stress,
not another independent document. The `--large` workload includes settled
1600/6400% captures, alternates 100/1600/25% with 20 ms pauses and closes during
a new 100% request. Requests are cancellation pressure, not a count of confirmed
PDFium aborts.

The requested 2400x1800 window was constrained: recorded viewport at 100% was
839x1026, with a 1920x1200 cache tile limit. The shallow-page rule nevertheless
selected resolution 0 at render zoom 1.667: approximately 23334x700 pixels
(16.3 million) for page 1. High zoom used smaller tiles (resolution 6/8 at
1600/6400%). This is large-tile stress from aspect ratio, not a 4K-display test.

Two rounds of two launches per variant/tab count; medians, BGR → gray:

| Tabs | Post-visit working set, MiB | Sampled peak Private, MiB | Zoom requests → idle, ms | Pending close, ms |
| ---: | --------------------------: | ------------------------: | -----------------------: | ----------------: |
|    1 |               202.0 → 170.0 |             302.0 → 311.1 |          1660.4 → 1763.3 |     486.1 → 481.1 |
|    4 |               484.1 → 358.8 |             583.7 → 523.2 |          1644.8 → 1719.3 |     508.6 → 506.7 |

Post-visit working sets fell in both rounds for both tab counts. One-tab sampled
peaks rose in both rounds. Four-tab peak savings differed substantially between
rounds: 615.4→523.2 and 538.5→500.3 MiB. One-tab zoom/cancel medians increased
in both rounds (1510.0→1713.8 and 1779.8→1788.1 ms); four-tab direction reversed.
Pending close across both variants ranged 285.2–662.1 ms. The total workload
times include fixed command pauses and final rendering; they do not isolate
abort latency. All 20 view pairs match, including 1600/6400% captures. The
gray/line view was visually inspected.

All 52 final launches and 67 image comparisons completed. Counters, phase
summaries, executable/DLL/PDF/source hashes and image hashes are in
`docs/solokpdf-memory-extended-2026-10-25.json`; full polling samples and PNGs
remain under its `experiments[].path` directories. Earlier exploratory runs
(`out/solok-independent-preflight`, `out/solok-independent-paired`) are excluded:
the measurement helpers were still being extended. All temporarily hidden PDBs
were restored. No application rebuild, full unit suite or portable replacement
was needed for these diagnostic-only changes.

Reproduce with the frozen inputs and saved executables:

```powershell
$bgrExe = 'out/solok-gray-before/SolokPDF.exe'
$grayExe = 'out/solok-gray-after-release/SolokPDF.exe'
$extraPdfs = @('.work/corpus/independent/bert-1810.04805.pdf',
    '.work/corpus/independent/ipa-2026-soshiki.pdf')
bun experiments/pdfium/memory-ui.ts --before $bgrExe --after $grayExe --runs 2 --output out/solok-independent-final-paired @extraPdfs
bun experiments/pdfium/memory-ui.ts --before $bgrExe --after $grayExe --runs 2 --reverse --output out/solok-independent-final-repeat @extraPdfs
$mixedPdfs = @('.work/corpus/attention-1706.03762v7.pdf', $extraPdfs[0],
    $extraPdfs[1], 'tests/issue-6101.pdf')
bun experiments/pdfium/memory-ui.ts --before $bgrExe --after $grayExe --mixed --tabs 4 --runs 2 --hold 120 --cycles 24 --output out/solok-retention-paired @mixedPdfs
bun experiments/pdfium/make-wide-fixture.ts
bun experiments/pdfium/memory-ui.ts --before $bgrExe --after $grayExe --runs 2 --large --window 2400x1800 --output out/solok-wide-paired out/solok-memory-fixtures/wide-gray-color.pdf
bun experiments/pdfium/memory-ui.ts --before $bgrExe --after $grayExe --runs 2 --large --window 2400x1800 --reverse --output out/solok-wide-repeat out/solok-memory-fixtures/wide-gray-color.pdf
```

Next: measure an empty-window baseline and repeated open/close cycles, record
system memory pressure, and separate PDFium rendering from gray scanning/copying
and BGR packing. Investigate cancellation during postprocessing before changing
font matching, cache eviction or tile resolution. This run applies no further
memory optimization.

### Batched cancellation and retention pass (2026-10-25)

The accepted change stops work after cancellation: before bitmap allocation,
after page load/fill, and between rows of gray scanning/copying, BGR packing
and alpha conversion. Canceling gray conversion preserves the original pixmap
and deletes any partial DIB. Canceled BGR/alpha buffers are discarded. Normal
rendering, fonts, flags, resolution, colors and cache policy are unchanged.

The baseline adds only optional phase diagnostics and an unused cancellation
argument to `d7fd279f3`. Original artifacts remain in `out/solok-finish-before/`;
`out/solok-finish-before-matched/` combines its EXE/PDB with the same frozen DLLs
used by the accepted candidate. No preserved baseline or portable EXE was
overwritten. Accepted builds are `out/solok-finish-after-release/SolokPDF.exe`
and `out/solok-finish-after-debug/SolokPDF.exe`.

The new focused test failed first: 219 checks, six failures. After adding
cancellation it passed 222 checks with zero failures, including existing
palette/BGR/BGRA tests. Cases cover cancellation during gray scanning and DIB
copying, source preservation and GDI cleanup. Release and Debug built with zero
warnings/errors and passed `tests/ad-hoc-pdfium.ts`. Full unit suites were not
run; the earlier clipboard baseline failure remains unresolved.

Optional `SOLOKPDF_PROFILE=1` logs now separate geometry, allocation, lock wait,
page load, fill, drawing, close, alpha conversion, gray scan/allocation/copy and
BGR packing. In the dense wide-tile diagnostic baseline, large tiles had median
drawing time 130.3 ms, gray scanning 11.5 ms and BGR packing 17.7 ms. The first
page load reached 389.3 ms and a render-lock wait reached 569.6 ms. These are
phase wall times, including scheduling; they are not isolated CPU costs.

In the cancellation-only diagnostic, 29 requests were rejected before allocation:
1,408,043,768 bytes of requested BGRA storage in total. This counts avoided
requests, not peak/process memory savings. No mid-gray cancellation was observed
in that UI trace; the deterministic unit test covers it. Diagnostic logging is
excluded from performance aggregates.

For the accepted change, dense-wide medians across four launches per row;
before → after:

| Tabs | Sampled peak Private, MiB | OS peak working set, MiB | Zoom → idle, ms | Process CPU during zoom, ms | Pending close, ms |
| ---: | ------------------------: | -----------------------: | --------------: | --------------------------: | ----------------: |
|    1 |             311.3 → 280.1 |            310.9 → 310.8 | 1606.9 → 1770.7 |             1421.9 → 1578.1 |     491.1 → 491.6 |
|    4 |             461.1 → 476.0 |            499.1 → 498.9 | 1799.4 → 1643.3 |             1546.9 → 1445.3 |     490.7 → 463.6 |

Post-visit working sets were 170.6→170.4 and 359.7→359.2 MiB. These results
establish no general steady-memory, peak-memory or latency improvement. The
accepted scope is eliminating already-canceled allocations and bounding
postprocessing after cancellation. CPU counters are quantized; Private Bytes
polling can miss short peaks during synchronous UI calls.

An additional candidate published immutable page sizes under a separate mutex,
allowing cached layout reads without waiting for PDFium. It passed rendering
comparisons and GUI checks, but was rejected for higher peak memory:

| Workload   | Tabs | Sampled peak Private, MiB | OS peak working set, MiB | Zoom → idle, ms |
| ---------- | ---: | ------------------------: | -----------------------: | --------------: |
| Dense wide |    1 |             296.6 → 350.0 |            310.9 → 310.9 |  1609.8 → 668.5 |
| Dense wide |    4 |             500.1 → 538.9 |            492.0 → 499.1 |  1709.8 → 616.7 |
| Light wide |    1 |             314.6 → 338.3 |            305.7 → 298.0 |   568.8 → 575.4 |
| Light wide |    4 |             490.6 → 533.2 |            481.8 → 493.0 |   565.8 → 588.0 |

Dense rows use four launches per variant; light rows use two. Each has two
rounds with opposite starting orders. `make-cancel-fixture.ts` generates the
light fixture: large gray/near-gray tiles with little drawing work. Its pauses
are 35 ms; dense/standard workloads use 20 ms. Faster geometry may allow more
overlapping temporary buffers, but allocation ownership was not isolated.
The rejected source/artifacts remain under `out/solok-finish-final-{release,debug}`,
marked `REJECTED.txt`; their counters are kept separate. The working tree was
restored exactly to the accepted candidate's four C/C++ source hashes.

The lifetime workload starts empty, opens the original paper, BERT, the IPA
guide and font aliases, visits every tab, holds for 600 seconds, then performs
32 open/close cycles. A second pair of launches reverses the starting order
and repeats 32 cycles without a hold: 528 document opens/closes in four
processes. Each close snapshot waits 500 ms; the final empty snapshot waits
another five seconds. Counters include GDI/USER, process handles, CPU and OS
memory pressure. Held views matched their pre-hold pixels in all four launches.

| Variant / run | Hold, s | Empty Private start → final, MiB | Closed first 8 → last 8 median, MiB | Closed GDI range | Closed handle range |
| ------------- | ------: | -------------------------------: | ----------------------------------: | ---------------: | ------------------: |
| Before / 0    |     600 |                      80.9 → 85.9 |                         97.8 → 90.8 |          249–251 |             696–696 |
| After / 0     |     600 |                      81.7 → 85.6 |                       102.9 → 103.0 |          250–250 |             692–696 |
| After / 1     |       0 |                      81.6 → 86.0 |                         94.3 → 94.2 |          251–253 |             703–715 |
| Before / 1    |       0 |                      81.8 → 86.2 |                         94.9 → 91.4 |          251–257 |             703–715 |

At 600 seconds, Private Bytes were 150.7/150.6 MiB (before/after). Final GDI
counts were 248–249. Final handles remained 37–50 above cold startup; no
increasing per-cycle trend appeared. OS load ranged 75–85%, so small memory
differences are not attributable to the change. PDFium's DLL and render workers
remain for the process lifetime by design; the rest of the warm/cold difference
was not attributed. Minutes and 32 cycles do not prove leak freedom over hours.

Final accepted-candidate comparisons use the original paper, independent BERT
and IPA documents, the font-alias fixture and the derived raster PDF. Two rounds
of two launches per variant/input/tab count, reversing the starting order;
requested 900x1000, measured 120 DPI, matched DLLs, fresh settings, application
PDBs hidden and warm file cache. No application build or other GUI test ran
concurrently. Whole-process medians across four launches, before → after, MiB:

| Input        | Tabs | Working set after visits | Sampled peak Private |
| ------------ | ---: | -----------------------: | -------------------: |
| Paper        |    1 |            123.3 → 123.3 |        137.0 → 136.8 |
| Paper        |    4 |            147.5 → 147.1 |        150.2 → 150.3 |
| BERT         |    1 |            133.8 → 138.1 |        154.3 → 150.7 |
| BERT         |    4 |            163.5 → 162.9 |        178.1 → 184.7 |
| IPA          |    1 |            138.5 → 138.8 |        127.1 → 128.0 |
| IPA          |    4 |            199.4 → 187.1 |        187.3 → 186.1 |
| Font aliases |    1 |            151.6 → 151.8 |        145.5 → 150.0 |
| Font aliases |    4 |            161.9 → 153.0 |        154.6 → 154.0 |
| Raster       |    1 |            117.5 → 121.5 |        117.2 → 116.7 |
| Raster       |    4 |            139.9 → 138.1 |        129.9 → 130.2 |

Savings are not uniform. One accepted-candidate raster four-tab zoom/cancel
batch took 1536.5 ms; its four-launch median was 385.9 ms. General resident
memory, startup and tail-latency gains are not established. The retained change
removes known-aborted allocation/processing work; it does not meet the original
lightweight objective against MuPDF.

The accepted version completed 110 measured launches and 130 matching image
comparisons: 80 standard-corpus, 16 gray/color/alpha/rotation edge, 20 dense-wide,
10 diagnostic and four hold comparisons. The rejected candidate completed
another 28 launches and 60 matching comparisons. Results are not mixed between
candidate hashes. Input/executable/DLL/source/image hashes, phase summaries,
CPU/pressure counters, lifecycle snapshots and test logs are recorded in
`docs/solokpdf-phase4-batch-2026-10-25.json`; raw polling and PNGs stay in `out/`.

All temporary PDB renames were restored, and generated VS files were returned
to their original state after verifying only `--with-pdfium` generation changes.
SDK discovery, PE reads/launches and output links required retries; no ACL or
security settings changed. Build/test logs use `out/solok-finish-*.log`.
At the end of this batch, raw `out/rel64` / `out/dbg64` held the rejected
size-cache trial. Later builds overwrite them; use the labeled paths for each
pass. Portable folders and ZIP archives were not updated.

Reproduce the accepted comparisons with the frozen files:

```powershell
$beforeExe = 'out/solok-finish-before-matched/SolokPDF.exe'
$acceptedExe = 'out/solok-finish-after-release/SolokPDF.exe'
$batchPdfs = @('.work/corpus/attention-1706.03762v7.pdf',
    '.work/corpus/independent/bert-1810.04805.pdf',
    '.work/corpus/independent/ipa-2026-soshiki.pdf',
    'out/solok-phase4-font-check/fonts.pdf',
    '.work/corpus/phase4/attention-raster-15.pdf')
bun experiments/pdfium/memory-ui.ts --before $beforeExe --after $acceptedExe --runs 2 --output out/solok-finish-corpus-paired @batchPdfs
bun experiments/pdfium/memory-ui.ts --before $beforeExe --after $acceptedExe --runs 2 --reverse --output out/solok-finish-corpus-repeat @batchPdfs
$lifetimePdfs = $batchPdfs[0..3]
bun experiments/pdfium/lifetime-ui.ts --before $beforeExe --after $acceptedExe --hold 600 --cycles 32 --output out/solok-finish-lifetime @lifetimePdfs
bun experiments/pdfium/lifetime-ui.ts --before $beforeExe --after $acceptedExe --hold 0 --cycles 32 --reverse --output out/solok-finish-lifetime-repeat @lifetimePdfs
bun experiments/pdfium/memory-ui.ts --before $beforeExe --after $acceptedExe --profile --large --cycles 24 --tabs 1 --runs 1 --output out/solok-finish-profile out/solok-memory-fixtures/wide-gray-color.pdf
```

The four planned checks are complete. Further work needs allocation ownership
and a bounded render-buffer design before revisiting layout-lock separation;
exact warm-resource attribution and longer real-document sessions remain.

### Render-buffer ownership pass (2026-10-25)

Baseline: `6a4198892`. The diagnostic baseline adds only optional buffer-scope
counters; its pixels match the previous accepted Release. The candidate acquires
a separate render mutex before allocating pixels and checks cancellation after
waiting. Allocation can still trim caches without holding the SDK mutex. PDFium
calls and postprocessing keep their existing SDK lock. Fonts, flags, geometry,
resolution, colors and cache eviction policy are unchanged.

The counters sum each active RenderPage call's initial BGRA size until return;
compacted output may be smaller. They exclude gray-copy scratch, SDK allocations
and output already handed to callers/caches. They are not total process memory.
The initial diagnostic observed 2+ buffers and failed the limit-one check:
124.9 MiB peak with one tab, 187.4 MiB with four. The candidate passed with one
buffer and 62.5 MiB in both cases; every trace ended at zero reservations.

Logging-disabled comparisons use matched DLLs, hidden app PDBs (including the
recorded build path), fresh settings, requested 900x1000 at 120 DPI and alternating
variant order. Dense/light rows combine two rounds with opposite starting orders,
four launches per variant/tab count. Both workloads repeat 24 zoom/cancel cycles;
dense pauses are 20 ms, light pauses 35 ms. Whole-process medians, before → after:

| Workload   | Tabs | Sampled peak Private, MiB | OS peak working set, MiB |   Zoom → idle, ms | Process CPU during zoom, ms |
| ---------- | ---: | ------------------------: | -----------------------: | ----------------: | --------------------------: |
| Dense wide |    1 |             311.3 → 264.4 |            310.7 → 310.3 | 13679.6 → 14229.7 |           11515.6 → 11875.0 |
| Dense wide |    4 |             537.6 → 445.4 |            498.3 → 483.1 | 12608.2 → 12562.7 |           10898.4 → 10945.3 |
| Light wide |    1 |             266.3 → 251.3 |            305.5 → 305.5 |   3859.4 → 4268.2 |             3070.3 → 3742.2 |
| Light wide |    4 |             500.9 → 405.8 |            493.1 → 448.4 |   4030.5 → 3514.0 |             3218.8 → 3226.6 |

The candidate is retained as a peak-memory tradeoff, not a general speedup.
Light-wide single-tab wall time rose 10.6% and CPU 21.9%; dense single-tab wall
time rose 4.0%. Dense four-tab switching rose 442.4→474.9 ms and pending close
579.6→602.2 ms; light four-tab switching/close improved. Cancellation scheduling
can affect completed work, but the extra CPU was not attributed to a phase.
Host memory pressure varied; polling can miss short Private Bytes peaks. These
results do not establish tail latency or steady-memory improvements.

After tab visits, dense working sets were 169.8→169.8 MiB (one tab) and
358.6→358.8 MiB (four); light rows were 165.1→165.1 and 354.2→353.9 MiB.
Paper/BERT/IPA comparisons use two launches per variant/tab count with reversed
starting order. Normal-workload zoom medians were 373–401 ms, except the one-run
raster edge baseline at 411 ms. No uniform ordinary-document memory gain emerged.

The ownership probe opens the independent paper, BERT, Japanese IPA guide and
font aliases, visits each tab, holds for 60 seconds and closes all tabs. Both
variants retain seven registered tiles, estimated as 39.49 MiB by Cache Info.
That UI uses width*height*4, an upper estimate for gray/BGR output. Held Private
Bytes were 149.7→149.8 MiB; after closing/settling, both were 81.3 MiB, with zero
registered objects, 250 GDI objects and 699 handles. The additional eight
open/close cycles per variant completed 72 document lifetimes. This does not
attribute SDK/allocator warm state or prove hours-long leak freedom.

The first ownership-only probe hid the staged PDB but left the raw build-output
PDB readable. The candidate could load matching symbols; its cold footprint was
about 20 MiB larger. Those two runs are excluded and preserved in
`out/solok-ownership-cache-{before,after}`. Corrected probes use
`out/solok-ownership-cache-paired-{before,after}`. Performance/lifetime scripts
already hid both PDB locations, so their results were unaffected.

Release and Debug built with zero warnings/errors and passed the targeted GUI
checks. There were 72 paired memory-workload launches (64 without diagnostics),
118 matching image pairs and 72 document lifetimes in the open/close check.
No full unit suite was run. The complete evidence is assembled in
`solokpdf-phase4-ownership-2026-10-25.json`; raw counters, logs and screenshots
stay under `out/solok-ownership-*`. Debug output links needed retries after
LNK1104; no ACL/security settings changed. Generated VS files were restored
after validation. The previous accepted artifacts and portable build remain
unchanged. Adoption remains deferred.

Reproduce the ownership and bound checks:

```powershell
$before = 'out/solok-finish-after-release/SolokPDF.exe'
$after = 'out/solok-ownership-after-release/SolokPDF.exe'
bun experiments/pdfium/memory-ui.ts --before $before --after $after --large --cycles 24 --runs 2 --output out/solok-ownership-dense out/solok-memory-fixtures/wide-gray-color.pdf
bun experiments/pdfium/memory-ui.ts --before out/solok-ownership-before-release/SolokPDF.exe --after $after --profile --large --cycles 24 --runs 1 --output out/solok-ownership-profile out/solok-memory-fixtures/wide-gray-color.pdf
bun experiments/pdfium/check-buffers.ts out/solok-ownership-profile
bun experiments/pdfium/ownership-ui.ts --exe $after --hold 60 --output out/solok-ownership-cache-check .work/corpus/attention-1706.03762v7.pdf .work/corpus/independent/bert-1810.04805.pdf .work/corpus/independent/ipa-2026-soshiki.pdf out/solok-phase4-font-check/fonts.pdf
```

Further work should isolate the light-wide CPU increase before changing queue
scheduling again. Inactive-tab cache policy remains a separate tradeoff requiring
reactivation measurements; no automatic inactive eviction was introduced.

### Tab-group restore under background-load gates (2026-10-25)

`experiments/pdfium/tabgroup-ui.ts` creates fresh test settings containing a
persisted group and invokes the real Restore Tab Group dialog asynchronously.
`OpenTabGroup()` loads entries sequentially; rendering and thumbnail engine
clones may overlap. The application code/binaries were not changed in this pass.
The previously frozen Release baseline and ownership candidate use matched DLLs,
hidden raw/staged PDBs, 900x1000 requested geometry, 120 DPI and 100% initial zoom.
Every restored path is verified by visiting all tabs after restoration.

Inputs are the independent Attention paper, BERT and Japanese IPA guide, plus
the derived Attention raster PDF. The 8/16-tab groups repeat these four sources
under separate paths. This is not coverage of 16 independent real-world files.
The group is read from generated settings; the Save UI had earlier two-file
coverage. Settings, cache files and captures stay in isolated `out/` directories.

Background monitoring uses [GetSystemTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getsystemtimes):
total CPU is kernel+user, busy CPU subtracts idle, and target-process CPU is
subtracted to estimate other activity. Kernel time includes idle; this host has
16 logical processors. The remainder includes the harness and OS services, not
just unrelated apps. This reduces interference but does not isolate CPU cores,
frequency, disk activity or paging.

Fixed before the primary runs:

- Start after three consecutive one-second samples with total busy CPU ≤10%
  and OS memory load ≤85%.
- Accept a measured row only with other-CPU mean ≤10%, p95 ≤20% over 200 ms
  windows, and memory load ≤90%.
- Accept a pair only if both rows qualify and starting memory load differs by
  at most three percentage points. Retry at most three times; retain failures.
- Alternate attempted starting order. After exclusions each 4/8-tab dataset
  has three baseline-first pairs and one candidate-first pair: residual order
  imbalance remains.

The CPU wrapper uses separate FILETIME output buffers: the shared-buffer probe
returned zero idle time on this host. Independent P/Invoke queries bracketed
and verified the wrapper's counters/units. A preliminary 20 ms CPU-p95 policy
was rejected during calibration for short-interval noise; 200 ms windows were
fixed before the primary runs. Some adjacent raw snapshots backstep slightly;
every used 200 ms window was audited for positive total/idle deltas. Calibration
data is excluded from the primary comparisons.

Four qualifying launches per variant/count; whole-process medians, before → after:

| Tabs | Restore peak Private, MiB | OS peak working set, MiB | Active-ready, ms | Restore CPU, ms | Tab switch median, ms |
| ---: | ------------------------: | -----------------------: | ---------------: | --------------: | --------------------: |
|    4 |             133.4 → 130.9 |            158.7 → 156.3 |    691.0 → 767.9 |   367.2 → 406.3 |           26.2 → 24.7 |
|    8 |             164.8 → 161.5 |            189.6 → 186.4 |  1104.2 → 1158.9 |   570.3 → 640.6 |           27.5 → 28.1 |

Active-ready means the final selected restored tab is fully rendered and the
control interface responds after all entries were opened. It is not first-paint
timing or a guarantee that background thumbnail work has ended. Restore peaks
include another 500 ms of settling; screenshots occur after timed traversal.
Private Bytes sampling requests 20 ms intervals; qualifying maximum gaps were
46–54 ms, so short peaks can be missed. OS peak working set is cumulative from
the fresh process start.

After visiting all tabs, Private Bytes were 118.1→117.2 MiB (4) and
153.2→153.2 MiB (8). Working sets were 143.5→142.1 and 177.9→177.9 MiB.
The 2–3 MiB restore-peak differences are small; these runs establish no substantial
ordinary tab-group benefit or general speedup. Residual background load and
order imbalance prevent attributing every small difference to the mutex.

Across the two primary output directories, 32 processes produced 16 pairs:
eight qualify (4/8 tabs), eight are excluded. Six excluded pairs are 16-tab
attempts: other-CPU means reached 11.9–21.3%, with p95 up to 35.6%. All failed
the unchanged limits. The user confirmed a concurrent heavy task cannot be
stopped, so no further performance runs were started. A qualifying 16-tab
comparison is still required; excluded measurements are not adoption evidence.

All 108 paired canvas images matched, including 96 from excluded 16-tab pairs.
The latter validate rendering/path restoration in those attempts, not performance.
PDBs were restored after every failed/finished run. Unrelated formatter-only
hunks were reverted. No full suites, portable replacement or
additional application optimization was performed.

Results and audits are in `solokpdf-tabgroup-2026-10-25.json`. Raw data/captures:
`out/solok-tabgroup-main/` and `out/solok-tabgroup-main-16/`; independent counter
verification: `out/solok-tabgroup-cpu-reference.json`. The ownership candidate
remains a large-tile peak-memory experiment. Defer adoption for ordinary group
restoration until the missing low-load 16-tab comparison is available.

Resume that comparison when the host is quiet, with a fresh output directory:

```powershell
bun experiments/pdfium/tabgroup-ui.ts --counts 16 --runs 4 --output out/solok-tabgroup-16-idle .work/corpus/attention-1706.03762v7.pdf .work/corpus/independent/bert-1810.04805.pdf .work/corpus/independent/ipa-2026-soshiki.pdf .work/corpus/phase4/attention-raster-15.pdf
```

### Quiet-host 16-tab rerun and rollback (2026-10-25/26)

The rerun used the frozen executables, DLLs and four sources above. Four of five
pairs met the fixed CPU/memory gates; the first pair was excluded for 11.1%
background CPU mean. Both variants' 32 paired canvas images matched. Eligible
whole-process medians, baseline → trial:

| 16-tab restore      |  Baseline |     Trial |
| ------------------- | --------: | --------: |
| Peak Private Bytes  | 243.5 MiB | 230.1 MiB |
| OS peak working set | 267.7 MiB | 254.4 MiB |
| Active-ready        | 2338.4 ms | 2376.5 ms |

Peak Private Bytes fell 13.4 MiB (5.5%). One of four pairs had a 1.0 MiB higher
peak with the trial. The largest sampling gap was 55.6 ms. The 4/8-tab gains
remain small and the light-wide single-tab CPU regression remains. The trial
was rejected for general use; only its render mutex and allocation counters
were removed from `EnginePdfium.cpp`, restoring its `6a4198892` content. Full
results are in `solokpdf-tabgroup-16-idle-2026-10-25.json`.

The reverted Release and Debug built with zero warnings/errors.
Debug needed retries for intermittent output-file `LNK1104` errors.
`tests/ad-hoc-pdfium.ts` passed on both rebuilt executables. A four-document
ownership probe on the Release executable measured 82.8 MiB Private Bytes in an
empty window, 153.6 MiB after visiting all tabs and 84.6 MiB five seconds after
closing them. Cache Info reported seven tiles while open and zero after close.
Its 39.49 MiB tile estimate assumes four bytes/pixel, so it is not an allocation
breakdown for compact gray/BGR tiles. The probe is in
`out/solok-post-revert-ownership/`.

### Pixel accounting and controlled CPU comparison (2026-10-26)

Cache Info now reports known pixel payload (`stride * height`) separately from
the unchanged eviction estimate. In one four-document diagnostic, seven tiles
cost 23.10 MiB of pixels versus the 39.49 MiB policy estimate. Private Bytes were
80.8 MiB empty, 153.1 MiB after visits and 83.7 MiB after closing/settling.
These are not SDK allocation measurements; GDI/allocator overhead remains separate.

The trial bounds renders above 16 MiB with an exclusive gate; small renders share
the gate. Large conversions release the SDK lock after closing SDK handles so
UI requests can cancel conversion. Fonts, pixels, resolution and cache eviction
accounting stay unchanged. The overlap check failed on the preceding candidate
and passed on the final trial. The trial is saved as
`experiments/pdfium/render-gate.patch`, applicable to the current source.

Exploratory memory/CPU comparisons did not monitor background CPU continuously.
They are not sufficient to attribute CPU differences to the code. A separate
group-restore benchmark rejected all three attempted pairs under its existing
background-load limits. Those restore timings are not adoption evidence.

`experiments/pdfium/load-ui.ts` then reran the light-wide single-tab case:

- Three consecutive one-second start samples: host CPU <=10%, memory load <=85%.
- An independent Bun process samples host/target CPU and memory every 200 ms,
  including while the UI driver blocks. Maximum observed sample gap: 217.8 ms.
- Accept rows only with other-CPU mean <=10%, p95 <=20% and memory load <=90%.
  Paired starting memory load must differ by at most three percentage points.
- Same DLLs/PDF/settings/geometry, hidden raw/staged app PDBs, warm file cache,
  target idle before timing, alternating order; 24 zoom cycles at 35 ms intervals.

All four pairs qualified on their first attempt. Other-CPU means were 2.6–4.8%,
p95 8.1–13.5%. Whole-process medians, before -> trial:

| Light-wide, one tab    | Before |  Trial |
| ---------------------- | -----: | -----: |
| Process CPU, ms        | 2406.3 | 2656.3 |
| Zoom batch -> idle, ms | 3454.6 | 3441.8 |

CPU rose 10.4%; three pairs rose and one fell. Four pairs do not establish
universal behavior, but background load alone no longer explains the observation.
The large-tile savings remain a workload tradeoff. The trial is not enabled in
normal builds; no startup or general resident-memory improvement is claimed.

The default-v1 font callback probe initially changed alias pixels because of its
face-name terminator handling. Matching internal-style name lengths restored all
15 paired PNGs. This correction is probe-only. Version 2 still changed alias
pixels with normalized names, so application font matching remains untouched.

The trial matched 38 paired canvas images and completed 40 document lifetimes,
including the wide fixture. Stable Release/Debug builds passed the targeted GUI
and new two-document disk group/session-restart checks. The cache serializer's
focused harness passed 27 checks. Full unit suites were not run; the clipboard
baseline failure remains. Raw logs/PNGs stay in `out/solok-*`; condensed results,
hashes, exclusions and controlled CPU samples are in
`solokpdf-memory-2026-10-26.json`.

## Phase 5: portable development identity

The initial packaging results below describe `48eb0f96a`. Both current ZIPs were
refreshed on 2026-10-26 from stable source, without the render-gate trial, and
checked after extraction for default PDFium opening/search and normal shutdown.

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
- Two-document Tab Groups and normal-session paths persisted across restart.
  Restored zoom/scroll state, crash recovery, inactive-tab allocation attribution
  and hours-long leak stress remain unverified.
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
