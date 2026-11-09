# SolokPDF history

Measurement and work log, oldest first. Current behavior is in
[features.md](features.md) and [limitations.md](limitations.md); open items are in [backlog.md](backlog.md).
Condensed measurements are in [data/](data/).

## Navigation

| Topic                 | Records                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recent implementation | [E12 input-target classification](#e12-input-target-classification-2026-11-09), [E11 settings application](#e11-settings-application-2026-11-09), [virtual sidebar rollout](#virtual-sidebar-rollout-2026-11-09) |
| Keyboard input        | [Initial review](#keyboard-input-review-2026-11-04), [current investigation and E12 plan](keyboard-investigation.md)                                                                                             |
| Startup and memory    | [Performance measurements](#phase-4-performance-measurements-and-changes), [system font cache](#system-font-cache-2026-10-26), [empty-window memory](#empty-window-direct2d-memory-2026-11-04)                   |
| Project origin        | [Baseline](#baseline-2026-10-24), [engine map](#engine-map-at-baseline-842ea1be5), [portable identity](#phase-5-portable-development-identity)                                                                   |
| Completed work        | [Backlog archive](#completed-backlog), [upstream merges](upstream-merges.md), [selection overlay](selection-overlay-plan.md)                                                                                     |

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
- Unmodified debug build **passed**. Initial
  links of newly created PE files intermittently returned LNK1104; retrying
  without source changes passed. The cause was not established; no security
  settings were changed.
- Official `bun cmd/run-unit-tests.ts -dbg` **failed on the unmodified baseline**:
  `ClipboardImage_ut.cpp:88`, `len(dib) > sizeof(BITMAPV5HEADER)`, followed by
  access violation at line 90. The baseline suite failed.
  `GetClipboardData` later lost the open
  clipboard on this host. ESET's `ebehmoni.dll` and ATOK's TIP were injected;
  the culprit was unconfirmed. Per-read opens and retries fixed the test, and
  the unit suite passed 11 consecutive runs.

## Engine map at baseline (842ea1be5)

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

MuPDF-specific annotation/form APIs extended beyond EngineBase at baseline.
The PDFium engine later gained a lazy hidden MuPDF editor for annotations,
forms and signatures. Thumbnail/print cloning can temporarily open another
engine instance, as the existing EngineBase contract permits.

PDFium public `fpdfview.h` requires serialization of **all** calls across the
process, including calls on different documents. A per-document mutex alone
would be insufficient. Destruction must use the same global synchronization.

The baseline `vs2022` build used `tools/solokpdf/env.ps1 -Toolset v145`
because v143 was absent on that host.

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

Comparison results:

- Pages 3 and 4, 96 and 144 DPI, PDFium normal/LCD and the baseline's
  `sumatrapdf-tool draw -A 8` (MuPDF 1.28.5). Matching page pixel dimensions.
- PDFium normal and LCD PNGs are byte-identical in these four comparisons.
- Full pages were visually inspected for body text, fractions, subscripts,
  Greek symbols, vector diagrams and thin lines. No missing formula glyphs or
  displaced content was observed on these pages. This is limited visual evidence,
  not a broad correctness or readability score.
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

The wrapper generates `vs2026/` (ignored, toolset v145) with `--with-pdfium`
and builds its `.slnx` through `SUMATRA_SLN`, so the committed `vs2022/`
projects stay upstream's. `bin/premake5.exe vs2022` regenerates those; they
still need `env.ps1 -Toolset v145` where v143 is missing. Generated
projects should not be hand-edited or relied on as the source of the option.
`cmd/run-unit-tests.ts` also regenerates **without** this option: it is the
upstream unit baseline, not the PDFium build/test entry point. Use the targeted
test above after `solok-build.ts`; `--no-build` prevents the common test runner
from replacing the experimental build with an upstream one.

Implementation details:

- All PDFium calls, initialization, document/page close and shutdown share one
  process-wide mutex. PDFium is dynamically loaded only when selected.
- Like MuPDF, files under 32 MiB are read into memory and their handle is
  closed, so producers (e.g. LaTeX) can overwrite the open PDF and it reloads.
  This costs the file size per open document. Larger files keep a handle and
  custom reader for the document's lifetime. Pages/text pages/render
  handles are closed after each operation. Later annotation, form and signature
  work added a lazy hidden MuPDF editor.
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
- The DLL stays mapped for the process lifetime to avoid loader churn. Later,
  startup font warm-up kept PDFium initialized between documents.

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

## Phase 4: performance measurements and changes

Run `bun experiments/pdfium/benchmark-ui.ts <pdf>` after both builds exist.
Raw samples are checked in as `data/benchmark-2026-10-24.json`.

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
allocations. No speculative cache tuning was applied.

### Release comparison (2026-10-25)

Run `bun experiments/pdfium/benchmark-ui.ts --release <pdf>`. Same settings,
machine, three runs and counter definitions as above, using the same optimized
SolokPDF executable with the two engine choices. No unmodified upstream Release
binary was built; these numbers must not be compared against the Debug baseline
as an engine-only change. Raw data:
`data/benchmark-release-2026-10-25.json`.

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
`data/benchmark-lazy-dest-2026-10-25.json`.

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
Retries passed without ACL/security changes.

### Font-loading diagnosis (2026-10-25)

This iteration adds diagnostics; it adopts no new rendering/font policy.
Raw measurements and hashes: `data/profile-2026-10-25.json`.

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
on retries without ACL/security changes.

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
pixel comparisons: `data/memory-2026-10-25.json`.

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
Earlier PE/PDB access failures
required retries/output backups; no ACL or security settings were changed.

A prior render-buffer serialization trial was rejected: memory gains were not
consistent. It is absent from the final code. Its exploratory data are in
`data/memory-lock-trial-2026-10-25.json`; its first launch overlapped a
functional check and its workload differed, so do not combine it with the
accepted comparison.

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
comparisons: `data/memory-gray-2026-10-25.json`. Frozen inputs and workload
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
PE reads/launches and Debug links needed
retries/output backups, without ACL/security changes. An earlier GUI check
overlapping a build timed out in the missing-DLL fallback; standalone repeats
passed. The access failures and timeout causes remain unresolved.

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
`data/memory-extended-2026-10-25.json`; full polling samples and PNGs
remain under its `experiments[].path` directories. Earlier exploratory runs
(`out/solok-independent-preflight`, `out/solok-independent-paired`) are excluded:
the measurement helpers were still being extended. All temporarily hidden PDBs
were restored. No application rebuild, full unit suite or portable replacement
was needed for these diagnostic-only changes.

This run applied no further memory optimization.

### Batched cancellation and retention pass (2026-10-25)

The accepted change stops work after cancellation: before bitmap allocation,
after page load/fill, and between rows of gray scanning/copying, BGR packing
and alpha conversion. Canceling gray conversion preserves the original pixmap
and deletes any partial DIB. Canceled BGR/alpha buffers are discarded. Normal
rendering, fonts, flags, resolution, colors and cache policy are unchanged.

The baseline added only optional phase diagnostics and an unused cancellation
argument to `d7fd279f3`. The comparison used matched DLLs; no baseline or
portable executable was overwritten at the time.

The new focused test failed first: 219 checks, six failures. After adding
cancellation it passed 222 checks with zero failures, including existing
palette/BGR/BGRA tests. Cases cover cancellation during gray scanning and DIB
copying, source preservation and GDI cleanup. Release and Debug built with zero
warnings/errors and passed `tests/ad-hoc-pdfium.ts`. Full unit suites were not
run; the earlier clipboard baseline failure was fixed later.

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
The rejected trial's counters were kept separate. The working tree was
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
`data/phase4-batch-2026-10-25.json`.

All temporary PDB renames were restored, and generated VS files were returned
to their original state after verifying only `--with-pdfium` generation changes.
SDK discovery, PE reads/launches and output links required retries; no ACL or
security settings changed. Portable folders and ZIP archives were not updated.

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
about 20 MiB larger, so those two runs were excluded. Performance/lifetime scripts
already hid both PDB locations, so their results were unaffected.

Release and Debug built with zero warnings/errors and passed the targeted GUI
checks. There were 72 paired memory-workload launches (64 without diagnostics),
118 matching image pairs and 72 document lifetimes in the open/close check.
No full unit suite was run. The complete evidence is assembled in
`data/phase4-ownership-2026-10-25.json`. Debug output links needed retries after
LNK1104; no ACL/security settings changed. Generated VS files were restored
after validation. The previous accepted artifacts and portable build remain
unchanged. The trial was not adopted.

The light-wide CPU increase prevented a queue scheduling change. Inactive-tab
eviction was not introduced because reactivation costs were unmeasured.

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
excluded measurements are not adoption evidence.

All 108 paired canvas images matched, including 96 from excluded 16-tab pairs.
The latter validate rendering/path restoration in those attempts, not performance.
PDBs were restored after every failed/finished run. Unrelated formatter-only
hunks were reverted. No full suites, portable replacement or
additional application optimization was performed.

Results and audits are in `data/tabgroup-2026-10-25.json`. The ownership
candidate remained a large-tile peak-memory experiment pending the quiet-host
rerun below.

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
results are in `data/tabgroup-16-idle-2026-10-25.json`.

The reverted Release and Debug built with zero warnings/errors.
Debug needed retries for intermittent output-file `LNK1104` errors.
`tests/ad-hoc-pdfium.ts` passed on both rebuilt executables. A four-document
ownership probe on the Release executable measured 82.8 MiB Private Bytes in an
empty window, 153.6 MiB after visiting all tabs and 84.6 MiB five seconds after
closing them. Cache Info reported seven tiles while open and zero after close.
Its 39.49 MiB tile estimate assumes four bytes/pixel, so it is not an allocation
breakdown for compact gray/BGR tiles.

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
`experiments/pdfium/render-gate.patch`; it no longer applies to current source.

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
baseline failure was fixed later. Condensed results, hashes, exclusions and
controlled CPU samples are in
`data/memory-2026-10-26.json`.

### Normal-PDF startup and resident-memory diagnosis (2026-10-26)

`experiments/pdfium/normal-startup-ui.ts` opens a PDF from a fresh empty Release
window, waits for render idle, samples after one second, closes it and samples
again after one second. It uses the same executable and DLLs for both engines,
fresh isolated settings, a warm OS file cache, hidden application PDBs and the
same 900x1000 window. An independent Bun process samples host and target CPU,
process memory and OS memory load every 200 ms while the UI driver may block.
The existing background-load gates apply: three quiet one-second start samples;
other-CPU mean <=10%, p95 <=20%, OS memory load <=90%, and paired starting
memory load within three points. Attempts alternate engine order.

Dispatch **SolokPDF startup performance** from GitHub Actions to repeat both
comparisons on a hosted Windows runner. `--ci` takes seven alternating pairs
per PDF, records three start-load samples per attempt and keeps pairs that miss
the load gates marked non-qualifying. Use paired PDFium-minus-MuPDF gaps and
their trends; hosted-runner absolute times are not comparable to local times.

```powershell
.work/tools/bun-windows-x64/bun.exe experiments/pdfium/normal-startup-ui.ts --runs 3 --output out/solok-normal-startup-2026-10-26 .work/corpus/attention-1706.03762v7.pdf .work/corpus/independent/bert-1810.04805.pdf .work/corpus/independent/ipa-2026-soshiki.pdf
```

Three qualifying pairs each for the attention paper and independent BERT PDF:

| PDF       | Open to render idle, PDFium / MuPDF | Private Bytes above empty, PDFium / MuPDF | Private Bytes above empty after close, PDFium / MuPDF |
| --------- | ----------------------------------: | ----------------------------------------: | ----------------------------------------------------: |
| Attention |                    282.8 / 131.1 ms |                             7.7 / 5.8 MiB |                                         0.5 / 1.1 MiB |
| BERT      |                    256.0 / 123.7 ms |                             9.6 / 3.7 MiB |                                         0.2 / 1.6 MiB |

Eligible other-CPU means ranged 3.2–9.8%, p95 reached 17.2%, OS memory load
reached 61%, and the largest monitor gap was 216.8 ms. Four pairs were excluded
for background CPU (two BERT, two IPA attempts); the final IPA attempt could
not start after the host exceeded the quiet-start limit for 60 seconds. No IPA
performance or memory comparison qualifies. Condensed results are in
`data/normal-startup-2026-10-26.json`. A pilot caught and corrected an
empty-window `WaitRenderIdle` call in the measurement script; pilot data are
excluded. Application C/C++ code and PDFium rendering were not changed.

This isolates PDF opening from process startup. The two qualifying documents
point to PDFium's first-page path as a startup cost, not a general shell-start
cost. Prior phase logging measured a 368.8 ms first-page load versus an 8.9 ms
bitmap render on the attention paper; a raster first-page load took 2.1 ms.
Its unembedded Times-Roman and the font-info v2 probe make font matching a
plausible cause, not a proven allocation or CPU breakdown. Font-info v2 changed
alias text pixels and remains probe-only. The normal-PDF runs did not enable
profiling, so their open times cannot be assigned to one PDFium API. Background
windows span open, settle and close; a brief load spike during open can still
bias one timing. Three pairs per document do not establish a general speed gap.

The empty window used about 81–82 MiB regardless of the selected engine. After
closing one document, PDFium's Private Bytes were within 0.2–0.5 MiB of its
empty baseline. This does not support a large one-document SDK leak. Prior
four-document accounting measured 153.1 MiB after visits versus 80.8 MiB empty;
23.1 MiB was known cached pixel payload, leaving roughly 49 MiB across SDK,
GDI, UI caches and allocator overhead unassigned. Whole-process counters cannot
identify an owner or justify cache eviction changes. These warm open timings
are not direct process-launch or first-paint measurements. A controlled direct
launch comparison follows.

Decision at this stage: continue diagnosis only. Measure direct process launch,
time first-page loading in Release, and attribute non-pixel memory before
proposing a change. Any font-path candidate must preserve PDFium's font
selection, antialiasing, resolution and colors and match rendered text pixels,
including aliases and Japanese glyphs.

### Controlled direct launch and first-page attribution (2026-10-26)

`experiments/pdfium/direct-startup-ui.ts` launches the same Release executable
with each PDF on its command line. An independent CPU/memory monitor is ready
before process creation and attached within 6–9 ms. The script waits for render
idle, samples memory again after one second, then reads Cache Info's measured
pixel payload and closes the PDF. It uses the same settings, window, DLLs, PDB
exclusion and background gates as the empty-window open comparison. Profiling
is disabled in performance rows; separate profile runs are diagnostic only.
The CI workflow uses the two public arXiv PDFs only; IPA has no known public
source URL. It uploads raw samples and a summary for 30 days.

```powershell
.work/tools/bun-windows-x64/bun.exe experiments/pdfium/direct-startup-ui.ts --runs 3 --output out/solok-direct-startup-2026-10-26 .work/corpus/attention-1706.03762v7.pdf .work/corpus/independent/bert-1810.04805.pdf
.work/tools/bun-windows-x64/bun.exe experiments/pdfium/direct-startup-ui.ts --runs 3 --output out/solok-direct-startup-ipa-2026-10-26 .work/corpus/independent/ipa-2026-soshiki.pdf
```

All six text-PDF pairs and three IPA pairs qualified. One additional IPA pair
was excluded for background-CPU p95 above 20%. Eligible other-CPU means were
at most 7.5%, p95 at most 17.7%, OS memory load at most 64%, and the longest
monitor gap was 218.6 ms. Medians of three pairs per document:

| PDF       | Launch to render idle, PDFium / MuPDF | Paired PDFium delay | Settled Private Bytes, PDFium / MuPDF | Cache pixels, PDFium / MuPDF |
| --------- | ------------------------------------: | ------------------: | ------------------------------------: | ---------------------------: |
| Attention |                        1606 / 1155 ms |             +429 ms |                       86.5 / 83.4 MiB |                5.1 / 6.4 MiB |
| BERT      |                        1420 / 1112 ms |             +284 ms |                       88.1 / 80.9 MiB |               8.0 / 10.6 MiB |
| IPA       |                        1568 / 1509 ms |              +13 ms |                       92.0 / 96.7 MiB |               8.0 / 10.6 MiB |

The paired Private-Bytes differences were +3.1, +7.2 and -4.7 MiB. After
closing, both engines returned to about 79–81 MiB in these fresh processes.
GDI and handle counts were similar. PDFium's smaller measured tile payload
cannot explain its higher text-PDF Private Bytes. It does not identify the
remaining bytes: SDK, other app caches and allocator/GDI overhead are still
combined. A sampled startup peak is not an allocation trace, and 200 ms polls
can miss short peaks. These are warm-file, process-start-to-render-idle times,
including UI/control work, not cold boot or first-paint latency. The separate
pilot pair is excluded from the planned primary comparison.

With `SOLOKPDF_PROFILE=1`, Release logged first-page `FPDF_LoadPage` time of
366.5 ms for Attention and 289.5/404.8 ms for BERT; drawing took 6.7–7.3 ms.
IPA's first-page load took 2.8/10.3 ms, with 23.9–24.3 ms drawing. Document
load took 15–41 ms in these traces. The same pinned PDFium DLL was used by the
earlier standalone font probe: it recorded one 243–306 ms font enumeration on
both text PDFs and none on IPA across three rounds. Its instrumented default-v1
path matched all 15 paired PNGs, but it is not an in-app allocation trace.
The font-info v2 path changed alias text pixels and remains rejected. The
combined evidence makes first-use font enumeration the leading startup cause
for these text PDFs; it does not prove the exact application font calls or
their retained memory.

At this stage, startup savings appeared plausible on PDFs that trigger font
enumeration; IPA showed no general PDFium delay. Resident-memory savings were
unestablished, so tile-cache policy stayed unchanged. A font-path change needed
matching pixels for aliases and Japanese glyphs, as well as unchanged font
selection, antialiasing, resolution and colors. No optimization was made then.

Condensed results and hashes: `data/direct-startup-2026-10-26.json`.

### Non-pixel allocation attribution and continuation decision (2026-10-26)

An opt-in Release profile now records process Private Bytes and working set at
PDFium load/render/close phase markers. It built with zero warnings/errors, and
`tests/ad-hoc-pdfium.ts --no-build` passed against the instrumented executable.
The stable portable executable was restored after the build. Profile-phase deltas in the
application overlap UI and render allocations, so they are not PDFium-only
allocation counts. Six direct-launch pairs qualified and three were excluded by
background CPU or monitor gaps; they are diagnostic and excluded from the
performance medians above.

`experiments/pdfium/render.cpp` now snapshots process memory around PDFium
initialization, document/page load, bitmap/render, and each close. The
standalone `alloc-probe.ts` checks three consecutive quiet one-second host
samples before each launch (CPU <=10%, OS memory load <=85%), then compares
the rendered PNG with the earlier unmodified probe. Three runs per document
used the pinned DLL, page 1, 96 DPI and LCD text. All nine default-path PNGs
matched. Median net Private Bytes at `FPDF_LoadPage`:

| PDF                | Default page load | Font data returned by callbacks | After document close |
| ------------------ | ----------------: | ------------------------------: | -------------------: |
| Attention          |         +2.05 MiB |                        1.44 MiB |            -2.05 MiB |
| BERT               |         +2.23 MiB |                        1.44 MiB |            -1.57 MiB |
| IPA                |         +3.91 MiB |                               0 |            -3.89 MiB |
| Font-alias fixture |        +36.17 MiB |                       36.88 MiB |           -36.03 MiB |

The font callback profile separately matched the default-path PNGs. Attention,
BERT and the alias fixture each triggered one font enumeration; IPA triggered
none. The first two returned 225 font-data blocks; the alias fixture returned 299. Their callback time is consistent with the previously observed slow first
page, but these short runs have no continuous background CPU gate and are not
new timing evidence. The alias fixture is 16 KiB yet makes PDFium retain about
36 MiB until document close. This identifies font data as the principal source
of that fixture's non-pixel memory. For the normal text PDFs, font data accounts
for part of the roughly 2 MiB page state, not the entire application's memory.
The IPA page state arises without this font enumeration.

The probe-only font-info v2 path reduced page-load Private Bytes to 1.60 MiB
for Attention, 1.84 MiB for BERT and 16.34 MiB for the alias fixture. For the
alias fixture it returned 15.39 MiB of font data in 62 calls, versus 36.88 MiB
in 299 calls on the default path. V2's alias PNG differed from the default
path in all three trials; an earlier application comparison also found alias
text pixel changes. It is therefore rejected as an application change.

`multi-alloc.cpp` isolates PDFium from the application and tile cache. It opens
the same four documents, loads/closes page 1 of each, holds all documents, then
closes them. Three alternating-order runs, each after the quiet-start gate,
measured +42.20–42.30 MiB Private Bytes while open and +0.57–0.66 MiB after
close relative to the post-initialization baseline. This probe uses PDFium's
file-path loader rather than the application's custom file callback. The three
ordinary PDFs without the alias fixture used +7.69–8.14 MiB while open, and
the alias fixture alone used +36.21 MiB. The latter dominates the
four-document result; it must not be generalized to ordinary PDFs. These are
process-wide net measurements of the isolated SDK path, not allocation stacks
or a complete application memory breakdown.

The corresponding application four-document diagnostic was repeated in reverse
engine order. PDFium's visited-all Private Bytes were 152.9/152.6 MiB versus
MuPDF's 143.4/143.3 MiB. PDFium's measured cached pixel payload was 23.1 MiB
versus MuPDF's 29.7 MiB. After all tabs closed and settled, PDFium returned to
83.6/84.7 MiB from 82.8/81.7 MiB empty; MuPDF remained at 116.6/116.9 MiB
from 81.7/81.6 MiB empty. GDI/handle counts were similar. The isolated PDFium
probe explains why the synthetic alias document can dominate PDFium's open-tab
Private Bytes. Pixel payload, SDK net memory and application Private Bytes
cannot be added as exact ownership buckets: GDI backing, allocator overhead,
render work and UI caches differ between processes. The remaining ordinary-PDF
application increment is not assigned to an exact allocation stack.

Windows heap ETW capture was attempted with `wpr -start HeapSnapshot -filemode`
and denied by the OS (`Access is denied`); snapshot heap configuration was
disabled. UMDH, GFlags and VMMap were unavailable here, and the pinned PDFium
package contains no PDB. Thus exact heap call stacks and the remaining
application-side buckets cannot be established in this environment. This is
the remaining measurement limit, not evidence of a PDFium leak. The small
post-close residuals and repeated document-close recovery argue against a
large persistent PDFium leak in this corpus.

At this stage, first-use font enumeration was the specific startup candidate.
Font-info v2 changed text pixels, so tile-cache policy and rendering settings
stayed unchanged. No optimization was implemented in this diagnostic pass.
Condensed results and hashes are in `data/allocation-2026-10-26.json`.

## Phase 5: portable development identity

The initial `48eb0f96a` Debug and Release ZIPs excluded PDBs, settings,
caches and downloaded PDFs. On 2026-10-27 both were rebuilt with theme page
colors. Extracted packages opened and rendered PDFs, including with a dark
theme, and exited normally without a PDB or source tree. The host briefly
denied file reads and process creation after a build; retries passed without
security or ACL changes, and the cause was not established.

The 2026-10-29 Release ZIP at `2091722eb` was 23,051,111 bytes. Its exe
passed all 18 `ad-hoc-pdfium*.ts` tests plus Vim, count prefix, shortcuts,
sidebar and Merge PDF checks. Signing needed private-key access outside
the sandbox; locked-session cursor input blocked `issue-5819`. The extracted
ZIP opened and rendered a PDF, then exited with code 0.

SolokPDF's names, settings and notices: [Portable identity](features.md#portable-identity).

## System font cache (2026-10-26)

The extended probe (`pdfium-render.exe --font-profile --gdi-enum`) split the
first text page's 218–334 ms font enumeration: GDI's own enumeration took
3–5 ms; 198–296 ms were font reads PDFium makes from inside it. For each of
~112 localized family names (Japanese names on this system) PDFium opens the
font with GDI and reads its `name` table for the PostScript name
(`CFX_FontMapper::AddInstalledFont`, `GetPSNameFromTT`). IPA uses only
embedded fonts and enumerates nothing.

`src/solokpdf/PdfiumFontCache.cpp` wraps PDFium's default system font info and
serves those reads from `pdfium-fonts.cache` in the app data dir: per family,
whether a font opened and its nameID 6 records byte for byte (27 KB). Only
those records are read by `GetNameFromTT`, so PDFium derives the same names.
The key is the PDFium version, GDI's full family list and the fonts registry
keys' write times; a mismatch re-records. The wrapper also drops the trailing
NUL PDFium's `FPDF_SYSFONTINFO` adapter keeps in face names, which the earlier
probe needed for identical pixels. `SOLOKPDF_FONT_CACHE=0` disables it.

`experiments/pdfium/font-cache-check.ts` renders pages in the Release app with
the cache off, cold and warm, three rounds. All Attention p1/p4, BERT p1 and
IPA p1 images matched. Slowest page load: off 116–273 ms, cold 119–302 ms,
warm 31–62 ms on Attention/BERT; IPA 7–12 ms throughout. Warm enumeration
took 27–58 ms: 7–15 ms for the key and cache, the rest PDFium's own pass over
~5,200 GDI entries. `tests/ad-hoc-pdfium.ts` compares off/cold/warm on a
fixture with unembedded localized fonts and Japanese glyphs; serving empty
`name` tables made it fail. Results: `data/font-cache-2026-10-26.json`.

### Direct launch with a warm cache

`direct-startup-ui.ts --warm` launches each fresh settings dir once unmeasured,
so the measured PDFium run replays the cache (confirmed in every text-PDF log).
Three qualifying pairs per document; two pairs excluded for background CPU.
Paired PDFium minus MuPDF launch-to-render-idle medians:

| PDF       | Cold cache (earlier pass) | Warm cache | Warm pairs, ms |
| --------- | ------------------------: | ---------: | -------------: |
| Attention |                   +429 ms |    +123 ms |     123/129/72 |
| BERT      |                   +284 ms |    +114 ms |    118/114/111 |
| IPA       |                    +13 ms |     +10 ms |        10/2/11 |

Absolute times were about half the earlier pass's for both engines (host
state differs); only paired differences are comparable. Diagnostic
`--profile` runs on the text PDFs: document load 21–26 ms; the two visible
pages render one after the other under `gPdfiumLock`, page 1 waiting 49–52 ms;
its load then took 45–53 ms, 42–51 ms of it the font replay. On BERT the
start-page thumbnail thread opened the PDF again and waited 118–136 ms for the
lock. Results: `data/direct-startup-warm-2026-10-26.json`.

### Startup font warm-up

`StartPdfiumWarmUp()` runs at startup when PDFium is the engine: a background
thread loads a one-page in-memory PDF with unembedded Helvetica, so PDFium
builds its font list while the window starts. It keeps its runtime reference,
so the list also serves documents opened after others close (before, closing
the last PDF destroyed the library and the next one enumerated again).
`SOLOKPDF_WARMUP=0` disables it. Every document now pays the enumeration once
in the background, including IPA-like ones that never needed it.

Profiles: the warm-up took 43–54 ms and ended before the document load took
the lock. `font-cache-check.ts` (2 rounds) matched off/cold/warm and the
previous build's hashes; first-page loads fell to 3–14 ms. Same-exe A/B,
warm-up on minus off, five pairs each: Attention −91 ms, BERT −105 ms, IPA
+5 ms (−15 to +93). Against MuPDF, on a noisier host than the warm-cache
pass: +13/+79/+56 ms. Closed-document Private Bytes stayed at MuPDF's level
(77.7 vs 77.6 MiB). Results: `data/font-warmup-2026-10-26.json`.

### Shared thumbnail engine

The home-page thumbnail thread reopened the PDF (BERT above), adding a load
and render under the global lock while the view rendered. For PDFium tabs it
now takes a reference to the tab's engine instead. Every PDFium run then
opened the document once, and BERT's thumbnail PNG was byte-identical. Against
MuPDF (5 pairs each, warm cache and warm-up): BERT +64 ms, Attention +26 ms,
IPA −8 ms. BERT's remaining gap matches its two visible pages rendering in
turn under the lock. `issue-5817` and `issue-6352` failed at the time because
they wrote `SumatraPDF-settings.txt`; the settings-path fixes came later.

### Narrower lock scope

A 4-tab Release profile showed each tab's load waiting 21–47 ms for the lock
while the previous tab rendered. Opening a file took 19–38 ms in-app; opening
the same files from another process took 19–29 ms, so the cost is the open
itself, not PDFium (`FPDF_LoadCustomDocument` took 0.2–3.5 ms). Renders held
the lock for the backdrop fill and gray/BGR conversion too. Now the file is
opened and read before the lock, and `DrawPage()` holds it only from
`FPDF_LoadPage` to `FPDF_ClosePage`; the backdrop is a `memset` of the same
bytes `FPDFBitmap_FillRect` wrote. `font-cache-check` matched the earlier
hashes and a debug view capture was byte-identical.

`benchmark-ui.ts --release --warm` (3 runs, no background gates), 4 tabs,
PDFium minus MuPDF: +68 ms before, +50 ms with file I/O outside the lock,
+19 ms with both. 1-tab medians moved within noise (+17, +15, +62 ms; the
control connected at the same time in the gated runs). Results:
`data/lock-scope-2026-10-26.json`.

### Zoom latency

`experiments/pdfium/zoom-ui.ts` (Attention, warm cache, 5 alternating runs)
times zoom command to render idle. PDFium medians were lower or equal despite
drawing tiles one at a time: 200% 38 vs 63 ms, 400% 40 vs 60, 800% 26 vs 22,
150% 33 vs 52, fit width 20 vs 20, 100% 19 vs 26.

### Memory by region type

`experiments/pdfium/memory-map.ts` sums committed and working-set bytes per
image, mapped file and private memory (`processMemoryMap()` in
`tests/winapi.ts`: `QueryWorkingSet` + `VirtualQueryEx`), at render idle and
after closing all tabs. Before this change, total working set was already at
MuPDF's level: BERT 146.1/147.5 MiB, Attention 144.3/142.9, 4 tabs
173.4/181.6 (PDFium/MuPDF); after close +1.3–2.3 MiB, mostly the kept PDFium
runtime and DLL pages. Private memory differed (BERT 73.4/64.5, 4 tabs
100.8/83.5) because PDFium's color tiles were heap buffers, while MuPDF puts
tiles in DIB sections over pagefile-backed mappings, which neither Private
Bytes nor Task Manager's memory column counts. A DIB section without a mapping
didn't help: GDI allocates its bits as private memory.

PDFium's gray and color tiles now use `CreateMappedDib()` like MuPDF's.
Private memory became 65.3/64.7 (BERT), 66.2/64.5 (Attention), 69.7/77.5
(IPA) and 80.1/83.0 MiB (4 tabs); total working set didn't change, since the
same pixels moved. The debug view capture was byte-identical, unit tests
passed and zoom medians stayed within noise (200% 39 vs 61 ms for MuPDF).

### Leak check of the 2026-10-26 additions

`experiments/pdfium/leak-ui.ts` runs one Release process (`96ac65471`) for a
set time. Each round opens four tabs: a generated 3-page form (24 fields, with
and without appearances), a generated page set with Named/GoToR links and
45-degree text, Attention and BERT. In each tab it steps through five zooms,
pages forward, selects text, reads links and searches, then closes all tabs
and samples the process after 500 ms. 224 rounds ran in 40 minutes (about
2,700 tab opens plus 1,800 link/search engines).

| Closed-state sample | Rounds 6–55, min/median/max |    Last 50 rounds |
| ------------------- | --------------------------: | ----------------: |
| Private Bytes, MiB  |           109.6/111.8/133.7 | 110.8/111.3/124.5 |
| Working set, MiB    |           139.3/147.1/168.7 | 139.8/140.3/153.4 |
| Handles             |                 651/657/664 |       652/652/652 |
| GDI / USER objects  |                 222 / 76–77 |          222 / 74 |

Fitted growth after five warm-up rounds: −8 KiB Private Bytes, −0.03 handles
and 0 GDI objects per round. Private Bytes alternate between about 111 and
120 MiB from round to round (allocator/cache state), so a leak below roughly
10 KiB per round would not show. This bounds the new form handle, form page
views, MuPDF link queries and text quads; it is not an hours-long proof.

### Lock-free page sizes for the UI thread

`PageMediabox` took the global lock even for a cached size, so the UI thread
waited for whichever page was drawing: about 10 ms per call at BERT startup.
Sizes are now published atomically and read without the lock. Renders still
read them under the lock before allocating, which keeps out the rejected
size-cache candidate's extra concurrent tile buffers. Traced UI-thread lock
waits at startup fell to one 3–7 ms `GetToc` wait.

Same DLLs, two rounds of 1/4 tabs (`memory-ui.ts --large --cycles 24`, no
background-load gates), before → after:

| Wide fixture | Zoom → idle, ms       | Peak Private Bytes, MiB |
| ------------ | --------------------- | ----------------------- |
| Dense        | 3759–4271 → 2266–2289 | 403–475 → 332–336       |
| Light        | 2284–2316 → 2276–2287 | 330–338 → 330–338       |

All 20 view comparisons matched. BERT/Attention direct-launch render idle
didn't change measurably (+31–46 ms behind MuPDF before, +46 ms after, four
gated pairs each); the stall delayed UI work, not rendering.

## UI review (2026-10-29)

Reviewed `ee2cdc1e7` and every commit in `ee2cdc1e7..0e219f451`: Light Gray, count prefixes, shortcuts dialog and VS entries, keyboard scroll distance, Vim mode and link hints, update checks, restore session, and keyboard help. The refactor is `ee040d363`.

### Findings

| Severity | Location                                                 | Scenario                                                                                                                          | Resolution                                                         |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Medium   | `src/VimKeys.cpp:331`, `src/shared/Accelerators.cpp:198` | JIS `:`, `'`, and backtick use different virtual keys from US; Vim commands fail. `/` and `?` also depended on physical OEM keys. | Match produced characters; JIS layout regression test. `d6515434a` |
| Medium   | `src/shared/LinkFollow.cpp:265`                          | Pressing `f` on a page with no links left Vim hint mode set; later plain keys were consumed.                                      | Clear the mode through the normal stop path. `30f0033b2`           |
| Medium   | `src/VimKeys.cpp:300`, `src/VimKeys.cpp:396`             | `Ctrl+E` and `Ctrl+Y` ignored `KeyScrollLineAmount`.                                                                              | Use the keyboard scroll helper. `90adca0ab`                        |
| Medium   | `src/SumatraPDF.cpp:176`, `src/ng/SessionState.cpp:432`  | `RestoreSession = true` reopened documents even when file history was disabled and the checkbox was unavailable.                  | Require `RememberOpenedFiles` at startup. `dc785dbda`              |
| Medium   | `src/VimKeys.cpp:346`                                    | JIS `;` is `VK_OEM_PLUS`; the Vim hint matcher only accepted the US OEM key, so a `;` hint could be cancelled.                    | Capture the produced character. `b682c262a`                        |
| Medium   | `src/VimKeys.cpp:198`                                    | Enter or Escape during IME composition in the `:` edit submitted or closed the command before the IME handled it.                 | Pass both keys to the edit during composition. `0593bce2d`         |

No further actionable defect was found in the theme, shortcuts dialog, VS entries, update-check guard, or keyboard-help changes. Non-Vim bindings remain in the original accelerator layer. Mark jumps check the page against the current document before setting scroll state. The startup and Vim regressions above were observed failing before their fixes and passing afterward.

## Full-suite triage (2026-10-29)

The paired run at `e7de6e7ac` reached 462 eligible tests per engine: 122
distinct failures (S80, P30, R5, E5, M2). Settings-path fixes (`9653c39a3`,
E5) and test repairs resolved S; PDFium work including B14–B29 and B48
addressed P. B50 skips by-design gaps on hosted CI. Both engines passed run
41349548951; B37's unlocked-desktop checks passed after correcting RTL toast
printing. Hosted CI has not yet run the changed test.

On the original `zlib.3.pdf`, the RTL toast had style `0x500008` on both
engines. Its window-DC Z bar was upright at x=43, y=27. PrintWindow with
`PW_RENDERFULLCONTENT` instead captured a clipped strip at y=2; its longest
bar was at x=84 on PDFium and x=33 on MuPDF. The former tripped the old
left-half assertion even though both displayed toasts were upright. The app
now paints the toast for `WM_PRINTCLIENT`, and the test uses standard
PrintWindow, which does not need displayed pixels.

## B62 widget action query gate (dropped, 2026-11-03)

Pinned PDFium 158.0.8111.0 exposes a widget's `/A` only as a dictionary type.
Its public headers provide no widget action handle or nested `/S` value;
`FPDFAnnot_GetLink` accepts only `/Link` annotations. Form JavaScript getters
cover keystroke, format, validate and calculate, not a button's click action.

Temporary profiling around `PdfLinksMupdf` in a Debug build measured 101
JavaScript-only button queries. Median: 1.214 ms on a 1,296-byte form and
2.512 ms on the same form with a 35 MiB unreferenced stream (36,701,538
bytes). A document-wide query would still pay this cost on the first
JavaScript-only button and scan pages that were not requested. B62 remains
the per-page lightweight query; the profiling code was removed.

## Empty-window Direct2D memory (2026-11-04)

An earlier software Direct2D comparison was invalid: the experiment build reused
the GDI+ object from the preceding test. The original executable also loaded
local symbols, adding about 22 MiB to its empty-window working set. The corrected
software build recompiles both Gfx files. Comparison copies have their executable
debug directories removed; their PDFium and engine DLLs match.

On one Windows host, three alternating Release launches per variant used fresh
settings, a 900x1000 window, a hidden desktop and no PDFium warm-up. At eight
seconds, median working set / Private Bytes were 94.3 / 75.2 MiB for default
Direct2D, 70.3 / 44.0 MiB for software Direct2D, and 60.4 / 41.0 MiB for
GDI+. Three PDFs with one and four tabs also used less private memory with
either alternative. Both alternatives matched the default canvas in all 24
captured page/zoom/scroll conditions; one captured text selection also matched
in the document region. Full-frame UI pixels differed; random Home tips prevent
attributing all empty-window differences to rendering.

Three short runs of tab switches, resize and scroll completed for each mode.
These timings have no background-load gate, and fixed waits affect zoom/scroll;
they cannot establish a performance ranking. Long-term stability, broader UI
coverage and other graphics drivers remain untested. GDI+ was then made the
SolokPDF default. Measurements and hashes:
`data/ui-renderers-2026-11-04.json`.

Three paired empty-window runs on the same host compared 3.6.1 with the GDI+
trial, using fresh settings and executable symbols removed from the trial.
Both requested a 900x1000 window, but 3.6.1 ignored `-window-pos`, so their
actual sizes were not matched. Median working set / Private Bytes were 41.8 / 15.0 MiB for
3.6.1 and 62.0 / 41.4 MiB for the trial with PDFium warm-up. Disabling warm-up
gave 60.4 / 41.0 MiB; forcing SAPI as well gave 53.1 / 40.2 MiB. Forcing SAPI
changes voice availability, so it is not an optimization decision. These are
process-wide counters, not heap ownership. A separate three-run QueryWorkingSet
probe counted non-shareable resident pages: 5.5 MiB for 3.6.1, 17.5 MiB for
the warmed GDI+ trial, 17.1 MiB without warm-up and 16.3 MiB with SAPI. These
are diagnostic page counts, not a claim of exact Task Manager equivalence.
Different app versions also have different UI and features. No further memory
change was made. See `data/gdi-startup-2026-11-04.json`.

## Deferred startup initialization (2026-11-04)

The crash handler now initializes symbols for a debug report instead of at
startup; crashes still write minidumps. Read-aloud voice selection is applied
on first use, while speed is retained at startup. Invalid saved voices are
cleared on first use, and settings reloads still update an active voice.

Three alternating empty-window Release runs on one Windows host used GDI+,
PDFium warm-up, a hidden desktop, fresh settings and a 900x1000 window. The
old executable's debug directory was removed; the new executable kept its PDB
available. At eight seconds, median working set / Private Bytes went from
62.0 / 41.5 MiB to 40.9 / 14.4 MiB. Non-shareable resident pages went from
17.5 to 9.1 MiB. No background CPU gate was used; these figures do not prove
first-open speed or general performance. A local intentional crash produced a
minidump with the crash comment. Results: `data/lazy-startup-2026-11-04.json`.

## GDI+ UI font scaling (2026-11-04)

GDI+ now uses the HFONT's pixel height for UI drawing, matching Direct2D's
size without applying display scaling twice. Tests cover 96, 120 and 144 DPI
with Latin and Japanese text. At 120 DPI the Home logo text matched the
Direct2D capture's height and differed by one pixel in width.

## Empty-window bitmap memory (2026-11-04)

Three alternating runs on one Windows host compared fresh Release processes
on a hidden desktop. Both frames were resized with `MoveWindow` and measured
three seconds later. Median non-shareable working set for 3.6.1 was 5.32 MiB
at 600x500 and 5.33 MiB at 1600x1000; SolokPDF used 6.89 and 11.76 MiB.
These counters approximate private resident pages, not Task Manager's exact
metric. No continuous host-load gate was applied.

Both versions buffer the canvas, but 3.6.1 uses `CreateCompatibleBitmap` and
SolokPDF uses a 32-bit DIB for Direct2D compatibility. An isolated GDI probe
painted a 1600x1000 bitmap: its non-shareable working set grew 6.11 MiB for a
DIB and did not change for a compatible bitmap. This supports the DIB as a
major contributor, but does not measure kernel or GPU allocations. The
subsequent change needs validation on other systems.
See `data/window-bitmap-memory-2026-11-04.json`.

## GDI+ canvas buffer (2026-11-04)

The GDI+ canvas now uses a compatible bitmap; Direct2D retains the 32-bit
DIB. On one Windows host, three alternating Release runs at 1600x1000 reduced
median non-shareable resident memory from 11.82 to 6.39 MiB with no PDF and
from 12.64 to 7.16 MiB with a PDF. The PDF canvas captures were pixel-identical
at 600x500 and 1600x1000. These process counters exclude kernel and GPU memory.
See `data/canvas-buffer-memory-2026-11-04.json`.

With that change, the same-size empty-window comparison at 1600x1000 measured
5.34 MiB for 3.6.1 and 6.35 MiB for SolokPDF in non-shareable resident pages
(three-run medians, one host). Instrumenting the other Gfx buffers in a debug
build found two live DIBs totaling 433,632 bytes at this size, both with and
without a PDF. This covers the initial UI, not every dialog or sidebar state.
See `data/ui-buffer-review-2026-11-04.json`.

## Keyboard input review (2026-11-04)

Vim prefixes and counts run before the accelerator table. The frame and canvas
use the main table; edit controls use a reduced table and the bookmarks tree
uses its own navigation rules. Custom bindings take priority over Vim keys.
Counts are cleared on focus loss, tab changes, Escape and unhandled keydowns.

Vim search and link hints now clear an unused count. During IME composition,
the Vim command line leaves Up and Down to the edit control instead of replacing
its contents with history. Tests simulate IME messages; a real IME session was
not exercised. Keyboard tests post window messages on a hidden desktop and do
not establish physical keyboard behavior across all input methods.

## Virtual sidebar rollout (2026-11-09)

`dff595cf0` added the opt-in prototype. `a844148bc` centralized expansion and
lifetime handling; `3412a2174` made virtual bookmarks and favorites the default
in Debug and Release, removing the opt-in switches and native sidebar drawing.
E10 remains open for the F2 physical acceptance checks. Settings application
under `-for-testing` was fixed separately in [E11](#e11-settings-application-2026-11-09).

Expansion delegates from `SidebarTree` to `VirtTree`; depth-based node updates
and visible-row rebuilding live in `VirtTreeState`. `VirtTreeGuard` shares
model, row and window validity checks across expansion notifications without
changing their order. Debug probes live in `SidebarTree::TestMessage`.

The refactor passed Debug/ASan builds and existing navigation, reentrancy,
destruction and stale-UIA tests. Expansion depth and sibling collapse matched
before and after the change. The diff review found no further issues; no new
test files were added.

The rollout adapted existing tests to the virtual controls. The Vim test
reproduced posted arrow keys reaching document accelerators; selecting the
table by the sidebar's focus target fixed routing. Its tree-only run passed
three times, and the full Vim test passed. Navigation, styles, colors, all four
scrollbar modes, large trees and Markdown/HTML outlines passed. ASan covered
model replacement, destruction, stale UIA references and key routing in real
documents and the shared control.

Permanent overlay bars now reserve viewport space. The large-favorites test
failed before the last-row correction and passed three times after it. End
visibility, reentrancy and destruction checks also passed under ASan. The final
Release build had no warnings or errors; Light/Dark rendering and UIA/MSAA
passed on the hidden desktop.

These are implementation-time results, not reruns for the documentation review.
The [migration plan](tree-view-replacement-plan.md) retains the original scope
and prototype results. Pending physical checks and their results belong in the
[manual procedure](tree-view-screen-reader-check.md#実施結果).

## E11: Settings application (2026-11-09)

Palette and Advanced Settings changes now rebuild derived settings from the
current values. Saving is separate; applying no longer rereads stale disk
values when `-for-testing` suppresses saves. Startup and external-file reloads
share the same normalization and initialization. Advanced Settings invalidates
the edited color's parsed cache without recreating the settings object.

The existing `command-palette-settings` and `adv-settings-home-reload` tests
failed before the fix. Both now exercise test mode and normal saving, checking
live values and the settings file after graceful exit. Test mode checks file
contents and modification time. Their suite entries follow `issue-5978`.

Windows x64 Debug built with no warnings or errors. Both changed tests and
`adv-settings-external-reload` passed three consecutive runs on the hidden
desktop. `ad-hoc-b70-settings` (PDFium and MuPDF), `reload-settings-memory-trim`,
`settings-restore-default`, `settings-persist` and `adv-settings-fresh-defaults`
also passed. B70's translated-settings check skipped because this build has no
embedded translations. Full suites were not run.

## E12: Input-target classification (2026-11-09)

`MainWindow.cpp` now classifies keyboard targets as document, input, tree or
other. Accelerator selection and the document-input predicate share this
classification. Other children retain the full shortcut table without gaining
Vim/count input. Properties, Merge PDF and palette exceptions keep their order;
message targets and actual focus remain separate.

Windows x64 Debug built with no warnings or errors. The six baseline tests and
two additional routing checks passed after the change on the hidden desktop;
the Japanese IME API test ran without skipping. No full suites ran. See the
[coverage and remaining routes](keyboard-investigation.md#入力先共通化の結果e122026-11-09).
Input-target consolidation is implemented; further routing changes need checks
for the uncovered paths listed there. Physical input checks remain F3.

## Completed backlog

Rows of [backlog.md](backlog.md) completed by 2026-11-09. Sources: an audit of every
MuPDF-only gate outside the engines (`kindEngineMupdf` comparisons and
`AsEngineMupdf` helpers), the known limitations, the upstream full suite
and targeted regressions.

### A. Startup and page geometry

| ID  | Item                                                                 | Status                                                                                  |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A1  | PDFium vs MuPDF startup measurements on GitHub Actions               | done                                                                                    |
| A2  | Page geometry detection inside object streams and files above 32 MiB | done — Bound PDF page geometry scan (A2b); large and encrypted PDFs use PDFium geometry |

### B. PDFium feature gaps

| ID  | Item                                                                                                                                                                         | Where                                                                                            | Status                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| B13 | Hovering a page loads the hidden MuPDF editor for every PDF (Canvas `OnMouseMove` -> `GetAnnotationAtPos`), costing open time and memory and locking files of 32 MiB or more | `Canvas.cpp`, `EngineMupdfGetAnnotationAtPos`                                                    | done — Avoid MuPDF editor on plain PDF hover                                                      |
| B1  | SyncTeX forward and inverse search                                                                                                                                           | `SumatraPDF.cpp` (pdfSync setup), `SearchAndDDECommon.cpp` `OnInverseSearch`, forward-search DDE | done — Enable SyncTeX on PDFium tabs                                                              |
| B2  | PDF `/ViewerPreferences` print defaults (#534)                                                                                                                               | `Print.cpp` `GetPdfViewerPrintPrefs`                                                             | done — Honor PDF print defaults in PDFium (fixes #534)                                            |
| B3  | Document Properties creation/modification date formatting                                                                                                                    | `DocumentPropertiesCommon.cpp` `isPdfDate`                                                       | done — Format PDFium document dates                                                               |
| B4  | `FixedPageUI.WindowBgCol` page-surround color                                                                                                                                | `Canvas.cpp` `isPdf`                                                                             | done — Apply fixed-page background to PDFium tabs                                                 |
| B5  | Engineering-drawing enhance (`CmdToggleEngineeringDrawingEnhance`): implement for PDFium or hide it                                                                          | `EngineMupdfToggleCadEnhance`                                                                    | done — Hide CAD enhance on PDFium tabs; B21 matches                                               |
| B6  | Theme change drops cached dark-mode analysis for PDFium tabs                                                                                                                 | `EngineMupdfInvalidateDarkMode`                                                                  | done — Verify PDFium theme transitions (no change needed)                                         |
| B8  | "Fit content" zoom                                                                                                                                                           | `EnginePdfium`                                                                                   | done — Fit PDFium content bounds (fixes #6241)                                                    |
| B9  | Copy/Save image under the cursor (`GetImageForPageElement`, `GetImageDataForPageElement`)                                                                                    | `EnginePdfium`                                                                                   | done — B18 restores image actions                                                                 |
| B10 | Page boxes query (`GetPdfPageBoxes`)                                                                                                                                         | `EnginePdfium`                                                                                   | done — Report PDFium page boxes (fixes #814)                                                      |
| B11 | Non-blocking `TryGetElements` / `TryExtractPageText` (UI thread waits otherwise)                                                                                             | `EnginePdfium`                                                                                   | done — Skip busy PDFium pages in non-blocking reads (B11)                                         |
| B12 | Test comparing every command's visibility/enabled state between engines on the same PDF                                                                                      | `TestCommandVisibility`                                                                          | done — Compare command visibility across engines (B12)                                            |
| B7  | Triage upstream full-suite failures                                                                                                                                          | full-suite run                                                                                   | done — Triage complete paired full-suite logs (B7); 462 reached per engine, 122 distinct failures |

B71 follow-up: Wait for tab scrolling to settle. Hosted 41741590075 reported page 1 Y=720.938 to 708.563 after a switch. At 125% DPI, a 1280x900 window and 200% zoom, a local boundary probe moved from Y=715.35 to 630.45 without switching tabs after the 150 ms sample. The test now waits for stability before comparison; hosted verification remains pending.
B71 follow-up: Allow more time for control startup. On November 1, MuPDF issue-5978 and issue-6140 took 3.5 s and 8.3 s; on November 3 their control connections timed out after 10 s. The logs do not distinguish slow startup from process exit.
B71 follow-up: Locate the palette edit without focus.
B71 follow-up: Wait for issue-6355 browser readiness.
B71 follow-up: Restore test keyboard focus (B71).
B71 follow-up: Wait for Markdown clipboard readiness (B71).
B71 follow-up: Guard test window activation (B71).
B71 follow-up: Prevent test dialog activation (B71).
B71 follow-up: Prevent settings focus activation (B71).
B71 follow-up: Trace and prevent settings activation (B71).
B71 follow-up: Compare tab views after a normal switch (B71).

#### B7 follow-ups

| ID  | Item                                                                                                                                                                                                                                                                                           | Evidence                                | Status                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B14 | PDFium text extraction                                                                                                                                                                                                                                                                         | B7 text group                           | done — Measure PDFium text fallback (B14)                                                                                                                                   |
| B15 | PDFium search                                                                                                                                                                                                                                                                                  | B7 search group                         | done — Join PDFium hyphenated search text (fixes #1189)                                                                                                                     |
| B16 | PDFium links                                                                                                                                                                                                                                                                                   | B7 links group                          | done — Link wrapped URLs in PDFium (fixes #2239)                                                                                                                            |
| B17 | PDFium annotations                                                                                                                                                                                                                                                                             | B7 annotations group                    | done — Keep redaction undo on PDFium tabs (B17); cursor tests need unlocked sessions                                                                                        |
| B18 | PDFium images                                                                                                                                                                                                                                                                                  | B7 images group                         | done — Enable PDFium image actions (fixes #6214)                                                                                                                            |
| B19 | PDFium fit content                                                                                                                                                                                                                                                                             | B7 layout group                         | done — Fit PDFium content bounds (fixes #6241)                                                                                                                              |
| B20 | PDFium page boxes                                                                                                                                                                                                                                                                              | B7 page boxes group                     | done — Report PDFium page boxes (fixes #814)                                                                                                                                |
| B22 | PDFium bookmark colors                                                                                                                                                                                                                                                                         | B7 rendering group                      | done — Honor PDFium bookmark styles (fixes #3560)                                                                                                                           |
| B23 | PDFium scroll responsiveness                                                                                                                                                                                                                                                                   | B7 responsiveness group                 | done — Skip PDFium hover queries while a render holds its lock (fixes #6362)                                                                                                |
| B24 | PDFium XMP properties                                                                                                                                                                                                                                                                          | B7 XMP group                            | done — Fill PDFium XMP properties from lazy editor                                                                                                                          |
| B25 | Restore lazy session tab                                                                                                                                                                                                                                                                       | B7 R: lazy tab no-doc                   | done — Reach the lazy tab in its save test (B25)                                                                                                                            |
| B26 | PDFium comment authors                                                                                                                                                                                                                                                                         | B7 R: issue-5329                        | done — Verify PDFium comment authors                                                                                                                                        |
| B28 | PDFium TOC selection                                                                                                                                                                                                                                                                           | B7 P: toc-selection-visible             | done — Select PDFium bookmarks under the hidden tree root                                                                                                                   |
| B29 | PDFium trim margins                                                                                                                                                                                                                                                                            | B7 P: issue-trim-margins                | done — Keep narrow text bounds when trimming                                                                                                                                |
| B30 | Shared UI command hangs                                                                                                                                                                                                                                                                        | B7 R: issue-5979, issue-6017            | done — Avoid modal AI install dialog in tests                                                                                                                               |
| B31 | Control output assertions                                                                                                                                                                                                                                                                      | Run 3: issue-5944, issue-906            | done — Accept current `screen` and `rect` fields                                                                                                                            |
| B32 | CI annotation cursor                                                                                                                                                                                                                                                                           | Run 3: annotation CI                    | done — Park cursor before checking lazy editor                                                                                                                              |
| B33 | Trim restore assertion                                                                                                                                                                                                                                                                         | Run 3: trim restore                     | done — Compare page aspect on every platform                                                                                                                                |
| B34 | Condensed header spacing                                                                                                                                                                                                                                                                       | Run 3: issue-5871                       | done — Keep PDFium condensed word spaces (fixes #5871)                                                                                                                      |
| B35 | External PDF viewers                                                                                                                                                                                                                                                                           | Run 3: issue-6184                       | done — Open PDFium tabs in known PDF viewers (fixes #6184)                                                                                                                  |
| B36 | Hosted window geometry                                                                                                                                                                                                                                                                         | Run 3: window tests                     | done — Size test windows within the work area                                                                                                                               |
| B37 | Cursor and RTL capture tests (full-suite run 3)                                                                                                                                                                                                                                                | Run 3: toolbar, issue-6113              | done — Fix review findings for B37                                                                                                                                          |
| B38 | PDF catalog layout                                                                                                                                                                                                                                                                             | Run 3: issue-2022                       | done — Honor PDF catalog layout (fixes #2022)                                                                                                                               |
| B39 | MuPDF shape placement                                                                                                                                                                                                                                                                          | Run 3: shape placement                  | done — Passes on hosted CI run 41349548951                                                                                                                                  |
| B40 | HTML next-file navigation                                                                                                                                                                                                                                                                      | Run 3: issue-5918                       | done — Wait out WebView2 cold start in issue-5918 test (B40)                                                                                                                |
| B41 | Palette tab deletion                                                                                                                                                                                                                                                                           | Run 4: PDFium only                      | done — Stabilize palette tab frame count (B41)                                                                                                                              |
| B42 | Home scrollbar assertion                                                                                                                                                                                                                                                                       | Run 4: issue-6367                       | done — Fix home scrollbar test (B42)                                                                                                                                        |
| B43 | Tab scroll assertion                                                                                                                                                                                                                                                                           | Run 4: issue-6405                       | done — Allow tab scroll rounding (B43)                                                                                                                                      |
| B44 | Gate the per-open catalog query (OpenAction, PageLayout, Direction) behind the existing geometry byte scan so PDFs without those keys skip it (~1 ms, 20 ms when encrypted)                                                                                                                    | `EnginePdfium`                          | done — Skip catalog query without catalog keys (B44)                                                                                                                        |
| B45 | Read-aloud restyle chapter                                                                                                                                                                                                                                                                     | Run 5: PDFium only                      | done — Record read-aloud restyle flake (B45)                                                                                                                                |
| B46 | AcroForm PDFs load the hidden MuPDF editor on first paint: `HighlightFormFields` reads empty fields via MuPDF; use PDFium's form API                                                                                                                                                           | B12: form fixture                       | done — Read form highlights with PDFium (B46)                                                                                                                               |
| B47 | Hovering an AcroForm page loads the hidden MuPDF editor: the widget cursor hit test, page elements and text extraction go through MuPDF; use PDFium                                                                                                                                            | B46: form fixture                       | done — Read form hover with PDFium (B47)                                                                                                                                    |
| B48 | PDFium image elements ignore clip paths: double-click and Ctrl+C cover a cropped photo's whole image (upstream #6441)                                                                                                                                                                          | D5: issue-6441                          | done — Clip PDFium image rects to clip paths (B48)                                                                                                                          |
| B49 | Hover's text prefetch loads the hidden MuPDF editor on a form page whose filled field draws text (CI: cursor over the page); keep PDFium text until a full read                                                                                                                                | B47: form fixture                       | done — Prefetch hover text without the editor (B49)                                                                                                                         |
| B50 | Full suite still fails on by-design PDFium gaps (`issue-5937`, `issue-6361`, `issue-3731`) and hosted-desktop cursor/capture tests (`toolbar-hover-dropdown`, `issue-6113`); skip them in `run-github-ci.ts` so a red weekly run means a regression                                            | B7 runs 6-7                             | done — Skip known full-suite failures in CI (B50)                                                                                                                           |
| B51 | B11 follow-up (review 2026-10-31): PDFium `TryGetElements`/`TryExtractPageText` still block or load the editor: editor-loaded form text, `useMupdfElements`/attachment pages, probe-then-relock race; search falls through to a blocking read and extracts form pages twice                    | review                                  | done — Keep PDFium Try reads off the editor (B51)                                                                                                                           |
| B52 | Printing a PDFium tab after Apply Redactions but before Save prints the unredacted file (print clones from disk); print the editor's redacted content                                                                                                                                          | review                                  | done — Print unsaved redactions (B52)                                                                                                                                       |
| B53 | B17 follow-ups (review): `EngineMupdfPageRedacted` takes the editor `docLock` and walks the journal on every render/hover once a page was redacted; step `-1` entries never clear; text invalidation races an in-flight extraction; recolor skip rects and `hideAnnotations` on redacted pages | review                                  | done — Track redacted pages without the editor lock (B53)                                                                                                                   |
| B57 | Ctrl+T opens a new Home tab like "+"                                                                                                                                                                                                                                                           | UI                                      | done — Bind Ctrl+T to a new Home tab (B57)                                                                                                                                  |
| B56 | `NoHomeTab` on by default: the first Home tab is replaced like "+"                                                                                                                                                                                                                             | UI                                      | done — Replace the first Home when opening a file (B56)                                                                                                                     |
| B54 | Theme-colored, spaced selection outlines (Home list, F12 thumbnails)                                                                                                                                                                                                                           | UI                                      | done — Match Home and F12 selection outlines (B54)                                                                                                                          |
| B55 | Theme-colored thumbnails (F12 and Home)                                                                                                                                                                                                                                                        | UI                                      | done — Color F12 and Home thumbnails with themes (B55); Fix review findings for B55                                                                                         |
| B58 | Tests that assume a wide window (issue-6464 tab widths, issue-6270)                                                                                                                                                                                                                            | tests                                   | done — Make tests independent of window size (B58)                                                                                                                          |
| B59 | Tests drive a test-only cursor position instead of the real cursor                                                                                                                                                                                                                             | tests                                   | done — Drive tests with a test cursor position (B59)                                                                                                                        |
| B60 | Test fixes: DPI clicks, TOC prefix, 6355 check                                                                                                                                                                                                                                                 | tests                                   | done — Fix DPI clicks and stale test inputs (B60)                                                                                                                           |
| B61 | PDFium: push-button links in keyboard following                                                                                                                                                                                                                                                | issue-1914                              | done — Read PDFium push-button links without editor (B61)                                                                                                                   |
| B63 | CI failures since B59                                                                                                                                                                                                                                                                          | tests                                   | done — Fix CI failures since B59 (B63); Fix review findings for B63                                                                                                         |
| B64 | Docs cleanup after B54–B63                                                                                                                                                                                                                                                                     | docs                                    | done — Update docs for test and UI changes (B64)                                                                                                                            |
| B65 | Full-suite regressions after B54–B64                                                                                                                                                                                                                                                           | app, tests                              | done — Save view on window close (fixes #4788)                                                                                                                              |
| B66 | Drive issue-6269 and attachment tab drag-out without the real pointer; limit explicit foreground activation to CI or opt-in                                                                                                                                                                    | tests                                   | done — Drive pointer-dependent tests by messages (B66); Fix review findings for B66                                                                                         |
| B67 | Keep test Copy, Cut and Paste off the system clipboard                                                                                                                                                                                                                                         | app, tests                              | done — Keep tests off the system clipboard (B67)                                                                                                                            |
| B68 | Open test windows behind other windows without activation; lint desktop input calls                                                                                                                                                                                                            | app, tests                              | done — Open test windows behind, unactivated (B68); Fix review findings for B68                                                                                             |
| B69 | Run local tests on a separate, invisible Windows desktop                                                                                                                                                                                                                                       | tests                                   | done — Run local tests on a hidden desktop (B69)                                                                                                                            |
| B70 | One settings screen, opened with Ctrl+,                                                                                                                                                                                                                                                        | UI, tests                               | done — Merge Settings into Advanced Settings (B70)                                                                                                                          |
| B71 | CI regressions after B65–B69                                                                                                                                                                                                                                                                   | hosted tests                            | done — Wait for tab scrolling to settle (B71)                                                                                                                               |
| B72 | Corpus PDFium/MuPDF pixel comparison in off, smart and legacy; route further PDFium gaps to MuPDF per page                                                                                                                                                                                     | 711 page pairs (5 corpus, 48 test PDFs) | done, route reverted: Revert "Route color-space reset paint to MuPDF (B72)" (cost on every page for a defect only synthetic fixtures showed); differences in limitations.md |
| B74 | Read Columns: center columns on the page area beside an overlay scrollbar                                                                                                                                                                                                                      | `ColumnViewX`, `FitColumnToWindow`      | done — Center Read Columns beside overlay scrollbar (B74)                                                                                                                   |
| B75 | `issue-6221`: check Mirror with overlay scrollbars against the page rect                                                                                                                                                                                                                       | `issue-6221`                            | done — Check Mirror against the page rect (B75)                                                                                                                             |

### C. Coexistence with SumatraPDF

| ID  | Item                                                                                                                                                                                             | Status                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| C1  | Own window class and other names that clash with an installed SumatraPDF (its installer closes `SUMATRA_PDF_FRAME` windows; `-reuse-instance`/`-dde` forward search finds the first such window) | done — Isolate SolokPDF process names |

### D. CI

| ID  | Item                                                                             | Status                                       |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| D1  | Release job in parallel with debug                                               | done — Run CI release build in parallel (D1) |
| D4  | Weekly scheduled full suite once it passes                                       | done — Schedule weekly full tests (D4)       |
| D5  | Weekly upstream merge assessment; merge when worthwhile, then run the full suite | done — Merge upstream f45967f87 (D5)         |
| D6  | Merge upstream/master at 254c2ae7c into solokpdf-dev                             | done — Merge upstream/master 254c2ae7c (D6)  |
| D7  | Merge upstream/master at 8b716234f into solokpdf-dev                             | done — Merge upstream/master 8b716234f (D7)  |

### E. Quality

| ID  | Item                                                                                                                                                                                                                                                                                        | Status                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Close the remaining startup gap shown by A1                                                                                                                                                                                                                                                 | done, no change needed: CI pairs put PDFium +2.3/+2.6 ms (normal open) and -1.3/-41.6 ms (direct launch) vs MuPDF on Attention/BERT                                                                                                     |
| E2  | Open/close/render leak stress                                                                                                                                                                                                                                                               | tool added (`--minutes=N`); 2-minute run passed, hours-long run not done                                                                                                                                                                |
| E5  | Tests write `SumatraPDF-settings.txt`, but SolokPDF reads `SolokPDF-settings.txt` (`SETTINGS_FILE`): their settings are silently ignored and they run on defaults. Found 2026-11-01 when `Scrollbars` defaulted to `overlay` (`issue-5850`, `issue-6062` fixed); 30+ `issue-*` tests remain | done — Write test settings to SETTINGS_FILE (E5): 114 tests; the ad-hoc pdfium / pdfium-session sentinels and ng mac-highlight keep SumatraPDF                                                                                          |
| E6  | ASan run of the render-route probe (pattern strokes, Type 3 alpha, color resets)                                                                                                                                                                                                            | done — Add nested Type 3 and widget route fixtures (E6): `pdfium-type3-alpha`, `pdfium-pattern-strokes` and `pdfium-color-reset` pass on the debug ASan build, including canceled probes, nested Type 3, forms, annotations and widgets |
| E7  | Theme tests: check dialog colors with `captureWindowDCToPng`; PrintWindow may paint dialogs in the OS theme                                                                                                                                                                                 | done — Read theme dialog colors from the window DC (E7): crops the client area; 4/4 runs passed                                                                                                                                         |
| E8  | Chapter field colors and states in built-in and custom themes                                                                                                                                                                                                                               | done — Check chapter box theme states (E8): no defect; `issue-6095.epub` (`issue-6007.epub` has one chapter)                                                                                                                            |
| E11 | Apply settings without reloading stale values under `-for-testing`                                                                                                                                                                                                                          | done — Apply settings without reloading disk values (2026-11-09); [validation](#e11-settings-application-2026-11-09)                                                                                                                    |
| E12 | Share keyboard input-target classification                                                                                                                                                                                                                                                  | done — Centralize keyboard input targets (E12); [validation](#e12-input-target-classification-2026-11-09); physical input remains F3                                                                                                    |
