# SolokPDF docs

SolokPDF is a Windows fork of SumatraPDF that renders PDFs with PDFium. MuPDF
remains as the fallback (`SOLOKPDF_ENGINE=mupdf` selects it for comparison)
and as a hidden editor of the same file, loaded only for annotations, forms,
signatures, redaction, document JavaScript and data PDFium lacks. Only the
original Win32 application is in scope; `src/ng/` is not.

## Priority

The move to PDFium is for its current text appearance: the user wants to avoid
MuPDF's thinner-looking text. Preserve current display quality; changes to
rendering output require checking their purpose and visual impact. Do not switch the default to MuPDF to
meet memory/startup targets. Font-info v2 remains probe-only because it changes
rendered output.

## Status (2026-11-10)

Status snapshot at `c27fcd623` plus E31 changes on `solokpdf-dev`.
D8–D13 and E10–E31 are complete within their recorded scope.
E24's [review](full-review-results.md#e24-完了確認) records eleven defects and a shutdown contract issue;
E25's [priorities, dependencies and remaining work](full-review-results.md#e25-再点検) are complete.
E26 preserves unsaved edits and active form input during automatic reload; [results](history.md#e26-automatic-reload-2026-11-10).
E27 keeps the save prompt after source loss and gates saving on retained input; [results](history.md#e27-missing-source-2026-11-10).
E28 rolls back failed signature preparation; [results](history.md#e28-signature-rollback-2026-11-10).
E29 refreshes form text, search and selection after edits and Undo/Redo; [results](history.md#e29-form-text-cache-2026-11-10).
E30 versions network comic caches and publishes complete copies; [results](history.md#e30-network-comic-cache-2026-11-10).
E31 closes asynchronous controller-delete thread handles; [results](history.md#e31-controller-delete-handles-2026-11-10).
E32 retains worker dependencies when shutdown cannot finish; [results](history.md#e32-worker-shutdown-2026-11-10).
E33 retries failed page text extraction; [results](history.md#e33-text-extraction-failure-2026-11-10).
E34 validates document targets after dialogs; [results](history.md#e34-dialog-targets-2026-11-10).
E35 preserves choice-field validation rejection; [results](history.md#e35-choice-validation-2026-11-10).
[backlog.md](backlog.md) records E36–E37's fixes and regression checks,
deferred work and exclusions.

The completed E18–E22 review covers color inputs, render results, cache
invalidation, read contracts and document lifetime. Read the
[current architecture](architecture.md) for the resulting contracts and the
[completed plan](refactoring-plan.md) for implementation commits and evidence.

| Area           | Current state                                                                                                                             | Details                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | PDFium renders PDFs; MuPDF is the fallback and lazy editor.                                                                               | [Limitations](limitations.md), [annotations](annotations.md), [forms](forms.md)                                                         |
| Upstream       | Merged through `8b716234f` on 2026-11-08 (D7); recorded validation follow-ups are closed.                                                 | [Merge status](upstream-merges.md#current-status-2026-11-09)                                                                            |
| Text selection | Theme-colored translucent overlays; selection-only glyph rendering removed.                                                               | [Current colors](features.md#selection-colors), [implementation record](selection-overlay-plan.md)                                      |
| Sidebar trees  | Virtual bookmarks and favorites are the default in Debug and Release; the owner reported all F2 checks OK on 2026-11-09 (E10 complete).   | [Migration plan and results](tree-view-replacement-plan.md), [manual reader check](tree-view-screen-reader-check.md)                    |
| Keyboard input | E12 classification, E13 route checks and count/prefix state separation implemented.                                                       | [Investigation and results](keyboard-investigation.md), [handoff](keyboard-handoff.md)                                                  |
| Settings       | Palette and settings-screen changes apply in memory; `-for-testing` keeps the settings file unchanged (E11).                              | [Behavior](features.md#settings), [validation](history.md#e11-settings-application-2026-11-09)                                          |
| Refactoring    | Tree, runtime and key-state separation (E15), plus rendering/read/lifetime contracts (E18–E22), are complete within their recorded scope. | [Current architecture](architecture.md), [completed plan](refactoring-plan.md), [E15 review](history.md#e15-refactor-review-2026-11-10) |
| Code review    | E23–E25 complete within scope; priorities, dependencies and remaining work recorded. Product fixes remain open.                           | [Results and evidence](full-review-results.md), [work items](backlog.md#design-review)                                                  |

### Validation scope

These are recorded results, not a fresh CI-status check. Results apply only to
the tested revisions and checks. Regular CI does not run ASan; Release was
built and packaged, not feature-tested.

| Check                   | Tested revision          | Recorded result                                                                                                                                                                                                          |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Regular CI (D13)        | `9083edafe`, `7d107cea8` | Both passed Debug/Release builds and Debug tests. At `7d107cea8`: 105115 unit tests, 70/70 feature tests, including all four tree checks and source lifetime; [results](history.md#hosted-d13e17-validation-2026-11-10). |
| E17 hosted ASan         | `00fa812cd`              | Fresh ASan build and both targeted tests passed after the runtime-selection fix; [results](history.md#hosted-d13e17-validation-2026-11-10).                                                                              |
| F2 physical tree checks | Build unspecified        | Owner reported all checks OK; [record and evidence limits](tree-view-screen-reader-check.md#実施結果).                                                                                                                   |

Remaining evidence limits:

- The earlier baseline thumbnail capture instability is unresolved; later
  targeted runs passed. See the [E22 record](history.md#e22-cache-contracts-2026-11-10).
- The weekly ASan schedule is configured; no scheduled execution is recorded.
  The successful run above was manual. The prebuilt PDFium DLL is not ASan-instrumented.
- F1 printing and F3 physical keyboard checks were excluded by owner instruction
  on 2026-11-10, without being marked passed. F2 passed by owner report;
  its build and environment details were not supplied.

Earlier suites, local checks and refactor validation remain in
[history.md](history.md#navigation). Test procedures are in [testing.md](testing.md).

## Resuming work

Read [agents.md](../../agents.md), [readme.md](../../readme.md), this file and
[backlog.md](backlog.md), then the current behavior and plan for the area at hand.

- Continue with E37 using the [review priorities](full-review-results.md#e25-再点検).
  Keep fixes separate from review documentation and add missing regression coverage before changing product code.
- For design work, read the [current architecture](architecture.md) and
  [structure and code review plan](full-review-plan.md). The [earlier plan](refactoring-plan.md) is complete.
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

| Purpose                     | Documents                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Current behavior            | [features.md](features.md), [limitations.md](limitations.md), [annotations.md](annotations.md), [forms.md](forms.md)                      |
| Work status                 | [Active, deferred and excluded work](backlog.md)                                                                                          |
| Code review                 | [Results, findings and validation](full-review-results.md), [scope and criteria](full-review-plan.md)                                     |
| Design and completed review | [Current architecture](architecture.md), [completed refactoring plan](refactoring-plan.md)                                                |
| Completed tree migration    | [Plan and results](tree-view-replacement-plan.md), [owner's acceptance](tree-view-screen-reader-check.md)                                 |
| Keyboard input              | [Current routing and results](keyboard-investigation.md); [historical handoff](keyboard-handoff.md)                                       |
| Test procedures             | [Local automated tests](testing.md#local-windows-runs), [historical manual checks](testing.md#owners-manual-acceptance-f1f3)              |
| Historical results          | [History navigation](history.md#navigation), [upstream merges](upstream-merges.md), [completed selection plan](selection-overlay-plan.md) |
| Measurements                | [data/](data/), cited by `history.md`                                                                                                     |

## Keeping docs current

Keep current behavior in `features.md` and `limitations.md`, open work in
`backlog.md`, and dated results in `history.md`. Mark completed plans with their
implementation commit; retain their original acceptance criteria as history.
Keep responsibilities and contracts in `architecture.md`. The completed
`refactoring-plan.md` retains its original criteria and links to results;
record any new work in `backlog.md` before extending the plan.
Move completed backlog rows to [history.md](history.md#completed-backlog).
Record upstream merges in `upstream-merges.md` and measurements in `data/`.
Update this status when the default behavior or active work changes. Keep test
results dated and distinguish automated checks from pending manual checks.
