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

## Status (2026-11-09)

Reviewed through `c3859f4a7` on `solokpdf-dev`: E11's in-memory settings application,
E12's shared input-target classification and E13's targeted routing checks are implemented.
Tree acceptance (E10/F2) is complete by owner report. Printing (F1), physical
keyboard input (F3) and hosted CI checks remain open. Build and test results
retain the dates and scope recorded with each change.

| Area           | Current state                                                                                                                                  | Details                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | PDFium renders PDFs; MuPDF is the fallback and lazy editor.                                                                                    | [Limitations](limitations.md), [annotations](annotations.md), [forms](forms.md)                                      |
| Upstream       | Merged through `8b716234f` on 2026-11-08 (D7).                                                                                                 | [Merge results and remaining checks](upstream-merges.md#merge-result-2026-11-08)                                     |
| Text selection | Theme-colored translucent overlays; selection-only glyph rendering removed.                                                                    | [Current colors](features.md#selection-colors), [implementation record](selection-overlay-plan.md)                   |
| Sidebar trees  | Virtual bookmarks and favorites are the default in Debug and Release; the owner reported all F2 checks OK on 2026-11-09 (E10 complete).        | [Migration plan and results](tree-view-replacement-plan.md), [manual reader check](tree-view-screen-reader-check.md) |
| Keyboard input | E12 classification and E13 route checks implemented; special-mode counts clear and Alt+arrows operate find history. Physical input remains F3. | [Investigation and results](keyboard-investigation.md), [handoff](keyboard-handoff.md)                               |
| Settings       | Palette and settings-screen changes apply in memory; `-for-testing` keeps the settings file unchanged (E11).                                   | [Behavior](features.md#settings), [validation](history.md#e11-settings-application-2026-11-09)                       |
| Remaining work | F1 printing, F3 physical keyboard checks, D8 remaining hosted evidence and D9 scheduled-suite triage; suite sharding is deferred.              | [Backlog](backlog.md)                                                                                                |

## Resuming work

Read [agents.md](../../agents.md), [readme.md](../../readme.md), this file and
[backlog.md](backlog.md), then the current behavior and plan for the area at hand.
E11, E12 and E13 are implemented. The [input-target results](keyboard-investigation.md#入力先共通化の結果e122026-11-09)
and [E13 checks](keyboard-investigation.md#自動テストの経路確認e13) record automated coverage.
Tree migration E10 is complete with [F2 owner acceptance](tree-view-screen-reader-check.md#実施結果).
D8's [audit](history.md#d8-hosted-validation-audit-2026-11-09) closes startup capture,
palette and tab-view follow-ups; explicit 100% DPI evidence remains. The test
now logs DPI; targeted hosted reruns follow committing and pushing that change.
D9 tracks 11 distinct failures in the later scheduled full-test run. D7's
[merge record](upstream-merges.md#merge-result-2026-11-08) lists its remaining validation.
Build instructions are in the root readme; local GUI tests follow
[testing.md](testing.md). Screen-reader and physical-device checks have separate
manual steps; automated checks do not establish those results.

## Source map

| Area           | Entry points                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | [EnginePdfium.cpp](../../src/solokpdf/EnginePdfium.cpp), [engine selection](../../src/shared/EngineCreate.cpp)                                                                                                 |
| Sidebar trees  | [SidebarTree.cpp](../../src/SidebarTree.cpp), [VirtTree.cpp](../../src/VirtTree.cpp), [tree state](../../src/gui/win/VirtTreeState.cpp)                                                                        |
| Keyboard input | [MainWindow.cpp](../../src/MainWindow.cpp) (`GetKeyTarget`), [SumatraPDF.cpp](../../src/SumatraPDF.cpp) (routing), [VimKeys.cpp](../../src/VimKeys.cpp), [Accelerators.cpp](../../src/shared/Accelerators.cpp) |
| Settings       | [AppSettings.cpp](../../src/shared/AppSettings.cpp) (`ApplySettingsToOpenWindows`), [AdvancedSettingsDialog.cpp](../../src/AdvancedSettingsDialog.cpp)                                                         |
| Build          | [solok-build.ts](../../cmd/solok-build.ts); delegates to the original build entry point                                                                                                                        |
| GUI tests      | [Hidden-desktop runner](../../tools/solokpdf/run-hidden.ts), [sidebar test helpers](../../tests/sidebar-tree.ts); follow [testing.md](testing.md)                                                              |

## Document map

| Purpose            | Documents                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Current behavior   | [features.md](features.md), [limitations.md](limitations.md), [annotations.md](annotations.md), [forms.md](forms.md)                 |
| Open work          | [backlog.md](backlog.md)                                                                                                             |
| Tree migration     | [tree-view-replacement-plan.md](tree-view-replacement-plan.md), [tree-view-screen-reader-check.md](tree-view-screen-reader-check.md) |
| Keyboard follow-up | [Current routing, E12/E13 results and physical checks](keyboard-investigation.md); [original handoff](keyboard-handoff.md)           |
| Test procedures    | [Local automated tests](testing.md#local-windows-runs), [owner's manual acceptance](testing.md#owners-manual-acceptance-f1f3)        |
| Historical results | [history.md](history.md), [upstream-merges.md](upstream-merges.md), [selection-overlay-plan.md](selection-overlay-plan.md)           |
| Measurements       | [data/](data/), cited by `history.md`                                                                                                |

## Keeping docs current

Keep current behavior in `features.md` and `limitations.md`, open work in
`backlog.md`, and dated results in `history.md`. Mark completed plans with their
implementation commit; retain their original acceptance criteria as history.
Move completed backlog rows to [history.md](history.md#completed-backlog).
Record upstream merges in `upstream-merges.md` and measurements in `data/`.
Update this status when the default behavior or active work changes. Keep test
results dated and distinguish automated checks from pending manual checks.
