# SolokPDF backlog

Open work as of 2026-11-10. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D14, E23, F4).

## Implementation and acceptance

E10–E16 and D8–D13 records are in [history.md](history.md#navigation).
E16 is committed as
`fc8b455e8`; its regular CI passed Debug/Release builds, unit tests and feature
tests. See [D12's evidence and limits](history.md#d12-hosted-evidence-2026-11-10).

F1/F3 were removed from active work by the owner on 2026-11-10, without marking
them passed. Their earlier procedures and pending-check records are historical.

## Next steps

CI coverage expansion is committed as `9083edafe`. D13 is complete: its first
regular CI and the latest run at `7d107cea8` passed. E17's first manual ASan
run at `7d107cea8` built successfully, but both tests failed before opening
their windows; see the [diagnosis](history.md#hosted-d13e17-validation-2026-11-10).

| ID  | Work                                                                             | Status                                                                                       |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| E17 | Run a clean ASan build, tree lifetime and PDFium fallback checks manually/weekly | doing — local runtime-selection fix and repeated targeted tests passed; hosted retry pending |

Implementation and local results are in [history.md](history.md#ci-coverage-expansion-2026-11-10).
The local fix shares runtime selection between `cmd/build.ts` and
`cmd/run-unit-tests.ts`, using the installed default MSVC toolset's x64 DLL.
Regression checks, the ASan build and both affected tests passed locally;
the fix is included in `Match ASan runtime to the MSVC toolset`. Rerun E17 and record the
build and both test results before closing it. The weekly schedule is configured
on the default branch, `solokpdf-dev`; no full-suite run is required.

## Design review

The [refactoring plan](refactoring-plan.md) covers rendering, color policy,
cache invalidation, read contracts and document lifetime. Record the affected
paths and outputs first. File splitting is an
implementation choice, not a completion criterion. The [current architecture](architecture.md)
records existing behavior separately from these proposed changes.

E18–E22 are complete within their recorded validation scope; no design-review
item remains active.

E21 is complete within its recorded validation scope. Its stage-selection change
is `8bf864e18`; input capture is recorded under [effective color inputs](history.md#e21-effective-color-inputs-2026-11-10).
E19 is complete within its [recorded validation scope](history.md#e19-render-results-2026-11-10).
E22 is complete within its [recorded validation scope](history.md#e22-cache-contracts-2026-11-10).
E18 is implemented as `Clarify read and editor contracts (E18)`; [read-contract results](history.md#e18-read-contracts-2026-11-10)
record its local validation and remaining limits.
E20's retained-input changes and ownership/lock audit are in the
[document-lifetime record](history.md#e20-document-lifetime-2026-11-10).
E20 is complete as `Preserve document source lifetimes (E20)` within that scope.
Build/test evidence and the unresolved baseline thumbnail-test
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
