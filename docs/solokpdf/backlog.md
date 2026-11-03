# SolokPDF backlog

Open work. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[limitations.md](limitations.md). New items take the next free ID in their
group (B72, C2, D7, E6, F2). A1–E5 landed 2026-10-29 – 11-01 and are listed
there.

## Open

| ID  | Item                                             | Status                                                           |
| --- | ------------------------------------------------ | ---------------------------------------------------------------- |
| B71 | CI regressions after B65–B69                     | blocked: hosted failures and remaining causes need investigation |
| B65 | Full-suite regressions after B54–B64             | blocked: hosted 100% DPI verification needs orchestrator         |
| D3  | Shard the full suite across runners              | deferred: the suite takes ~25 min once a hung test is cut off    |
| F1  | Physical printer, print dialog and spooler check | needs the owner                                                  |

B71: hosted runs at `5a9e0852b` pass `issue-5989`, `issue-1106`, MuPDF
free-text placement and the four process cleanup checks. The viewer test now
opts into its fake shell launch and passes locally. The PNG test now checks
the data directory, as required by `9e14db81f`; it still needs a real clipboard
run. The shared clipboard cannot safely be restored for arbitrary formats.

The remaining hosted failures need another run with failure diagnostics:

- About: B68 changed window showing and raising. The foreground may be the
  About window or an unrelated window; the old failure did not identify it.
- Noteref: B59 changed cursor reads but this test sends clicks without a test
  cursor. A real cursor or generated mouse message may hide the popup.
- Toolbar hover: B59 changed cursor and mouse-leave handling. The test cursor or
  a generated mouse message may disagree with the annotation's position.
- Touch: B68 opens the file picker without activation, so injected touch may
  hit another window; intermediate injection results were not checked.

Noteref and toolbar hover pass locally; touch injection is unavailable and
the hidden desktop has no foreground window for the About check. Hosted logs
were read for runs 41701026228, 41701026460 and 41701031483; downloading their
artifacts returned HTTP 401. These hypotheses are not yet confirmed.

B65: full-suite runs 41639619890 (PDFium) and 41639624912 (MuPDF) at
ff43c356c fail `issue-4788` (also locally), `favorites-menu`,
`recent-files-menu`, `pdf-edit-toolbar-interaction` and, on PDFium,
`issue-6252`. Local hidden-desktop runs pass the targeted sequence on both
engines; the toolbar fixture change still needs hosted 100% DPI verification.

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
