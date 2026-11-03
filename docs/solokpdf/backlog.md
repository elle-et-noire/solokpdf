# SolokPDF backlog

Open work. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[limitations.md](limitations.md). New items take the next free ID in their
group (B68, C2, D7, E6, F2). A1–E5 landed 2026-10-29 – 11-01 and are listed
there.

## Open

| ID  | Item                                             | Status                                                        |
| --- | ------------------------------------------------ | ------------------------------------------------------------- |
| B67 | Tests don't touch the system clipboard           | todo                                                          |
| B65 | Full-suite regressions after B54–B64             | todo                                                          |
| D3  | Shard the full suite across runners              | deferred: the suite takes ~25 min once a hung test is cut off |
| F1  | Physical printer, print dialog and spooler check | needs the owner                                               |

B65: full-suite runs 41639619890 (PDFium) and 41639624912 (MuPDF) at
ff43c356c fail `issue-4788` (also locally), `favorites-menu`,
`recent-files-menu`, `pdf-edit-toolbar-interaction` and, on PDFium,
`issue-6252`; the last four pass alone locally.

B67: about 30 tests copy into or write the
system clipboard (app Copy/Cut, `setClipboardText`) and overwrite the
owner's clipboard. Use B66's process-local copy sink for test-launched
apps by default (copy and paste), set it through `-dbg-control` instead
of `setClipboardText`, and run tests that need the real clipboard only in
CI or when opted in locally.

## Dropped

| ID  | Item                                                | Reason                                                                          |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| B21 | PDFium CAD enhance                                  | PDFium has no render control for it; the command is hidden on PDFium tabs       |
| B27 | PDFium external images                              | PDFium has no external-stream loader; such PDFs are rare                        |
| B62 | Widget action query gate                            | PDFium cannot read widget `/S`; MuPDF query median: 1.2 ms small, 2.5 ms 35 MiB |
| D2  | Compile cache (sccache) for CI builds               | gains uncertain (no PCH or `/MP` caching); CI takes ~20 min                     |
| E3  | ASan build of the app with PDFium for the fuzz test | prebuilt PDFium isn't ASan                                                      |
| E4  | Transparent-page compositing parity                 | rare documents                                                                  |

## Not planned

XFA editing and GoToE (unsupported in both engines); `src/ng/`; distribution
(GitHub Releases, update checks, release criteria): the owner has no plans to
distribute. Explorer thumbnails/preview (needs DLL registration; little value
for one user). The default-app association already works through
`Applications\SolokPDF.exe`. Crash-recovery verification, inactive-tab
allocation attribution and Chrome/Edge rendering comparisons.
