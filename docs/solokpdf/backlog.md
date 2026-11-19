# SolokPDF backlog

This is the live work scope. Completed results are in [history.md](history.md#completed-backlog).
See the [remaining work plan](remaining-work-plan.md) for sequencing, dependencies and verification.

## Triage (2026-11-18)

- Investigate the hosted Markdown/CHM navigation timeout (E151) and restore
  evidence for the full and ASan workflows at the current revision (D15).
- Address UI waits when engine work holds a lock (E133). E135 has
  one latency outlier with no confirmed cause.
- Continue popup geometry and focus work under E112 and E117.
  The corrected external-foreground case (E150) is under observation.

Completed work and evidence go in [history.md](history.md#completed-backlog).
Record new failures here with a trigger, observable outcome and acceptance
check. Add behavior changes to [features.md](features.md) or
[limitations.md](limitations.md). Next free IDs are B78, C2, D16, E156 and F4.
For code changes, select affected tests from [testing.md](testing.md).

## Open

| ID   | Acceptance criteria                                                                                                                                                                                                                                                                            | Status      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| D15  | Record full hosted Debug runs on PDFium and MuPDF and a separate hosted ASan run at the current revision, including run IDs and exclusions. [Hosted follow-up](history.md#backlog-follow-up-2026-11-19)                                                                                        | todo        |
| E151 | The hosted trace isolated a late WebView2 completion. The fix passed on both formats and in both hidden layouts. Verify the fixed revision on hosted Windows. [Evidence](history.md#backlog-follow-up-2026-11-19)                                                                              | in progress |
| E112 | The find bar follows toolbar movement and visibility and stays in place through scrolling, zoom and view changes. Verify one dismissal on content replacement and measure re-evaluation cost. [Results](history.md#backlog-follow-up-2026-11-19)                                               | in progress |
| E117 | Model Windows mouse message order, foreground, focus, key state and capture in the test input layer. The client-click helper honors `WM_MOUSEACTIVATE`. Extend modal and owned-popup coverage in both layouts and on hosted Windows. [Local evidence](history.md#backlog-follow-up-2026-11-19) | in progress |
| E118 | Resolve theme colors at paint from surface, role and state; refresh main-window parts without a per-part list. Test raised buttons and selected controls on the Main surface and compare theme screenshots.                                                                                    | todo        |
| E133 | Verify cancellation, recovery and timing for the remaining producers in the [lock inventory](limitations.md#engine-contention-e133). Cold MuPDF display lists, sidebar thumbnails, citation previews and single and bulk Home covers pass. [Results](history.md#backlog-follow-up-2026-11-19)  | in progress |
| E154 | Decouple Esc dismissal from notification replacement groups. The notification layer selects and closes the visible target in priority order. Check zoom, theme cycling and stacked notifications. [Plan](remaining-work-plan.md#e154-通知の上書きと-esc)                                       | todo        |
| E155 | Hosted E128 reported an empty PDFium link-menu listing while a render was parked. Capture command delivery, popup ownership and menu contents. Verify Copy Link Address appears on the hosted runner. [Failed run](https://github.com/elle-et-noire/solokpdf/actions/runs/44469257975)         | todo        |

## Watch

| ID   | Observation                                                                                                                                                                | Follow-up on recurrence                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E135 | One link-menu action took 1,938 ms. The next 120 attempts passed and did not identify the cause. [Measurements](history.md#hosted-validation-and-status-review-2026-11-18) | Trace action dispatch, render cancellation, lock acquisition and menu construction. Reproduce the cause before tightening the timing bound.                                           |
| E150 | The corrected modal test passed with another process in the foreground. [Recorded runs](history.md#hosted-validation-and-status-review-2026-11-18)                         | Trace foreground ownership separately from thread-local active window and focus. Verify that restore preserves the external foreground and the reactivating click retains its target. |
| E153 | The baseline thumbnail test once captured an empty `f12-light` image. Retries and later targeted runs passed. [E22 record](history.md#e22-cache-contracts-2026-11-10)      | Capture thumbnail request, render completion and screenshot timing. Check whether the blank image comes from the app or from capturing early.                                         |

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

- XFA editing and GoToE are unsupported in both engines.
- The owner froze `src/ng/` on 2026-11-17. SolokPDF build and test coverage
  excludes ng, including verification of shared changes on ng.
- The owner has no plans for GitHub Releases, update checks or release criteria.
- Explorer thumbnails and preview require DLL registration. Default-app
  association already works through `Applications\SolokPDF.exe`.
- Crash-recovery verification, inactive-tab allocation attribution and
  Chrome/Edge rendering comparisons.

## Completed reviews

- E18–E22 design review (2026-11-10): [plan](archive/refactoring-plan.md), [current architecture](architecture.md).
- E23–E25 structure and code review (2026-11-10): [results](archive/full-review-results.md), [criteria](architecture.md#レビューの評価観点), [E23](history.md#e23e25-structure-and-code-review-2026-11-10), [E24](history.md#e24-review-completion-2026-11-10), [E25](history.md#e25-review-synthesis-2026-11-10); fixes E26–E37.
- F1/F3 manual checks: removed from active work by the owner on 2026-11-10, not marked passed; [procedures](testing.md#owners-manual-acceptance-f1f3).
- SOL1–SOL3 independent review: committed in `febc58f07`; [results](archive/full-review-sol-results.md#sol1sol3-修正検証2026-11-11).
- E38 ASan shutdown: pinned MSVC/ASan toolset; hosted run [43725820411](https://github.com/elle-et-noire/solokpdf/actions/runs/43725820411) passed at `1ed7b7f33` (2026-11-15); [results](asan-shutdown.md).
- 2026-11-13 review of the fork diff against upstream `8b716234f` at `ce9903893` (code-traced, not reproduced): E39–E57; [structural notes](architecture.md#構造上の注意2026-11-13-レビュー).
- 2026-11-16 performance review (code reading, no Release measurements; pixels kept identical, checked in Debug through `SOLOKPDF_PROFILE=1` phases or call counts; the Release `pdfium.dll` keeps `page`/`draw` phases representative): E60–E65.
- 2026-11-16 UI polish audit (hidden-desktop captures at 100/150/200% and all built-in themes; no fixes, the owner picks them): [E77](history.md#e77-ui-polish-audit-2026-11-16).
- 2026-11-18 repository review and documentation audit (E119): [implementation](history.md#repository-review-implementation), [CI and follow-ups](history.md#hosted-validation-and-status-review-2026-11-18).

Rows and results of all of these are in [history.md](history.md#completed-backlog).
