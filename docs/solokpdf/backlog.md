# SolokPDF backlog

Work scope as of 2026-11-18: E112, E115–E119, E125, E126, E129–E135, E137, B77 open; order after the 2026-11-17 review (`.work/codex-queue/review-2026-11-17.md`): E137, E131, E135, E134, E133, E129, E130, E132, B77, E125, E126, E116, E117, E112, E118, E115, E119; specs in `.work/codex-queue/<id>.md`; D3 deferred; F1/F3 and distribution out of scope.
Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B78, C2, D15, E138, F4). For a code change, choose affected tests from
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

| ID   | Item                                                                                                                                                                                                                                                           | Status |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| E112 | Anchors as functions: re-place popups on any geometry change under the frame and notify content changes once, instead of naming windows (find bar on the toolbar icon, paint-path scroll following, polled content). Spec `.work/codex-queue/e112.md`          | todo   |
| E115 | Every MuPDF context logs to our log: some `fz_new_context` sites keep MuPDF's stderr callbacks. One factory plus a lint. Spec `.work/codex-queue/e115.md`                                                                                                      | todo   |
| E116 | Crash path ends and dumps by construction: fallback without the helper, no INFINITE wait or allocation before the dump, non-inheritable handles (review D4–D6, U5). Spec `.work/codex-queue/e116.md`                                                           | todo   |
| E117 | One test input command in Windows' message order; the layer owns foreground and key state under tests; remove window-code guards; CI on the hidden desktop (review: input layering, D3, D7, U1). Spec `.work/codex-queue/e117.md`                              | todo   |
| E118 | Theme colors resolved at paint from (surface, role, state); main-window parts register their theme refresh (review: theme layering, U4). Spec `.work/codex-queue/e118.md`                                                                                      | todo   |
| E119 | Review docs and process: fz_catch conversion for upstream merges, fz-catch.h MuPDF dependency, doc claims, spec rules. Spec `.work/codex-queue/e119.md`                                                                                                        | todo   |
| E125 | Annotation toolbar click point lives with the selection, not the toolbar: scrolling the page off and back re-shows it at the annotation's left edge (E121 follow-up). Spec `.work/codex-queue/e125.md`                                                         | todo   |
| E126 | Home keyboard-focus tip is dismissed on minimize and not shown on restore (E121 follow-up). Spec `.work/codex-queue/e126.md`                                                                                                                                   | todo   |
| E129 | Citation popup left by E122: its hand cursor drops busy, its show reads text blocking on the UI thread (may load the editor on PDFium), plain-text citation walk takes seconds; no unit test for the text cache Failed state. Spec `.work/codex-queue/e129.md` | todo   |
| E130 | Measurement tool snap points take engine locks blocking on the UI thread on the first move over a page (E122 audit). Spec `.work/codex-queue/e130.md`                                                                                                          | todo   |
| E131 | Keyboard link following turned on during a render says "No links on this page" and leaves; relabel after scroll skips busy pages (E127 follow-up). Spec `.work/codex-queue/e131.md`                                                                            | todo   |
| E132 | Enforce hover vs action lookups by type instead of lint-hover-lookups' allowlist (E127 follow-up). Spec `.work/codex-queue/e132.md`                                                                                                                            | todo   |
| E133 | Make all engine work an action can wait on cancellable: cookie-less renders (thumbnails, previews, export), MuPDF display-list build, PDFium FFLDraw, text extraction/search (E128 follow-up). Spec `.work/codex-queue/e133.md`                                | todo   |
| E134 | UI-thread annotation access waits on the editor lock without canceling renders; put the cancel in the lock acquisition, not call sites (E128 follow-up). Spec `.work/codex-queue/e134.md`                                                                      | todo   |
| E135 | Link context menu during a parked render once took 1938 ms (usually ~163); find the cause, tighten the bound (E128 follow-up). Spec `.work/codex-queue/e135.md`                                                                                                | todo   |
| E137 | Annotation toolbar contents edit commits and closes when a minimize moves the focus to the frame; make minimize focus loss invisible to owners by construction (E136 follow-up). Spec `.work/codex-queue/e137.md`                                              | todo   |
| B77  | `bun cmd/run-unit-tests.ts` builds via vs2022/v143 (not installed here) and rewrites vs2022/ files; make the unit-test command use the SolokPDF build and leave the tree clean. Spec `.work/codex-queue/b77.md`                                                | todo   |

## Deferred

| ID  | Item                                | Reason                                              |
| --- | ----------------------------------- | --------------------------------------------------- |
| D3  | Shard the full suite across runners | the suite takes ~25 min once a hung test is cut off |

## Dropped

| ID   | Item                                                | Reason                                                                                         |
| ---- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| B21  | PDFium CAD enhance                                  | PDFium has no render control for it; the command is hidden on PDFium tabs                      |
| B27  | PDFium external images                              | PDFium has no external-stream loader; such PDFs are rare                                       |
| B62  | Widget action query gate                            | PDFium cannot read widget `/S`; MuPDF query median: 1.2 ms small, 2.5 ms 35 MiB                |
| D2   | Compile cache (sccache) for CI builds               | gains uncertain (no PCH or `/MP` caching); CI takes ~20 min                                    |
| E3   | ASan build of the app with PDFium for the fuzz test | prebuilt PDFium isn't ASan                                                                     |
| B73  | Free the render probe's MuPDF parse                 | ~7 MiB on a 113k-object file is cheaper than ~16 ms per later first page visit (2026-11-06)    |
| E9   | Raise selected-row contrast (Solarized Dark 3.49:1) | selection colors are a deliberate cross-theme scheme; theme text itself is 4.75:1 (2026-11-06) |
| E114 | Build E111 catch macros on ng Linux/Wasm            | ng frozen (owner, 2026-11-17)                                                                  |
| E4   | Transparent-page compositing parity                 | rare documents                                                                                 |

## Not planned

XFA editing and GoToE (unsupported in both engines); `src/ng/`, frozen (owner, 2026-11-17): not built, tested or linted here; shared changes are not verified on ng; distribution
(GitHub Releases, update checks, release criteria): the owner has no plans to
distribute. Explorer thumbnails/preview (needs DLL registration; little value
for one user). The default-app association already works through
`Applications\SolokPDF.exe`. Crash-recovery verification, inactive-tab
allocation attribution and Chrome/Edge rendering comparisons.
