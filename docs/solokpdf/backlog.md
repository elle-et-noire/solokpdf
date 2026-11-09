# SolokPDF backlog

Open work as of 2026-11-10. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D14, E23, F4).

## Implementation and acceptance

E10–E16 and D8–D12 records are in [history.md](history.md#navigation).
E16 is committed as
`fc8b455e8`; its regular CI passed Debug/Release builds, unit tests and feature
tests. See [D12's evidence and limits](history.md#d12-hosted-evidence-2026-11-10).

F1/F3 were removed from active work by the owner on 2026-11-10, without marking
them passed. Their earlier procedures and pending-check records are historical.

## Next steps

CI coverage expansion after D12 is committed as `9083edafe`. At 2026-11-10
03:01 JST, its regular CI was building Debug and Release; no ASan runs were
listed. See the [hosted snapshot](history.md#hosted-snapshot-2026-11-10).

| ID  | Work                                                                             | Status                                                                     |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| D13 | Add the four existing virtual-tree checks to regular SolokPDF CI                 | doing — committed; local validation recorded; first hosted run in progress |
| E17 | Run a clean ASan build, tree lifetime and PDFium fallback checks manually/weekly | doing — clean local build and both checks passed; first hosted run pending |

Implementation and local results are in [history.md](history.md#ci-coverage-expansion-2026-11-10).
Record the completed regular CI run for D13 and a manual run of
`solokpdf-asan.yml` for E17. Record revision, run URL, step results and failures;
neither task requires a full-suite run. The weekly ASan schedule starts when
its workflow reaches the default branch.

## Design review

The [refactoring plan](refactoring-plan.md) covers rendering, color policy,
cache invalidation, read contracts and document lifetime. Record the affected
paths and outputs first, then follow the order below. File splitting is an
implementation choice, not a completion criterion. The [current architecture](architecture.md)
records existing behavior separately from these proposed changes.

| Order | ID  | Work                                                               | Status                                                            |
| ----- | --- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1     | E22 | Align cache dependencies, keys and invalidation with render inputs | todo — next; retain theme-independent data                        |
| 2     | E18 | Clarify read results, waiting and lazy-editor side effects         | todo — after cache contracts; inspect implementations and callers |
| 3     | E20 | Review document state, ownership, invalidation and lock ordering   | todo — use preceding results; change identified problems          |

E21 is complete within its recorded validation scope. Its stage-selection change
is `8bf864e18`; input capture is recorded under [effective color inputs](history.md#e21-effective-color-inputs-2026-11-10).
E19 is complete within its [recorded validation scope](history.md#e19-render-results-2026-11-10).
Resume at E22. Build/test evidence and the unresolved baseline thumbnail-test
instability remain in the history.

Keep D3 deferred and F1/F3 and distribution outside active scope. For a new code
change, choose affected tests from [testing.md](testing.md); run full suites
only when explicitly requested.

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
