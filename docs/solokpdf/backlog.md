# SolokPDF backlog

Open work. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[limitations.md](limitations.md). New items take the next free ID in their
group (B58, C2, D7, E6, F2). A1–E5 landed 2026-10-29 – 11-01 and are listed
there.

## Open

| ID  | Item                                             | Status                                                        |
| --- | ------------------------------------------------ | ------------------------------------------------------------- |
| B37 | Cursor and RTL capture tests (full-suite run 3)  | blocked — locked desktop prevents cursor and capture checks   |
| D3  | Shard the full suite across runners              | deferred: the suite takes ~25 min once a hung test is cut off |
| F1  | Physical printer, print dialog and spooler check | needs the owner                                               |

B37 needs a rerun on an unlocked, interactive desktop.

## Dropped

| ID  | Item                                                | Reason                                                                    |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| B21 | PDFium CAD enhance                                  | PDFium has no render control for it; the command is hidden on PDFium tabs |
| B27 | PDFium external images                              | PDFium has no external-stream loader; such PDFs are rare                  |
| D2  | Compile cache (sccache) for CI builds               | gains uncertain (no PCH or `/MP` caching); CI takes ~20 min               |
| E3  | ASan build of the app with PDFium for the fuzz test | prebuilt PDFium isn't ASan                                                |
| E4  | Transparent-page compositing parity                 | rare documents                                                            |

## Not planned

XFA editing and GoToE (unsupported in both engines); `src/ng/`; distribution
(GitHub Releases, update checks, release criteria): the owner has no plans to
distribute. Explorer thumbnails/preview (needs DLL registration; little value
for one user). The default-app association already works through
`Applications\SolokPDF.exe`. Crash-recovery verification, inactive-tab
allocation attribution and Chrome/Edge rendering comparisons.
