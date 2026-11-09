# SolokPDF backlog

Open work as of 2026-11-09. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D12, E14, F4).

## Implementation and acceptance

No open implementation or merge-validation items. Completed E10–E13 and
D8–D11 records are in [history.md](history.md#navigation); the
[status overview](README.md#validation-scope) distinguishes the tested revisions
and validation scope. F1 and F3 below remain open.

## Owner's manual checks

| ID  | Item                                             | Status                                                                                                                                                       |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Physical printer, print dialog and spooler check | todo: needs the owner; [manual procedure](testing.md#printing-f1)                                                                                            |
| F3  | Keyboard physical input and OS hotkey checks     | todo: needs the owner; AltGr, dead keys, Japanese IME, key repeat, focus changes and hotkey conflicts; [details](keyboard-investigation.md#実機入力の確認f3) |

Use the [manual acceptance procedure](testing.md#owners-manual-acceptance-f1f3)
to record the build, environment and individual results. Partial or skipped
checks leave the relevant item open.

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
