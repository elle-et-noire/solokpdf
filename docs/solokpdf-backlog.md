# SolokPDF backlog

Ordered work list. Order: A → B13 → B1 → B2–B6 → D1–D3 → B7 (with B8–B12) → C1 → E1 →
E2 → D4/D5. Status: `todo`, `doing`, `done`, `blocked` (reason). Update
the status and add the commit when an item lands. Details and measurements go
in `solokpdf-progress.md`, not here.

Sources: a 2026-10-29 audit of every MuPDF-only gate outside the engines
(`kindEngineMupdf` comparisons and `AsEngineMupdf` helpers), the known
limitations in `solokpdf-progress.md`, and the upstream full suite
(`.github/workflows/solokpdf-full-tests.yml`).

## A. In progress

| ID  | Item                                                                 | Status                                                                                        |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A1  | PDFium vs MuPDF startup measurements on GitHub Actions               | done (normal open: PDFium +7.4 / +0.9 ms vs MuPDF on Attention / BERT; direct launch pending) |
| A2  | Page geometry detection inside object streams and files above 32 MiB | doing                                                                                         |

## B. PDFium feature gaps

Each one works on MuPDF tabs and silently does nothing on PDFium tabs.

| ID  | Item                                                                                                                                                                         | Where                                                                                            | Status                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------- |
| B13 | Hovering a page loads the hidden MuPDF editor for every PDF (Canvas `OnMouseMove` -> `GetAnnotationAtPos`), costing open time and memory and locking files of 32 MiB or more | `Canvas.cpp`, `EngineMupdfGetAnnotationAtPos`                                                    | todo (next, with B1)  |
| B1  | SyncTeX forward and inverse search                                                                                                                                           | `SumatraPDF.cpp` (pdfSync setup), `SearchAndDDECommon.cpp` `OnInverseSearch`, forward-search DDE | todo                  |
| B2  | PDF `/ViewerPreferences` print defaults (#534)                                                                                                                               | `Print.cpp` `GetPdfViewerPrintPrefs`                                                             | todo                  |
| B3  | Document Properties creation/modification date formatting                                                                                                                    | `DocumentPropertiesCommon.cpp` `isPdfDate`                                                       | todo                  |
| B4  | `FixedPageUI.WindowBgCol` page-surround color                                                                                                                                | `Canvas.cpp` `isPdf`                                                                             | todo                  |
| B5  | Engineering-drawing enhance (`CmdToggleEngineeringDrawingEnhance`): implement for PDFium or hide it                                                                          | `EngineMupdfToggleCadEnhance`                                                                    | todo                  |
| B6  | Theme change drops cached dark-mode analysis for PDFium tabs                                                                                                                 | `EngineMupdfInvalidateDarkMode`                                                                  | todo (verify first)   |
| B8  | "Fit content" zoom (`PageContentBox` not implemented)                                                                                                                        | `EnginePdfium`                                                                                   | todo (verify first)   |
| B9  | Copy/Save image under the cursor (`GetImageForPageElement`, `GetImageDataForPageElement`)                                                                                    | `EnginePdfium`                                                                                   | todo (verify first)   |
| B10 | Page boxes query (`GetPdfPageBoxes`)                                                                                                                                         | `EnginePdfium`                                                                                   | todo (verify first)   |
| B11 | Non-blocking `TryGetElements` / `TryExtractPageText` (UI thread waits otherwise)                                                                                             | `EnginePdfium`                                                                                   | todo (verify first)   |
| B12 | Test comparing every command's visibility/enabled state between engines on the same PDF                                                                                      | `TestCommandVisibility`                                                                          | todo                  |
| B7  | Upstream full-suite failures on PDFium, triaged and fixed                                                                                                                    | full-suite run                                                                                   | blocked (run pending) |

## C. Coexistence with SumatraPDF

| ID  | Item                                                                                                                                                                                             | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| C1  | Own window class and other names that clash with an installed SumatraPDF (its installer closes `SUMATRA_PDF_FRAME` windows; `-reuse-instance`/`-dde` forward search finds the first such window) | todo   |

## D. CI

| ID  | Item                                                                             | Status          |
| --- | -------------------------------------------------------------------------------- | --------------- |
| D1  | Release job in parallel with debug                                               | todo            |
| D2  | Compile cache (sccache) for CI builds                                            | todo            |
| D3  | Shard the full suite across runners                                              | todo            |
| D4  | Weekly scheduled full suite once it passes                                       | todo (after B7) |
| D5  | Weekly upstream merge assessment; merge when worthwhile, then run the full suite | todo            |

## E. Quality

| ID  | Item                                                | Status                                                                               |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| E1  | Close the remaining startup gap shown by A1         | likely unnecessary: normal-open gap is under 10 ms on CI; recheck with direct launch |
| E2  | Hours-long open/close/render leak stress            | todo                                                                                 |
| E3  | ASan build of the app with PDFium for the fuzz test | deferred (prebuilt PDFium isn't ASan)                                                |
| E4  | Transparent-page compositing parity                 | deferred (rare documents)                                                            |

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
