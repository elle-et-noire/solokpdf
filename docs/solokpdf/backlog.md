# SolokPDF backlog

Open work as of 2026-11-09. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D9, E14, F4).

## Implementation and acceptance

| ID  | Item                                                                    | Status                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E10 | Complete the [virtual sidebar migration](tree-view-replacement-plan.md) | doing: virtual trees are now the default; native sidebar drawing and opt-in switches removed; physical acceptance checks (F2) remain                                      |
| E13 | Cover keyboard routes outside E12's targeted checks                     | todo: favorites accelerators, toolbar focus, owned popups, Alt/F10, Merge PDF and special-mode state clearing; [scope](keyboard-investigation.md#自動テストの経路確認e13) |

E11 and E12 are implemented; see the [settings validation](history.md#e11-settings-application-2026-11-09)
and [input-target validation](history.md#e12-input-target-classification-2026-11-09).
E10 stays open until F2's physical checks are recorded.
E13 records coverage gaps, not confirmed defects; keep physical input checks in F3.

## Recorded validation follow-ups

| ID  | Item                                | Status                                                                                                                                                                 |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D8  | Record outstanding hosted CI checks | todo: startup timeout diagnostics, background palette lookup, stable tab-view sampling and toolbar checks at 100% DPI; [existing records](limitations.md#tests-and-ci) |

D7's [merge record](upstream-merges.md#merge-result-2026-11-08) also leaves full-suite
validation, Light/Dark checks of the merged UI and MuPDF patch-ledger byte verification
unperformed. Use the next scheduled release/CI run for full-suite results; local changes
continue to use targeted tests.

## Owner's manual checks

| ID  | Item                                                                                    | Status                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Physical printer, print dialog and spooler check                                        | todo: needs the owner                                                                                                                                        |
| F2  | Virtual-tree screen readers, monitor DPI changes, native thumb and real smart-bar hover | todo: needs the owner; [manual procedure](tree-view-screen-reader-check.md); required for E10 acceptance                                                     |
| F3  | Keyboard physical input and OS hotkey checks                                            | todo: needs the owner; AltGr, dead keys, Japanese IME, key repeat, focus changes and hotkey conflicts; [details](keyboard-investigation.md#実機入力の確認f3) |

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
