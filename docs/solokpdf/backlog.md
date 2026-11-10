# SolokPDF backlog

Work scope as of 2026-11-10. E23–E25 are complete within the recorded review scope.
E26–E30 are complete; E31–E37 remain open fixes and regression checks.
D3 remains deferred. Status: `todo`, `doing`, `blocked` (reason), `deferred` (reason).
When an item lands, move its row with the commit subject to
[history.md](history.md#completed-backlog); behavior goes in
[features.md](features.md) or [limitations.md](limitations.md). New items take the next free ID in their
group (B76, C2, D14, E38, F4).

## Implementation and acceptance

Completed D8–D13 and E10–E22 records are in
[history.md](history.md#navigation). The [status page](README.md#validation-scope)
summarizes recorded CI results and evidence limits.

F1/F3 were removed from active work by the owner on 2026-11-10, without marking
them passed. Their earlier procedures and pending-check records are historical.

## Next steps

Continue with E34, E37 and E32 using the [review priorities](full-review-results.md#e25-再点検).
Continue with E35/E36, E33 and E31. Detailed edit-change detection
belongs to E36. E37's partial-redaction notification is P1.
E31 can proceed independently; keep its HANDLE fix separate from E32.
Keep D3 deferred and F1/F3 and distribution outside active scope. For a code change, choose
affected tests from [testing.md](testing.md); run full suites only when
explicitly requested.

## Design review

E18–E22 are complete within their recorded validation scope. The [completed plan](refactoring-plan.md) maps each item
to its implementation and results. The [current architecture](architecture.md)
records the resulting responsibilities and contracts.

Assess correctness, maintainability and performance using the
[review plan's evaluation criteria](full-review-plan.md#評価観点). Operation
paths guide investigation without limiting its scope. Record the code actually
read; check build and test infrastructure where the investigation or a change requires them.

| ID  | Item                                                                 | Status                                                                                                                                      |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| E31 | Close the asynchronous controller-delete thread handle (R6, P2)      | todo — code finding; retain/close HANDLE, compare repeated closes and check ASan                                                            |
| E32 | Guarantee worker lifetime when render-cache shutdown times out (P1)  | todo — stop before pending-delete/shared cleanup; clear requests on exit; account for dangerous threads; retain dependencies if not stopped |
| E33 | Distinguish failed page text extraction from a completed empty page  | todo — failure/recovery reproduced in PDFium: raw text recovers, cached text stays empty (R7, P2); add explicit failure result              |
| E34 | Verify targets after synchronous reload and Save As dialogs (R9, P1) | todo — DDE during Save As saves the other tab; Debug/ASan reproduced; reload cleanup also retained an ASan lifetime diagnostic              |
| E35 | Preserve choice-field validation rejection (R8, P2)                  | todo — both engines reproduced twice; return the MuPDF setter result instead of unconditional success                                       |
| E36 | Publish committed edits after refresh failures (R10, P2)             | todo — code finding; distinguish accepted value, committed changes and update error; notify dirty/render/text for actual changes            |
| E37 | Report partial redaction and reconcile failed pages (R11, P1)        | todo — code finding; P1 for retained text reported removed; retain successes, warn on failures, preserve marks, reconcile wrappers/journal  |

E23's mapping and E24's initial inspection are in [history.md](history.md#e23e25-structure-and-code-review-2026-11-10).
E24's [completion](history.md#e24-review-completion-2026-11-10) records the final investigation and its limits.
E25's [record](history.md#e25-review-synthesis-2026-11-10) records the recheck, scope correction and completed synthesis.
Each remaining item's evidence, impact and next check are in [full-review-results.md](full-review-results.md).
Fixes remain separate from this review's documentation; write failing regression tests before changing product code.

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
