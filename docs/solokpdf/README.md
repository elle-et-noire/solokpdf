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

[Backlog](backlog.md) is the source of truth for open and excluded
work. Completed results are in [history.md](history.md#completed-backlog).
Current behavior and its limits are in [features.md](features.md) and
[limitations.md](limitations.md). The last upstream merge incorporated
`b1a8e2257` (D14). [Merge record](upstream-merges.md#current-status-2026-11-15)

### Validation as of 2026-11-20

PDFium is pinned to `158.0.8111.0`. [Pin](../../cmd/solok-pdfium-pin.json)

| Check                   | Tested revision | Result                                                                                                                                                                                                                              |
| ----------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular CI              | `3a2c34ac0`     | Debug build, cache migration, unit and feature tests passed. Release built and passed the extracted ZIP smoke test. [Run 44737652358](https://github.com/elle-et-noire/solokpdf/actions/runs/44737652358)                           |
| Hosted full suite       | `3a2c34ac0`     | PDFium passed 626 of 627 tests. MuPDF passed all 630. [PDFium run](https://github.com/elle-et-noire/solokpdf/actions/runs/44740526224) · [MuPDF run](https://github.com/elle-et-noire/solokpdf/actions/runs/44740531079)            |
| Hosted targeted recheck | `1a2d483c7`     | Both engines passed `issue-6151`, `issue-6194` and `issue-6144`. [PDFium run](https://github.com/elle-et-noire/solokpdf/actions/runs/44629587531) · [MuPDF run](https://github.com/elle-et-noire/solokpdf/actions/runs/44629592648) |
| Hosted ASan             | `3a2c34ac0`     | Passed save/shutdown, tree lifetime and PDFium fallback tests. The prebuilt PDFium DLL has no ASan instrumentation. [Run 44740536377](https://github.com/elle-et-noire/solokpdf/actions/runs/44740536377)                           |

The [D15 record](history.md#d15-hosted-verification-at-3a2c34ac0-2026-11-20)
lists the full-suite failures and exclusions. See the
[backlog](backlog.md#open) for the remaining verification.
Local seeded stress checks are in the [monkey-test record](history.md#e71-monkey-test-2026-11-16).

## Resuming work

Read [agents.md](../../agents.md), [readme.md](../../readme.md), this file and
[backlog.md](backlog.md), then the documentation for the area at hand.

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
| Work status        | [Open work and scope exclusions](backlog.md)                                                                                                       |
| Design             | [Current architecture, review criteria and structural notes](architecture.md)                                                                      |
| Keyboard input     | [Current routing and results](keyboard-investigation.md)                                                                                           |
| Test procedures    | [Local automated tests](testing.md#local-windows-runs), [physical tree checks](testing.md#physical-tree-checks), [ASan shutdown](asan-shutdown.md) |
| Historical results | [History navigation](history.md#navigation), [upstream merges](upstream-merges.md)                                                                 |
| Review evidence    | [Review reports](archive/README.md)                                                                                                                |
| Measurements       | [data/](data/), cited by `history.md`                                                                                                              |

## Keeping docs current

Keep current behavior in `features.md` and `limitations.md`, open work in
`backlog.md`, dated results in `history.md`, responsibilities and contracts in
`architecture.md`, and test procedures in `testing.md`.
Move closed items to [history.md](history.md#completed-backlog).
When a plan finishes, update the current docs and record the results, then
remove the plan. Keep detailed evidence in [review reports](archive/README.md).
Record upstream merges in `upstream-merges.md` and measurements in `data/`.
Keep test results dated and distinguish automated checks from pending manual checks.
