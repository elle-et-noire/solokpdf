# SolokPDF backlog

Open work as of 2026-11-10. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D13, E17, F4).

## Implementation and acceptance

No active product implementation item remains. Completed E10–E16 and D8–D11
records are in [history.md](history.md#navigation). E14 is committed as
`bef32a49c` and locally validated;
see its [results](history.md#e14-virtual-tree-encapsulation-2026-11-10).

F1/F3 were removed from active work by the owner on 2026-11-10, without marking
them passed. Their earlier procedures and pending-check records are historical.

## Next steps

Plan based on local HEAD `bef32a49c` with E16's build/test changes in the
working tree. No remote checks were run.

| Order | ID  | Work                                                | Status                   |
| ----- | --- | --------------------------------------------------- | ------------------------ |
| 1     | D12 | Record hosted validation for the published revision | todo — after publication |

E15's review of the four refactors is complete by owner confirmation
(2026-11-10); see the [record](history.md#e15-refactor-review-2026-11-10).
E16's ASan build path is implemented and locally validated; see the
[results](history.md#e16-asan-build-path-2026-11-10) and
[test procedure](testing.md#asan-builds).

### D12: Hosted evidence

When the source revision is available on hosted CI, inspect its regular run.
Record the run URL, revision and Debug/Release, unit and
feature-test results. A docs-only push does not trigger regular SolokPDF CI.
Use a targeted hosted recheck only for an unresolved path; do not dispatch a
full suite for this plan. Later scheduled results remain scoped to their own
revision.

Done when the README links to the checked revision's hosted evidence and lists
any failed or missing checks with their follow-up. Publication and workflow dispatch are not part of this
documentation task. D3 remains deferred; F1/F3 and distribution remain outside
active scope.

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
