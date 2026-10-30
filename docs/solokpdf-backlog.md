# SolokPDF backlog

Ordered work list. Order: A → B13 → B1 → B2–B6 → C1 → B7 triage (pdfium vs mupdf full-suite runs) → fixes by
group (absorbing B5, B8–B12) → E2 → D1–D2 → D4/D5. Status: `todo`, `doing`, `done`, `blocked` (reason). Update
the status and add the commit when an item lands. `triaged` records a partial
suite result. Details and measurements go
in `solokpdf-progress.md`, not here.

Sources: a 2026-10-29 audit of every MuPDF-only gate outside the engines
(`kindEngineMupdf` comparisons and `AsEngineMupdf` helpers), the known
limitations in `solokpdf-progress.md`, and the upstream full suite
(`.github/workflows/solokpdf-full-tests.yml`).

## A. In progress

| ID  | Item                                                                 | Status                                                                                  |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A1  | PDFium vs MuPDF startup measurements on GitHub Actions               | done                                                                                    |
| A2  | Page geometry detection inside object streams and files above 32 MiB | done — Bound PDF page geometry scan (A2b); large and encrypted PDFs use PDFium geometry |

## B. PDFium feature gaps

Each one works on MuPDF tabs and silently does nothing on PDFium tabs.

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
| B11 | Non-blocking `TryGetElements` / `TryExtractPageText` (UI thread waits otherwise)                                                                                             | `EnginePdfium`                                                                                   | todo — B23 matches                                                                                |
| B12 | Test comparing every command's visibility/enabled state between engines on the same PDF                                                                                      | `TestCommandVisibility`                                                                          | todo                                                                                              |
| B7  | Triage upstream full-suite failures                                                                                                                                          | full-suite run                                                                                   | done — Triage complete paired full-suite logs (B7); 462 reached per engine, 122 distinct failures |

### B7 follow-ups

| ID  | Item                         | Evidence                     | Status                                                                               |
| --- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| B14 | PDFium text extraction       | B7 text group                | done — Extract PDFium text without routine editor loads (B14)                        |
| B15 | PDFium search                | B7 search group              | done — Join PDFium hyphenated search text (fixes #1189)                              |
| B16 | PDFium links                 | B7 links group               | done — Link wrapped URLs in PDFium (fixes #2239)                                     |
| B17 | PDFium annotations           | B7 annotations group         | blocked — Redaction reload loses undo journal; cursor tests need an unlocked session |
| B18 | PDFium images                | B7 images group              | done — Enable PDFium image actions (fixes #6214)                                     |
| B19 | PDFium fit content           | B7 layout group              | done — Fit PDFium content bounds (fixes #6241)                                       |
| B20 | PDFium page boxes            | B7 page boxes group          | done — Report PDFium page boxes (fixes #814)                                         |
| B21 | PDFium CAD enhance           | B7 CAD group                 | blocked — PDFium lacks CAD render controls; color changes barred                     |
| B22 | PDFium bookmark colors       | B7 rendering group           | done — Honor PDFium bookmark styles (fixes #3560)                                    |
| B23 | PDFium scroll responsiveness | B7 responsiveness group      | done — Skip PDFium hover queries while a render holds its lock (fixes #6362)         |
| B24 | PDFium XMP properties        | B7 XMP group                 | done — Fill PDFium XMP properties from lazy editor                                   |
| B25 | Restore lazy session tab     | B7 R: lazy tab no-doc        | blocked — test seeds wrong file and disables opened-file memory                      |
| B26 | PDFium comment authors       | B7 R: issue-5329             | done — Verify PDFium comment authors                                                 |
| B27 | PDFium external images       | B7 R: issue-3731             | blocked — PDFium lacks external stream loader; editor render barred                  |
| B28 | PDFium TOC selection         | B7 P: toc-selection-visible  | done — Select PDFium bookmarks under the hidden tree root                            |
| B29 | PDFium trim margins          | B7 P: issue-trim-margins     | done — Keep narrow text bounds when trimming                                         |
| B30 | Shared UI command hangs      | B7 R: issue-5979, issue-6017 | done — Avoid modal AI install dialog in tests                                        |
| B31 | Control output assertions    | Run 3: issue-5944, issue-906 | done — Accept current `screen` and `rect` fields                                     |
| B32 | CI annotation cursor         | Run 3: annotation CI         | done — Park cursor before checking lazy editor                                       |
| B33 | Trim restore assertion       | Run 3: trim restore          | done — Compare page aspect on every platform                                         |
| B34 | Condensed header spacing     | Run 3: issue-5871            | done — Keep PDFium condensed word spaces (fixes #5871)                               |
| B35 | External PDF viewers         | Run 3: issue-6184            | done — Open PDFium tabs in known PDF viewers (fixes #6184)                           |
| B36 | Hosted window geometry       | Run 3: window tests          | done — Size test windows within the work area                                        |
| B37 | Cursor and RTL capture tests | Run 3: input and capture     | blocked — Locked desktop prevents cursor and capture checks                          |
| B38 | PDF catalog layout           | Run 3: issue-2022            | blocked — PDFium has no public PageLayout query; routine editor load barred          |
| B39 | MuPDF shape placement        | Run 3: shape placement       | blocked — Cursor stays at origin on locked desktop                                   |
| B40 | HTML next-file navigation    | Run 3: issue-5918            | blocked — Local reruns fail both engines; cause unisolated                           |
| B41 | Palette tab deletion         | Run 4: PDFium only           | done — Record palette flake (B41)                                                     |
| B42 | Home scrollbar assertion     | Run 4: issue-6367            | done — Fix home scrollbar test (B42)                                                  |
| B43 | Tab scroll assertion         | Run 4: issue-6405            | done — Allow tab scroll rounding (B43)                                                |

## C. Coexistence with SumatraPDF

| ID  | Item                                                                                                                                                                                             | Status                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| C1  | Own window class and other names that clash with an installed SumatraPDF (its installer closes `SUMATRA_PDF_FRAME` windows; `-reuse-instance`/`-dde` forward search finds the first such window) | done — Isolate SolokPDF process names |

## D. CI

| ID  | Item                                                                             | Status                                                                                 |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| D1  | Release job in parallel with debug                                               | todo                                                                                   |
| D2  | Compile cache (sccache) for CI builds                                            | todo                                                                                   |
| D3  | Shard the full suite across runners                                              | deferred: the suite takes ~25 min once a hung test is cut off (per-test timeout added) |
| D4  | Weekly scheduled full suite once it passes                                       | todo (after B7)                                                                        |
| D5  | Weekly upstream merge assessment; merge when worthwhile, then run the full suite | todo                                                                                   |

## E. Quality

| ID  | Item                                                | Status                                                                                                                              |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Close the remaining startup gap shown by A1         | done, no change needed: CI pairs put PDFium +2.3/+2.6 ms (normal open) and -1.3/-41.6 ms (direct launch) vs MuPDF on Attention/BERT |
| E2  | Hours-long open/close/render leak stress            | todo                                                                                                                                |
| E3  | ASan build of the app with PDFium for the fuzz test | deferred (prebuilt PDFium isn't ASan)                                                                                               |
| E4  | Transparent-page compositing parity                 | deferred (rare documents)                                                                                                           |

## F. Needs the owner

| ID  | Item                                             |
| --- | ------------------------------------------------ |
| F1  | Physical printer, print dialog and spooler check |

## Not planned

XFA editing and GoToE (unsupported in both engines); `src/ng/`; distribution
(GitHub Releases, update checks, release criteria): the owner has no plans to
distribute. Explorer thumbnails/preview (needs DLL registration; little value
for one user). The default-app association already works through
`Applications\SolokPDF.exe`.
