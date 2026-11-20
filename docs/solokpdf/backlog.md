# SolokPDF backlog

This is the live work scope. Completed results are in [history.md](history.md#completed-backlog).
Record new failures here with a trigger, observable outcome and acceptance
check. Add behavior changes to [features.md](features.md) or
[limitations.md](limitations.md). Next free IDs are B80, C2, D17, E157 and F4.
For code changes, select affected tests from [testing.md](testing.md).

## Open

Run local GUI checks on the [hidden desktop](testing.md#local-windows-runs).

### D15 Hosted validation

At `3a2c34ac0`, MuPDF Debug and ASan passed. PDFium Debug failed only
`issue-6140`. The test now waits for the initial WebView2 scroll report.
[Run record](history.md#d15-hosted-verification-at-3a2c34ac0-2026-11-20)

1. When full-suite verification is requested, run hosted Debug with PDFium
   and MuPDF with the `tests` input empty. Run hosted ASan on the same
   revision. [Full-suite procedure](testing.md#hosted-full-suite) ·
   [ASan procedure](testing.md#asan-ci)
2. Record the tested revision, run IDs, exclusions and failures in
   [history.md](history.md#d15-hosted-verification-at-3a2c34ac0-2026-11-20).
   Close D15 when all three runs pass on that revision.

## Not planned

- XFA editing and GoToE are unsupported in both engines.
- The owner froze `src/ng/` on 2026-11-17. SolokPDF build and test coverage
  excludes ng, including verification of shared changes on ng.
- The owner has no plans for GitHub Releases, update checks or release criteria.
- Explorer thumbnails and preview require DLL registration. Default-app
  association already works through `Applications\SolokPDF.exe`.
- Crash-recovery verification, inactive-tab allocation attribution and
  Chrome/Edge rendering comparisons.
