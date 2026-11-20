# SolokPDF backlog

This is the live work scope. Completed results are in [history.md](history.md#completed-backlog).
Record new failures here with a trigger, observable outcome and acceptance
check. Add behavior changes to [features.md](features.md) or
[limitations.md](limitations.md). Next free IDs are B80, C2, D17, E158 and F4.
For code changes, select affected tests from [testing.md](testing.md).

## Open

- E157 — [Win32 product and code design review plan](design-review-plan.md).
  Next is R03, consolidating input selection for Save As.
  [R02 verification](history.md#r02-applied-redactions-in-tool-output).
  The plan tracks each finding, its evidence, execution order and acceptance check.

## Not planned

- XFA editing and GoToE are unsupported in both engines.
- The owner froze `src/ng/` on 2026-11-17. SolokPDF build and test coverage
  excludes ng, including verification of shared changes on ng.
- The owner has no plans for GitHub Releases, update checks or release criteria.
- Explorer thumbnails and preview require DLL registration. Default-app
  association already works through `Applications\SolokPDF.exe`.
- Crash-recovery verification, inactive-tab allocation attribution and
  Chrome/Edge rendering comparisons.
