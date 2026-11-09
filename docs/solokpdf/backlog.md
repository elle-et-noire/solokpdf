# SolokPDF backlog

Open work as of 2026-11-09. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D8, E13, F4). A1–E5 landed 2026-10-29 – 11-01 and are listed
there.

## Open

| ID  | Item                                                                                    | Status                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D3  | Shard the full suite across runners                                                     | deferred: the suite takes ~25 min once a hung test is cut off                                                                                  |
| E10 | Complete the [virtual sidebar migration](tree-view-replacement-plan.md)                 | doing: virtual trees are now the default; native sidebar drawing and opt-in switches removed; physical acceptance checks (F2) remain           |
| E11 | Apply settings without reloading stale values under `-for-testing`                      | todo: recorded in the [tree plan](tree-view-replacement-plan.md#独立した設定の修正); verify separately                                         |
| E12 | Continue [keyboard input consolidation](keyboard-investigation.md)                      | todo: some context, binding and state handling is shared; remaining routing needs behavior checks                                              |
| F1  | Physical printer, print dialog and spooler check                                        | needs the owner                                                                                                                                |
| F2  | Virtual-tree screen readers, monitor DPI changes, native thumb and real smart-bar hover | needs the owner: [manual procedure](tree-view-screen-reader-check.md); required to complete acceptance checks                                  |
| F3  | Keyboard physical input and OS hotkey checks                                            | needs the owner: AltGr, dead keys, Japanese IME, key repeat, focus changes and hotkey conflicts; [details](keyboard-investigation.md#残る検証) |

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
