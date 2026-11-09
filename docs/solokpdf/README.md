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

Repository reviewed at `cf2696d15` on `solokpdf-dev`; latest tested revisions
are recorded below. E11's in-memory settings application,
E12's shared input-target classification and E13's targeted routing checks are implemented.
Tree acceptance (E10/F2) is complete by owner report; D8's hosted follow-ups
are verified. D10's merged-UI review and D11's MuPDF patch comparison are
complete. D9's eleven targets passed three hosted runs per engine. F1/F3
remain manual checks. See the [backlog](backlog.md). Results retain their
source commits, dates and scope.

| Area           | Current state                                                                                                                                  | Details                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | PDFium renders PDFs; MuPDF is the fallback and lazy editor.                                                                                    | [Limitations](limitations.md), [annotations](annotations.md), [forms](forms.md)                                      |
| Upstream       | Merged through `8b716234f` on 2026-11-08 (D7); recorded validation follow-ups are closed.                                                      | [Merge status](upstream-merges.md#current-status-2026-11-09)                                                         |
| Text selection | Theme-colored translucent overlays; selection-only glyph rendering removed.                                                                    | [Current colors](features.md#selection-colors), [implementation record](selection-overlay-plan.md)                   |
| Sidebar trees  | Virtual bookmarks and favorites are the default in Debug and Release; the owner reported all F2 checks OK on 2026-11-09 (E10 complete).        | [Migration plan and results](tree-view-replacement-plan.md), [manual reader check](tree-view-screen-reader-check.md) |
| Keyboard input | E12 classification and E13 route checks implemented; special-mode counts clear and Alt+arrows operate find history. Physical input remains F3. | [Investigation and results](keyboard-investigation.md), [handoff](keyboard-handoff.md)                               |
| Settings       | Palette and settings-screen changes apply in memory; `-for-testing` keeps the settings file unchanged (E11).                                   | [Behavior](features.md#settings), [validation](history.md#e11-settings-application-2026-11-09)                       |
| Remaining work | F1 printing and F3 physical keys; suite sharding is deferred.                                                                                  | [Backlog](backlog.md)                                                                                                |

### Validation scope

These are existing records, not new test runs from this documentation review.

| Check                   | Tested revision          | Recorded result                                                                                                  |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Latest regular CI       | `b24b868b9`              | Debug/Release jobs, 105055 unit tests and 65/65 feature tests passed; [record](history.md#hosted-triage).        |
| Scheduled full suites   | `99ba47b52`              | PDFium 574/584, MuPDF 577/587; [eleven distinct failures](history.md#d9-scheduled-suite-failures-2026-11-09).    |
| D9 targeted rechecks    | `b24b868b9`, `4ad4c30ae` | All eleven targets passed three hosted runs per engine; [record](history.md#hosted-triage). No full suite rerun. |
| F2 physical tree checks | Build unspecified        | Owner reported all checks OK; [record and evidence limits](tree-view-screen-reader-check.md#実施結果).           |

## Resuming work

Read [agents.md](../../agents.md), [readme.md](../../readme.md), this file and
[backlog.md](backlog.md), then the current behavior and plan for the area at hand.

- F1 and F3 require the [owner's manual checks](testing.md#owners-manual-acceptance-f1f3).
- For a code change, select the affected tests in [testing.md](testing.md).
  Run full suites only when explicitly requested.

Build instructions are in the root readme. All local app-launching tests use
the [hidden-desktop runner](testing.md#local-windows-runs).

## Source map

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

| Purpose            | Documents                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Current behavior   | [features.md](features.md), [limitations.md](limitations.md), [annotations.md](annotations.md), [forms.md](forms.md)                      |
| Open work          | [backlog.md](backlog.md)                                                                                                                  |
| Tree migration     | [tree-view-replacement-plan.md](tree-view-replacement-plan.md), [tree-view-screen-reader-check.md](tree-view-screen-reader-check.md)      |
| Keyboard follow-up | [Current routing, E12/E13 results and physical checks](keyboard-investigation.md); [original handoff](keyboard-handoff.md)                |
| Test procedures    | [Local automated tests](testing.md#local-windows-runs), [owner's manual acceptance](testing.md#owners-manual-acceptance-f1f3)             |
| Historical results | [History navigation](history.md#navigation), [upstream merges](upstream-merges.md), [completed selection plan](selection-overlay-plan.md) |
| Measurements       | [data/](data/), cited by `history.md`                                                                                                     |

## Keeping docs current

Keep current behavior in `features.md` and `limitations.md`, open work in
`backlog.md`, and dated results in `history.md`. Mark completed plans with their
implementation commit; retain their original acceptance criteria as history.
Move completed backlog rows to [history.md](history.md#completed-backlog).
Record upstream merges in `upstream-merges.md` and measurements in `data/`.
Update this status when the default behavior or active work changes. Keep test
results dated and distinguish automated checks from pending manual checks.
