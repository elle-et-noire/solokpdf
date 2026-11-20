# SolokPDF backlog

This is the live work scope. Completed results are in [history.md](history.md#completed-backlog).
Record new failures here with a trigger, observable outcome and acceptance
check. Add behavior changes to [features.md](features.md) or
[limitations.md](limitations.md). Next free IDs are B80, C2, D17, E157 and F4.
For code changes, select affected tests from [testing.md](testing.md).

## Open

Start with B78 because a successful save can leave the wrong document on disk.
B79, E156 and D16 can each be picked up independently. Run local GUI checks
on the [hidden desktop](testing.md#local-windows-runs).

### B78 Save the displayed PDF over a replaced source path

- **Reproduced in Debug.** With automatic reload off, open A, move it aside and put B at its old path. Save As to a fresh path copies A. Save As to the old path returns `OK` and leaves B there.
- **Failing test first.** Extend the `replace` case in [the source-lifetime test](../../tests/ad-hoc-pdfium-source-lifetime.ts). Call `TestSaveFileAs` with the original path and compare the destination bytes with A. Exercise its small and 33 MiB fixtures.
- **Fix and close.** [SaveDocAs](../../src/SumatraPDF.cpp) skips the copy when the path strings match. Route the confirmed save through [EnginePdfium::SaveFileAs](../../src/solokpdf/EnginePdfium.cpp), which owns the retained input and handles identical file objects. Close when both replacement cases write A and the existing moved-source, hard-link and separate-copy checks pass.

### B79 Honor escaped PDF names in the catalog

- **Reproduced in Debug.** A small two-page PDF requesting book view and right-to-left reading opens correctly in both engines. Spell the same keys `/Page#4Cayout` and `/Directi#6Fn` and the PDFium tab opens in continuous view with `r2l=0`. MuPDF honors both settings.
- **Failing test first.** Add the escaped spelling to [the catalog-layout test](../../tests/ad-hoc-pdfium-catalog-layout.ts) and assert the same layout and direction as its plain-spelling book fixture.
- **Fix and close.** [ScanPdfKeys](../../src/solokpdf/EnginePdfium.cpp) uses literal matches to decide whether `ReadCatalog` runs. Decode escaped names or treat an inconclusive scan as requiring the parser. Check the annotation-key flags in the same scanner for the same false-negative pattern. Close when the escaped and compressed fixtures open correctly, the key-free fixture still skips the query and all three keep the editor unloaded.

### E156 Fingerprint large encrypted PDFs from the retained input

- **Found in code review.** For file-backed PDFs of 32 MiB or more, [LoadWithPassword](../../src/solokpdf/EnginePdfium.cpp) reopens the path and reads the entire file under `gPdfiumLock`. Other PDFium tabs wait for that lock. Above [ReadFileWithArena](../../src/base/File.cpp)'s signed-size limit, a failed read is passed on as empty input. The stall duration has not been measured.
- **Failing test first.** Extend [the password test](../../tests/ad-hoc-pdfium-password.ts) with a handle-backed encrypted PDF. Replace its path after the password prompt opens, then remember the password for A. Restore A and verify the saved credentials reopen it in both engines. Inspect the saved key fingerprint against A's digest. Use a controlled read failure to cover the unavailable-fingerprint case without a multi-GiB fixture.
- **Fix and close.** Stream the fingerprint from the retained input outside the global PDFium lock. The remembered MuPDF key and PDFium password must refer to that same input. A read failure must allow manual opening and skip fingerprint-based credential reuse and persistence. Verify bounded chunk reads and that another tab can acquire the PDFium lock while fingerprinting is paused. Retain compatibility with existing saved credentials.

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

- **First check.** Use the two repair processes in [the pin test](../../tests/solok-pdfium-pin.ts). Capture which publication step fails. If local scheduling hides the race, synchronize the workers at the damaged-file check before changing production code.
- **Fix and close.** Inspect [publishPackage and publishFile](../../cmd/solok-fetch-pdfium.ts). Both workers can replace the same file, and the loser checks the destination just once. Coordinate repairs for the same pin and recheck the published bytes. Run the pin test repeatedly on Windows. Both workers must exit zero offline, restore the pinned DLL and header, and preserve timestamps of unchanged headers.

## Not planned

- XFA editing and GoToE are unsupported in both engines.
- The owner froze `src/ng/` on 2026-11-17. SolokPDF build and test coverage
  excludes ng, including verification of shared changes on ng.
- The owner has no plans for GitHub Releases, update checks or release criteria.
- Explorer thumbnails and preview require DLL registration. Default-app
  association already works through `Applications\SolokPDF.exe`.
- Crash-recovery verification, inactive-tab allocation attribution and
  Chrome/Edge rendering comparisons.
