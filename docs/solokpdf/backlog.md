# SolokPDF backlog

This is the live work scope. Completed results are in [history.md](history.md#completed-backlog).
Record new failures here with a trigger, observable outcome and acceptance
check. Add behavior changes to [features.md](features.md) or
[limitations.md](limitations.md). Next free IDs are B80, C2, D17, E158 and F4.
For code changes, select affected tests from [testing.md](testing.md).

## Open

- E157 — [Win32 product and code design review plan](design-review-plan.md).
  The five batches are recorded from [R20](history.md#r20-settings-across-windows)
  through [R28](history.md#r26-r27-r28-build-and-distribution).
  R20, R21, R23, R24, R27 and R28 are complete. R26 retains the current design.
  R12, R13, R14, R22 and R25 remain held. R21's early-release proposal also
  needs retention data. The plan records each resumption condition.

## Not planned

- XFA editing and GoToE are unsupported in both engines.
- The owner froze `src/ng/` on 2026-11-17. SolokPDF build and test coverage
  excludes ng, including verification of shared changes on ng.
- The owner has no plans for GitHub Releases, update checks or release criteria.
- Explorer thumbnails and preview require DLL registration. Default-app
  association already works through `Applications\SolokPDF.exe`.
- Crash-recovery verification, inactive-tab allocation attribution and
  Chrome/Edge rendering comparisons.
