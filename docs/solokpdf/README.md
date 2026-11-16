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

UI chrome follows the active theme's colors. Where upstream draws OS theme parts
or fixed grays, keep its shape, size and position but take colors from the
theme (owner, 2026-11-17); record the difference in [features.md](features.md).

## Status (2026-11-16)

Open: E98–E100, popups that follow a child window only by hand (from E97's
audit). D3 (suite sharding) is deferred; F1/F3 manual checks and
distribution are out of scope. Completed items and their results are in
[history.md](history.md#completed-backlog); reviews are listed in
[backlog.md](backlog.md#completed-reviews).

| Area           | Current state                                                                                                                             | Details                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | PDFium renders PDFs; MuPDF is the fallback and lazy editor.                                                                               | [Limitations](limitations.md), [annotations](annotations.md), [forms](forms.md)                                                                                        |
| Upstream       | Merged through `b1a8e2257` on 2026-11-15 (D14); local validation is recorded in the merge result.                                         | [Merge status](upstream-merges.md#current-status-2026-11-15)                                                                                                           |
| Text selection | Theme-colored translucent overlays; selection-only glyph rendering removed.                                                               | [Current colors](features.md#selection-colors), [implementation record](archive/selection-overlay-plan.md)                                                             |
| Sidebar trees  | Virtual bookmarks and favorites are the default in Debug and Release; the owner reported all F2 checks OK on 2026-11-09 (E10 complete).   | [Behavior](features.md#virtual-sidebar-trees), [tests](testing.md#virtual-sidebar-trees), [migration record](archive/tree-view-replacement-plan.md)                    |
| Keyboard input | E12 classification, E13 route checks and count/prefix state separation implemented.                                                       | [Current routing and results](keyboard-investigation.md)                                                                                                               |
| Settings       | Palette and settings-screen changes apply in memory; `-for-testing` keeps the settings file unchanged (E11).                              | [Behavior](features.md#settings), [validation](history.md#e11-settings-application-2026-11-09)                                                                         |
| Refactoring    | Tree, runtime and key-state separation (E15), plus rendering/read/lifetime contracts (E18–E22), are complete within their recorded scope. | [Current architecture](architecture.md), [completed plan](archive/refactoring-plan.md), [E15 review](history.md#e15-refactor-review-2026-11-10)                        |
| Code review    | E23–E25, SOL1–SOL3, the 2026-11-13 review (E39–E57) and the 2026-11-16 performance review (E60–E65) are done.                             | [Completed reviews](backlog.md#completed-reviews), [criteria](architecture.md#レビューの評価観点), [structural notes](architecture.md#構造上の注意2026-11-13-レビュー) |

### Validation scope

Results apply only to the tested revisions and checks. Release is built and
packaged by CI, not feature-tested. Run IDs were checked against GitHub's run
list on 2026-11-16.

| Check                                                     | Tested revision                       | Recorded result                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular CI (`solokpdf-ci.yml`, push)                      | `7d107cea8`, `8915cc2b7`              | At `7d107cea8` (D13): 105115 unit tests, 70/70 feature tests; [results](history.md#hosted-d13e17-validation-2026-11-10). Passed at `e6c106699` ([43817491272](https://github.com/elle-et-noire/solokpdf/actions/runs/43817491272), [E70](history.md#hosted-recheck)) and at `8915cc2b7` after E74 ([43832273025](https://github.com/elle-et-noire/solokpdf/actions/runs/43832273025)). |
| Full suite (`solokpdf-full-tests.yml`, weekly and manual) | `b12535517`, `e6c106699`              | Scheduled run 43763953763 at `b12535517` failed 9 tests per engine; fixed or updated in [E70](history.md#e70-scheduled-suite-failures-2026-11-15). Four rechecked hosted at `e6c106699`, the rest locally. No full run since.                                                                                                                                                          |
| ASan (`solokpdf-asan.yml`, weekly and manual)             | `00fa812cd`, `83d0ec657`, `1ed7b7f33` | E17 manual run passed at `00fa812cd`; [results](history.md#hosted-d13e17-validation-2026-11-10). Scheduled run 42914570299 passed at `83d0ec657` (2026-11-10). E38 manual run [43725820411](https://github.com/elle-et-noire/solokpdf/actions/runs/43725820411) passed at `1ed7b7f33` with the pinned toolset; [results](asan-shutdown.md).                                            |
| Monkey test (E71, local only)                             | E71–E74 commits                       | Debug and ASan seeds on both engines; findings E72–E74 fixed; [results](history.md#e71-monkey-test-2026-11-16), [usage](testing.md#monkey-test-e71). Not in CI: outcomes depend on render timing.                                                                                                                                                                                      |
| F2 physical tree checks                                   | Build unspecified                     | Owner reported all checks OK; [record and evidence limits](archive/tree-view-screen-reader-check.md#実施結果).                                                                                                                                                                                                                                                                         |

Remaining evidence limits (2026-11-16):

- The prebuilt PDFium DLL is not ASan-instrumented.
- The earlier baseline thumbnail capture instability is unresolved; later
  targeted runs passed. See the [E22 record](history.md#e22-cache-contracts-2026-11-10).
- F1 printing and F3 physical keyboard checks were excluded by owner instruction
  on 2026-11-10, without being marked passed. F2 passed by owner report;
  its build and environment details were not supplied.
- The monkey test samples seeded sequences; it does not establish coverage.

Earlier suites, local checks and refactor validation remain in
[history.md](history.md#navigation). Test procedures are in [testing.md](testing.md).

## Resuming work

Read [agents.md](../../agents.md), [readme.md](../../readme.md), this file and
[backlog.md](backlog.md), then the current behavior and plan for the area at hand.

- For design work, read the [current architecture](architecture.md), including
  its review criteria and structural notes.
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

| Purpose            | Documents                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current behavior   | [features.md](features.md), [limitations.md](limitations.md), [annotations.md](annotations.md), [forms.md](forms.md)                               |
| Work status        | [Open, deferred and excluded work; completed reviews](backlog.md)                                                                                  |
| Design             | [Current architecture, review criteria and structural notes](architecture.md)                                                                      |
| Keyboard input     | [Current routing and results](keyboard-investigation.md)                                                                                           |
| Test procedures    | [Local automated tests](testing.md#local-windows-runs), [physical tree checks](testing.md#physical-tree-checks), [ASan shutdown](asan-shutdown.md) |
| Historical results | [History navigation](history.md#navigation), [upstream merges](upstream-merges.md)                                                                 |
| Finished plans     | [Archive](archive/README.md): refactoring, tree migration, selection overlay, keyboard handoff, E23–E25 and SOL reviews                            |
| Measurements       | [data/](data/), cited by `history.md`                                                                                                              |

## Keeping docs current

Keep current behavior in `features.md` and `limitations.md`, open work in
`backlog.md`, dated results in `history.md`, responsibilities and contracts in
`architecture.md`, and test procedures in `testing.md`.
Move completed backlog rows to [history.md](history.md#completed-backlog);
list each finished review in one line under backlog's
[completed reviews](backlog.md#completed-reviews).
When a plan or review record is finished, move its current-state content to
the current docs, `git mv` it to `archive/` and add a line to
[archive/README.md](archive/README.md).
Record upstream merges in `upstream-merges.md` and measurements in `data/`.
Update this status when the default behavior or active work changes. Keep test
results dated and distinguish automated checks from pending manual checks.
