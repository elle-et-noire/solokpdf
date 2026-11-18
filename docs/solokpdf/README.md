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

## Status

[Backlog](backlog.md) is the source of truth for open, deferred and excluded
work. Completed results are in [history.md](history.md#completed-backlog).
Current behavior and its limits are in [features.md](features.md) and
[limitations.md](limitations.md). The last upstream merge incorporated
`b1a8e2257` (D14). [Merge record](upstream-merges.md#current-status-2026-11-15)

### Validation as of 2026-11-18

Reviewed revision `4751ec07a` on `solokpdf-dev`. PDFium is pinned to
`158.0.8111.0`. [Pin](../../cmd/solok-pdfium-pin.json)

| Check             | Tested revision | Result                                                                                                                                                                                                                                              |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular CI        | `4751ec07a`     | Debug build, PDFium cache migration, unit and feature tests passed. Release built, opened a PDF with PDFium from the extracted ZIP and uploaded the artifact. [Run 44310309155](https://github.com/elle-et-noire/solokpdf/actions/runs/44310309155) |
| Hosted full suite | `b12535517`     | Last scheduled run failed nine tests per engine. E70 records the fixes and targeted rechecks. Validation for the current revision remains open (D15). [Run 43763953763](https://github.com/elle-et-noire/solokpdf/actions/runs/43763953763)         |
| Hosted ASan       | `1ffb2fae1`     | Latest scheduled run passed its targeted save/shutdown, tree lifetime and PDFium fallback tests. The prebuilt PDFium DLL has no ASan instrumentation. [Run 44203231694](https://github.com/elle-et-noire/solokpdf/actions/runs/44203231694)         |

The [November 18 record](history.md#hosted-validation-and-status-review-2026-11-18)
includes the preceding CI failures and later full-workflow dispatches.
The [backlog](backlog.md) tracks remaining work and intermittent observations.
Local seeded stress checks are in the [monkey-test record](history.md#e71-monkey-test-2026-11-16).
The owner reported that F2 tree checks passed, with build and environment
unspecified. F1 printing and F3 physical input are outside active scope and
remain unverified. [Manual acceptance record](testing.md#owners-manual-acceptance-f1f3)

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
Keep active scope only in the backlog; link to it here rather than copying status.
Keep test results dated and distinguish automated checks from pending manual checks.
