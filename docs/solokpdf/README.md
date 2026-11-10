# SolokPDF docs

SolokPDF is a Windows fork of SumatraPDF that renders PDFs with PDFium. MuPDF
remains as the fallback (`SOLOKPDF_ENGINE=mupdf` selects it for comparison)
and as a hidden editor of the same file, loaded only for annotations, forms,
signatures, redaction, document JavaScript and data PDFium lacks. Only the
original Win32 application is in scope; `src/ng/` is not.

## Priority

The move to PDFium is for its current text appearance: the user wants to avoid
MuPDF's thinner-looking text. Preserve PDFium's font selection, antialiasing,
render resolution and color processing. Do not switch the default to MuPDF to
meet memory/startup targets. Font-info v2 remains probe-only because it changes
rendered output.

## Status (2026-11-10)

The CI coverage baseline is `9083edafe` on `solokpdf-dev`. It commits four virtual-tree checks in
regular CI (D13) and a manual/weekly ASan workflow (E17).
[Latest regular CI](https://github.com/elle-et-noire/solokpdf/actions/runs/42755793358)
passed Debug/Release builds, 105115 unit tests and 70/70 feature tests at `7d107cea8`.
D13's four tree checks passed. E17's first hosted ASan build passed, but both
tests failed at startup because the staged ASan DLL lacks required exports;
see the [hosted validation record](history.md#hosted-d13e17-validation-2026-11-10).
The runtime-selection fix passed regression checks, an ASan build and
both affected tests three times each; hosted validation of that fix remains pending.
E10–E16 and D8–D13 are complete within their recorded scope.
E18–E22 are complete within their recorded validation scope; see the
[refactoring plan](refactoring-plan.md) and [backlog](backlog.md).
Planning docs are committed as `9e1eaac3b`; E21's shared color-stage selection
is committed as `8bf864e18`. Effective-color input capture completes E21.
The color-input change passed Debug/Release builds and seven targeted Debug
configurations; [E21's latest record](history.md#e21-effective-color-inputs-2026-11-10)
includes the 66-image comparison and validation scope. The earlier baseline
thumbnail-test failure remains unresolved. E19's render-result contracts are
implemented as `Clarify render result contracts (E19)`; [results and scope](history.md#e19-render-results-2026-11-10)
record the targeted checks and pixel comparison.
E22 aligns render-input snapshots with cache generations and rejects stale tile/F12 results.
Its implementation, cache inventory and validation are in the
[E22 record](history.md#e22-cache-contracts-2026-11-10).
E18 clarifies form read results, prevents paint from loading the editor and makes
MuPDF's Try text read decline on document-lock contention. Failed editor loads
retain partial text without marking the cache complete. Implementation and
targeted local validation are in the [E18 record](history.md#e18-read-contracts-2026-11-10).
E20 keeps editing, cloning, auxiliary reads and Save As on the retained input.
Ownership, lock ordering and targeted Debug/ASan results are in the
[E20 record](history.md#e20-document-lifetime-2026-11-10).
F2 passed by owner report. F1/F3 were
removed from active work by the owner on 2026-11-10, without being marked passed.

| Area           | Current state                                                                                                                                     | Details                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | PDFium renders PDFs; MuPDF is the fallback and lazy editor.                                                                                       | [Limitations](limitations.md), [annotations](annotations.md), [forms](forms.md)                                      |
| Upstream       | Merged through `8b716234f` on 2026-11-08 (D7); recorded validation follow-ups are closed.                                                         | [Merge status](upstream-merges.md#current-status-2026-11-09)                                                         |
| Text selection | Theme-colored translucent overlays; selection-only glyph rendering removed.                                                                       | [Current colors](features.md#selection-colors), [implementation record](selection-overlay-plan.md)                   |
| Sidebar trees  | Virtual bookmarks and favorites are the default in Debug and Release; the owner reported all F2 checks OK on 2026-11-09 (E10 complete).           | [Migration plan and results](tree-view-replacement-plan.md), [manual reader check](tree-view-screen-reader-check.md) |
| Keyboard input | E12 classification, E13 route checks and count/prefix state separation implemented.                                                               | [Investigation and results](keyboard-investigation.md), [handoff](keyboard-handoff.md)                               |
| Settings       | Palette and settings-screen changes apply in memory; `-for-testing` keeps the settings file unchanged (E11).                                      | [Behavior](features.md#settings), [validation](history.md#e11-settings-application-2026-11-09)                       |
| Refactoring    | Tree layout/internals, PDFium runtime and pending key state are separated in four committed changes; review complete by owner confirmation (E15). | [Results](history.md#navigation), [review](history.md#e15-refactor-review-2026-11-10)                                |

### Validation scope

Results apply only to the revisions and checks listed here. Regular CI does not
run ASan. The ASan workflow's scope is in [testing.md](testing.md#asan-ci).

| Check                    | Tested revision                    | Recorded result                                                                                                                                                                      |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D13 regular CI           | `9083edafe`, `7d107cea8`           | Both runs passed Debug/Release builds and Debug tests; all four added tree checks passed at `7d107cea8`; [results](history.md#hosted-d13e17-validation-2026-11-10).                  |
| Latest successful CI     | `7d107cea8`                        | Debug/Release builds, 105115 unit tests and 70/70 feature tests passed; [results](history.md#hosted-d13e17-validation-2026-11-10).                                                   |
| E17 hosted ASan          | `7d107cea8`; runtime-selection fix | Hosted build passed; both tests failed with an incompatible ASan DLL. The fix passed both tests three times each locally; [results](history.md#hosted-d13e17-validation-2026-11-10). |
| F2 physical tree checks  | Build unspecified                  | Owner reported all checks OK; [record and evidence limits](tree-view-screen-reader-check.md#実施結果).                                                                               |
| D13/E17 local validation | Change committed as `9083edafe`    | Four added tree checks, complete Debug PDFium test, clean ASan build and both ASan checks passed before commit; [results](history.md#ci-coverage-expansion-2026-11-10).              |

Earlier suite results, targeted rechecks and refactor validation remain in
[history.md](history.md#navigation).

E16 replaces the direct-project ASan workaround with `bun cmd/solok-build.ts -asan`,
staging PDFium and the ASan runtime beside the executable. Test staging also
preserves the ASan DLL. See the [procedure](testing.md#asan-builds).

## Resuming work

Read [agents.md](../../agents.md), [readme.md](../../readme.md), this file and
[backlog.md](backlog.md), then the current behavior and plan for the area at hand.

- E17's local runtime-selection fix needs hosted validation; see the [backlog](backlog.md#next-steps).
- For design work, read the [current architecture](architecture.md) and
  [refactoring plan](refactoring-plan.md). E21 is complete within its recorded
  validation scope. E18/E19/E20/E22 are complete within their recorded scope.
- For a code change, select the affected tests in [testing.md](testing.md).
  Run full suites only when explicitly requested.

Build instructions are in the root readme. All local app-launching tests use
the [hidden-desktop runner](testing.md#local-windows-runs).
Release builds run only in GitHub Actions; use Debug/ASan locally.

## Source map

Responsibilities, state and API contracts are in [architecture.md](architecture.md).

| Area           | Entry points                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | [EnginePdfium.cpp](../../src/solokpdf/EnginePdfium.cpp), [engine selection](../../src/shared/EngineCreate.cpp)                                                                                                 |
| PDFium runtime | [PdfiumRuntime.cpp](../../src/solokpdf/PdfiumRuntime.cpp) (DLL lifetime and font-cache setup); [boundary and validation](history.md#pdfium-runtime-boundary-2026-11-10)                                        |
| Sidebar trees  | [SidebarTree.cpp](../../src/SidebarTree.cpp), [VirtTree.cpp](../../src/VirtTree.cpp), [tree state](../../src/gui/win/VirtTreeState.cpp)                                                                        |
| Keyboard input | [MainWindow.cpp](../../src/MainWindow.cpp) (`GetKeyTarget`), [SumatraPDF.cpp](../../src/SumatraPDF.cpp) (routing), [VimKeys.cpp](../../src/VimKeys.cpp), [Accelerators.cpp](../../src/shared/Accelerators.cpp) |
| Key state      | [KeyInputState.cpp](../../src/KeyInputState.cpp) (count/prefix transitions); [boundary](keyboard-investigation.md#状態管理の分離2026-11-10)                                                                    |
| Settings       | [AppSettings.cpp](../../src/shared/AppSettings.cpp) (`ApplySettingsToOpenWindows`), [AdvancedSettingsDialog.cpp](../../src/AdvancedSettingsDialog.cpp)                                                         |
| Build          | [solok-build.ts](../../cmd/solok-build.ts); delegates to the original build entry point                                                                                                                        |
| GUI tests      | [Hidden-desktop runner](../../tools/solokpdf/run-hidden.ts), [sidebar test helpers](../../tests/sidebar-tree.ts); follow [testing.md](testing.md)                                                              |

## Document map

| Purpose                  | Documents                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Current behavior         | [features.md](features.md), [limitations.md](limitations.md), [annotations.md](annotations.md), [forms.md](forms.md)                      |
| Work status              | [Active, deferred and excluded work](backlog.md)                                                                                          |
| Design and planned work  | [Current architecture](architecture.md), [refactoring plan](refactoring-plan.md)                                                          |
| Completed tree migration | [Plan and results](tree-view-replacement-plan.md), [owner's acceptance](tree-view-screen-reader-check.md)                                 |
| Keyboard input           | [Current routing and results](keyboard-investigation.md); [historical handoff](keyboard-handoff.md)                                       |
| Test procedures          | [Local automated tests](testing.md#local-windows-runs), [historical manual checks](testing.md#owners-manual-acceptance-f1f3)              |
| Historical results       | [History navigation](history.md#navigation), [upstream merges](upstream-merges.md), [completed selection plan](selection-overlay-plan.md) |
| Measurements             | [data/](data/), cited by `history.md`                                                                                                     |

## Keeping docs current

Keep current behavior in `features.md` and `limitations.md`, open work in
`backlog.md`, and dated results in `history.md`. Mark completed plans with their
implementation commit; retain their original acceptance criteria as history.
Keep responsibilities and contracts in `architecture.md`; keep proposed changes
and their completion criteria in `refactoring-plan.md`.
Move completed backlog rows to [history.md](history.md#completed-backlog).
Record upstream merges in `upstream-merges.md` and measurements in `data/`.
Update this status when the default behavior or active work changes. Keep test
results dated and distinguish automated checks from pending manual checks.
