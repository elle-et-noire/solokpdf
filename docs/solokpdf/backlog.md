# SolokPDF backlog

Work scope as of 2026-11-15. E23–E25 are complete within the recorded review scope.
E26–E49 are complete within their recorded validation scope. E50–E57 are open findings of the
[2026-11-13 review](#2026-11-13-review-findings).
D3 remains deferred. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D14, E58, F4).

## Implementation and acceptance

Completed D8–D13 and E10–E22 records are in
[history.md](history.md#navigation). The [status page](README.md#validation-scope)
summarizes recorded CI results and evidence limits.

F1/F3 were removed from active work by the owner on 2026-11-10, without marking
them passed. Their earlier procedures and pending-check records are historical.

## Next steps

Fix the [2026-11-13 findings](#2026-11-13-review-findings) by priority, E50 first.
Each fix starts with a failing test, as the findings are read from code, not reproduced.
Keep D3 deferred and F1/F3 and distribution outside active scope. For a code change, choose
affected tests from [testing.md](testing.md); run full suites only when
explicitly requested.

## Design review

E18–E22 are complete within their recorded validation scope. The [completed plan](refactoring-plan.md) maps each item
to its implementation and results. The [current architecture](architecture.md)
records the resulting responsibilities and contracts.

Assess correctness, maintainability and performance using the
[review plan's evaluation criteria](full-review-plan.md#評価観点). Operation
paths guide investigation without limiting its scope. Record the code actually
read; check build and test infrastructure where the investigation or a change requires them.

No open implementation items remain from the E25 review.

E23's mapping and E24's initial inspection are in [history.md](history.md#e23e25-structure-and-code-review-2026-11-10).
E24's [completion](history.md#e24-review-completion-2026-11-10) records the final investigation and its limits.
E25's [record](history.md#e25-review-synthesis-2026-11-10) records the recheck, scope correction and completed synthesis.
Each finding's evidence, impact and original next check are in [full-review-results.md](full-review-results.md).
The review's findings and historical priorities remain in that record.

## Independent review follow-up

SOL1–SOL3 are committed in `febc58f07`, within the [recorded checks](full-review-sol-results.md#sol1sol3-修正検証2026-11-11).
The original review and its unverified branches remain recorded.

E38 uses a pinned matching MSVC/ASan toolset. The independent probe and local
save/shutdown rechecks pass; hosted validation is not recorded for this change.
[Results](asan-shutdown.md).

## 2026-11-13 review findings

Review of the fork diff against upstream `8b716234f` at `ce9903893`, excluding items
recorded in [full-review-results.md](full-review-results.md) and
[full-review-sol-results.md](full-review-sol-results.md). Every row was traced in code; none
was built or reproduced. Confirm each with a failing test before fixing. Line numbers are at
`ce9903893`.

| ID  | P   | Status | Item                                                         | Where and trigger                                                                                                                |
| --- | --- | ------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| E50 | P3  | todo   | Small wheel deltas don't scroll the tree                     | `VirtTree.cpp:972` divides by `WHEEL_DELTA` before multiplying; precision touchpads scroll 0 rows                                |
| E51 | P3  | todo   | Key capture stays armed after focus moves                    | `ShortcutsDialog.cpp:270-311`: after Add key, typing in the argument edit binds the key                                          |
| E52 | P3  | todo   | Auto-scroll takes keys typed in the Vim `:` line             | `ReadingAutoScrollOnKey` (`SumatraPDF.cpp:15512`) ignores the key target; digits change speed, Esc stops scrolling               |
| E53 | P3  | todo   | Partial text re-extracted on every read after editor failure | `EngineBase.cpp:1166` keeps the page `Pending`; each search or selection update reruns PDFium extraction                         |
| E54 | P3  | todo   | Unbounded form value read                                    | `FormFieldHighlight` (`EnginePdfium.cpp:2057`) allocates the value without the 64 KiB cap other reads use                        |
| E55 | P3  | todo   | Document `gPdfiumLock` serialization                         | Blocking UI reads (`GetElements`, `PageContentBox`, `GetNamedDest`) wait for a drawing tile; not in limitations.md               |
| E56 | P3  | todo   | Measure smart-theme tile cost                                | `DrawPage` reopens the themed PDF per tile (`EnginePdfium.cpp:2437`); unmeasured on large documents                              |
| E57 | P3  | todo   | Measure large outlines in the virtual tree                   | `Measure` (`VirtTree.cpp:473-502`) and `SetModel` walk every node on model, font and DPI changes; tested only to 5,000 bookmarks |

Structural notes from the review, not work items: the color-pass decision lives in
`GetPageColorPass`, `BuildViewDarkModeProfile` and each engine (E46 is a disagreement);
key routing interprets `GetKeyTarget` in three places; the hidden editor's role is implied by
how it was created and by ~45 `IfLoaded`/`Load` call sites, and redaction promotes it to
renderer, text source and clone (E39 comes from its three-way save path).

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
