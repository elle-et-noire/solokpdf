# SolokPDF backlog

Work scope as of 2026-11-16: E78 open; D3 deferred; F1/F3 and distribution
out of scope. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D15, E87, F4). For a code change, choose affected tests from
[testing.md](testing.md); run full suites only when explicitly requested.

## Completed reviews

- E18–E22 design review (2026-11-10): [plan](archive/refactoring-plan.md), [current architecture](architecture.md).
- E23–E25 structure and code review (2026-11-10): [results](archive/full-review-results.md), [criteria](architecture.md#レビューの評価観点), [E23](history.md#e23e25-structure-and-code-review-2026-11-10), [E24](history.md#e24-review-completion-2026-11-10), [E25](history.md#e25-review-synthesis-2026-11-10); fixes E26–E37.
- F1/F3 manual checks: removed from active work by the owner on 2026-11-10, not marked passed; [procedures](testing.md#owners-manual-acceptance-f1f3).
- SOL1–SOL3 independent review: committed in `febc58f07`; [results](archive/full-review-sol-results.md#sol1sol3-修正検証2026-11-11).
- E38 ASan shutdown: pinned MSVC/ASan toolset; hosted run [43725820411](https://github.com/elle-et-noire/solokpdf/actions/runs/43725820411) passed at `1ed7b7f33` (2026-11-15); [results](asan-shutdown.md).
- 2026-11-13 review of the fork diff against upstream `8b716234f` at `ce9903893` (code-traced, not reproduced): E39–E57; [structural notes](architecture.md#構造上の注意2026-11-13-レビュー).
- 2026-11-16 performance review (code reading, no Release measurements; pixels kept identical, checked in Debug through `SOLOKPDF_PROFILE=1` phases or call counts; the Release `pdfium.dll` keeps `page`/`draw` phases representative): E60–E65.
- 2026-11-16 UI polish audit (hidden-desktop captures at 100/150/200% and all built-in themes; no fixes, the owner picks them): [E77](history.md#e77-ui-polish-audit-2026-11-16).

Rows and results of all of these are in [history.md](history.md#completed-backlog).

## Open

| ID  | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| E78 | `tts-engine-crash-recovery` hangs intermittently (full suite 43835416476 MuPDF timed out at 5 min; locally 2 hangs in 6 MuPDF runs, PDFium passed). Stacks in `.work/e78-tts-hang/tts-stacks.txt`: the crashed TTS thread waits in `MaybeEndCrashedThread` for `EndedThreadDumpThread`, whose `MiniDumpWriteDump` blocks in `LoadLibraryExA` on the loader lock; the UI thread sits in an ALPC call. Upstream code (`9e246efc4`, `src/base/CrashHandler.cpp:508`). Find the lock holder (`!locks`, UI stack) before fixing | todo   |

## Deferred

| ID  | Item                                | Reason                                              |
| --- | ----------------------------------- | --------------------------------------------------- |
| D3  | Shard the full suite across runners | the suite takes ~25 min once a hung test is cut off |

## Dropped

| ID  | Item                                                | Reason                                                                                         |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| B21 | PDFium CAD enhance                                  | PDFium has no render control for it; the command is hidden on PDFium tabs                      |
| B27 | PDFium external images                              | PDFium has no external-stream loader; such PDFs are rare                                       |
| B62 | Widget action query gate                            | PDFium cannot read widget `/S`; MuPDF query median: 1.2 ms small, 2.5 ms 35 MiB                |
| D2  | Compile cache (sccache) for CI builds               | gains uncertain (no PCH or `/MP` caching); CI takes ~20 min                                    |
| E3  | ASan build of the app with PDFium for the fuzz test | prebuilt PDFium isn't ASan                                                                     |
| B73 | Free the render probe's MuPDF parse                 | ~7 MiB on a 113k-object file is cheaper than ~16 ms per later first page visit (2026-11-06)    |
| E9  | Raise selected-row contrast (Solarized Dark 3.49:1) | selection colors are a deliberate cross-theme scheme; theme text itself is 4.75:1 (2026-11-06) |
| E4  | Transparent-page compositing parity                 | rare documents                                                                                 |

## Not planned

XFA editing and GoToE (unsupported in both engines); `src/ng/`; distribution
(GitHub Releases, update checks, release criteria): the owner has no plans to
distribute. Explorer thumbnails/preview (needs DLL registration; little value
for one user). The default-app association already works through
`Applications\SolokPDF.exe`. Crash-recovery verification, inactive-tab
allocation attribution and Chrome/Edge rendering comparisons.
