# SolokPDF backlog

This is the live work scope. Completed results are in [history.md](history.md#completed-backlog).
Record new failures here with a trigger, observable outcome and acceptance
check. Add behavior changes to [features.md](features.md) or
[limitations.md](limitations.md). Next free IDs are B78, C2, D17, E156 and F4.
For code changes, select affected tests from [testing.md](testing.md).

## Open

### D15 Hosted validation

At `82f8882c1`, MuPDF Debug and ASan passed. PDFium Debug failed only
`issue-6167`. [Run record](history.md#d15-hosted-verification-at-82f8882c1-2026-11-20)
The corrected test passed 20 local Debug runs per engine.

1. When full-suite verification is requested, run hosted Debug with PDFium
   and MuPDF with the `tests` input empty. Run hosted ASan on the same
   revision. [Full-suite procedure](testing.md#hosted-full-suite) ·
   [ASan procedure](testing.md#asan-ci)
2. Record the tested revision, run IDs, exclusions and failures in
   [history.md](history.md#d15-hosted-verification-at-82f8882c1-2026-11-20).
   Close D15 when all three runs pass on that revision.

### D16 PDFium cache repair

Parallel offline repairs failed with `EPERM` while replacing `bin/pdfium.dll`
in [regular CI 44714775080](https://github.com/elle-et-noire/solokpdf/actions/runs/44714775080/job/136215238454).
Both repairs must exit successfully and leave the pinned files in the cache.
`bun tests/solok-pdfium-pin.ts` passed 12 consecutive local runs.

## Not planned

- XFA editing and GoToE are unsupported in both engines.
- The owner froze `src/ng/` on 2026-11-17. SolokPDF build and test coverage
  excludes ng, including verification of shared changes on ng.
- The owner has no plans for GitHub Releases, update checks or release criteria.
- Explorer thumbnails and preview require DLL registration. Default-app
  association already works through `Applications\SolokPDF.exe`.
- Crash-recovery verification, inactive-tab allocation attribution and
  Chrome/Edge rendering comparisons.
