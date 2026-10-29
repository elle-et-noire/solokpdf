# SolokPDF backlog

Ordered work list. Status: `todo`, `doing`, `done`, `blocked` (reason). Update
the status and add the commit when an item lands. Details and measurements go
in `solokpdf-progress.md`, not here.

Sources: a 2026-10-29 audit of every MuPDF-only gate outside the engines
(`kindEngineMupdf` comparisons and `AsEngineMupdf` helpers), the known
limitations in `solokpdf-progress.md`, and the upstream full suite
(`.github/workflows/solokpdf-full-tests.yml`).

## A. In progress

| ID  | Item                                                                 | Status |
| --- | -------------------------------------------------------------------- | ------ |
| A1  | PDFium vs MuPDF startup measurements on GitHub Actions               | doing  |
| A2  | Page geometry detection inside object streams and files above 32 MiB | doing  |

## B. PDFium feature gaps

Each one works on MuPDF tabs and silently does nothing on PDFium tabs.

| ID  | Item                                                                                                | Where                                                                                            | Status                |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------- |
| B1  | SyncTeX forward and inverse search                                                                  | `SumatraPDF.cpp` (pdfSync setup), `SearchAndDDECommon.cpp` `OnInverseSearch`, forward-search DDE | todo                  |
| B2  | PDF `/ViewerPreferences` print defaults (#534)                                                      | `Print.cpp` `GetPdfViewerPrintPrefs`                                                             | todo                  |
| B3  | Document Properties creation/modification date formatting                                           | `DocumentPropertiesCommon.cpp` `isPdfDate`                                                       | todo                  |
| B4  | `FixedPageUI.WindowBgCol` page-surround color                                                       | `Canvas.cpp` `isPdf`                                                                             | todo                  |
| B5  | Engineering-drawing enhance (`CmdToggleEngineeringDrawingEnhance`): implement for PDFium or hide it | `EngineMupdfToggleCadEnhance`                                                                    | todo                  |
| B6  | Theme change drops cached dark-mode analysis for PDFium tabs                                        | `EngineMupdfInvalidateDarkMode`                                                                  | todo (verify first)   |
| B7  | Upstream full-suite failures on PDFium, triaged and fixed                                           | full-suite run                                                                                   | blocked (run pending) |

## C. Integration and distribution

| ID  | Item                                                                                                                        | Status          |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------- |
| C1  | File associations under a SolokPDF ProgID (no clash with SumatraPDF); "default app" and "Open with" from the portable build | todo            |
| C2  | Explorer thumbnails and preview pane through PDFium, shipped in the ZIP                                                     | todo (after C1) |

## D. CI

| ID  | Item                                       | Status          |
| --- | ------------------------------------------ | --------------- |
| D1  | Release job in parallel with debug         | todo            |
| D2  | Compile cache (sccache) for CI builds      | todo            |
| D3  | Shard the full suite across runners        | todo            |
| D4  | Weekly scheduled full suite once it passes | todo (after B7) |

## E. Quality

| ID  | Item                                                | Status          |
| --- | --------------------------------------------------- | --------------- |
| E1  | Close the remaining startup gap shown by A1         | todo (after A1) |
| E2  | Hours-long open/close/render leak stress            | todo            |
| E3  | ASan build of the app with PDFium for the fuzz test | todo            |
| E4  | Transparent-page compositing parity                 | todo            |

## F. Needs the owner

| ID  | Item                                             |
| --- | ------------------------------------------------ |
| F1  | Physical printer, print dialog and spooler check |

## Not planned

XFA editing and GoToE (unsupported in both engines); `src/ng/`; distribution
(GitHub Releases, update checks, release criteria): the owner has no plans to
distribute.
