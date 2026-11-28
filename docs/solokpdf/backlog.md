# SolokPDF backlog

This is the live work scope. Completed results are in [history.md](history.md#completed-backlog).
Record new failures here with a trigger, observable outcome and acceptance
check. Add behavior changes to [features.md](features.md) or
[limitations.md](limitations.md). Next free IDs are B80, C2, D17, E159 and F4.
For code changes, select affected tests from [testing.md](testing.md).

## Open

- **E158 — Reader review.** [1A is fixed](history.md#1a--preserve-existing-images-on-save-failure).
  Next, verify that Convert preserves a file created after the preview. Follow the
  [findings, repair order and acceptance checks](reader-review-2026-11.md)
  for search progress, Home accessibility and feedback, and About links.
  The [previous design review](history.md#e157-closure) is closed.

## Not planned

- XFA editing and GoToE are unsupported in both engines.
- The owner froze `src/ng/` on 2026-11-17. SolokPDF build and test coverage
  excludes ng, including verification of shared changes on ng.
- The owner has no plans for GitHub Releases, update checks or release criteria.
- Explorer thumbnails and preview require DLL registration. Default-app
  association already works through `Applications\SolokPDF.exe`.
- Crash-recovery verification, inactive-tab allocation attribution and
  Chrome/Edge rendering comparisons.
