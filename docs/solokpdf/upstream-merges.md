# Upstream merges

## Assessment (2026-10-29)

At `ece895b27`, `upstream/master` at `a30e4d642` was 71 commits ahead of the
`842ea1be5` base, bringing sidebar, Merge PDF, printing and markdown changes.
A detached trial merge found six conflicts in generated commands/settings and
debug-control IDs; it was aborted without a build or behavior check.
The planned integration branch would regenerate tables, review PDFium/Vim paths
and preserve MuPDF patches; estimated effort was 2–4 engineer-days.

## Merge result (27797acfd)

Merged `upstream/master` at `27797acfd` (75 commits from the base) on
`merge-upstream`. Upstream's sidebar command precedes SolokPDF's theme/Vim
commands; command IDs shift, but shortcuts and settings use names. Regenerated
both command and settings tables, kept SolokPDF's settings defaults, and moved
its debug-control IDs after upstream's 139. PDFium remains the default;
branding, app-data paths, and disabled update checks are retained. Vendored
MuPDF edits and patches `0065`–`0072` remain paired.

SolokPDF and ng Windows debug builds passed. Unit tests, all 15 PDFium ad-hoc
tests (including 300 fuzz inputs), the five requested keyboard/theme/update
checks, and targeted sidebar/Merge PDF tests passed. The Vim test failed once
on injected keys, then passed three reruns. Two upstream sidebar tests needed
SolokPDF's settings filename and DPI-aware click coordinates; both now pass.

Open: no known merge regression. The full suites later passed in run
41349548951; ng GUI runtime was not run. The website checkout is absent, so
generated settings docs were skipped.

## Merge result (2026-10-31)

Merged `upstream/master` at `f45967f87`, 25 commits after `27797acfd`, into
`solokpdf-dev`. Upstream brought Convert EPUB to PDF, EPUB footnote popups,
markdown code highlighting (`microlighter`), separate Explorer thumbnail and
preview handlers, temporary-file copy offers, `DisableLeftDragPan`,
`ShowThumbnailsIfNoToc`, a no-overwrite Convert PDF to Images, clipped image
rects, faster search, unique crash minidumps, a GPUI update and MuPDF patch
`0073` (EPUB footnotes, paired with its vendored edits).

Conflicts:

| File                                                                    | Resolution                                                                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd/gen-commands.ts`                                                   | Upstream's three commands first, SolokPDF's theme/Vim commands after; regenerated `Commands.h/.cpp`.                                      |
| `src/Settings.cpp`, `src/ng/Settings.cpp`                               | Regenerated with both settings generators (merged cleanly); SolokPDF defaults kept.                                                       |
| `src/SumatraControl.cpp`, `tests/control.ts`                            | Upstream took debug-control 140–144; SolokPDF's moved to 145–150.                                                                         |
| `src/SumatraPDF.cpp`                                                    | Save-as name: upstream's open-cache base name plus SolokPDF's data-backed PDFium name. Crash message: upstream's wording with `kAppName`. |
| `tests/issue-5819.ts`, `tests/issue-6252.ts`, `tests/run-almost-all.ts` | Kept SolokPDF's `SETTINGS_FILE` and test order on top of upstream's rewrites.                                                             |

`issue-6407`, `issue-6437` and `issue-6444` now write `SETTINGS_FILE`.
`gen-code.ts` could not regenerate virtual-key tables (no `cl` on PATH); the
command, settings and flag generators ran and match.

Tests: `solok-build -dbg` passed; 104622 unit tests passed; 36/36
`run-solokpdf-ci.ts`. Merge-touched upstream tests on PDFium and MuPDF: 5819,
5924, 6230, 6252, 6360, 6402, 6407, 6433, 6434, 6435, 6437, 6444 and
`ng-embedded` passed. `issue-6441` passed on MuPDF only (PDFium image rects
ignored clip paths; fixed separately, B48). Failing on both engines here:
`convert-epub-to-pdf`, `issue-6431` and `issue-6439` click dialog or canvas
controls, which this locked desktop drops (as B37/B39; `annot-nudge` fails the
same way before the merge); `installer-desktop-shortcut` and `issue-6442` find
the installer's checkboxes overlapping by 1 px with upstream's added
thumbnails option, in layout code identical to upstream's. The ng build and
full suites were not run then. All five tests passed on both engines in hosted
CI run 41349548951.

## Merge result (2026-11-02)

Merged `upstream/master` at `254c2ae7c`, 80 commits after `f45967f87`, into
`solokpdf-dev`. Upstream brought EU Trusted List and revocation validation,
validation at signing time, the Signatures sidebar and `CmdShowSignatures`,
LIT/ebook/RTF fixes, Ctrl+drag highlights, `CmdDebugSaveSettings`, extra Home
tabs with a "+" button, thumbnail progress, GPUI, ng/wasm work, and MuPDF
patches `0074`–`0082`. All vendored patch names appear in the patch ledger.

Conflicts:

| File                                              | Resolution                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `cmd/gen-commands.ts`, generated commands         | Upstream's commands first, SolokPDF's theme/Vim commands after; regenerated.                      |
| Generated settings                                | Regenerated both versions from merged generators; SolokPDF defaults retained.                     |
| `src/SumatraControl.cpp`, `tests/control.ts`      | Upstream IDs 145–148; SolokPDF IDs moved to 149–154.                                              |
| `TabsCtrl.cpp`, sidebar and ng shell              | Kept SolokPDF theme colors and close buttons; added Home sizing and themed "+"; kept ng branding. |
| `MergePdf.cpp`, `PdfTools.cpp`, shared MuPDF code | Kept PDFium encrypted-file handling and upstream tool keys, widgets and signature validation.     |
| Properties, exports, test list                    | Kept PDFium dates, EPUB ISO dates and extra exports; combined upstream tests with SolokPDF order. |

Signed PDFium tabs use the hidden MuPDF editor for the signature list and
validation, after PDFium finds nonempty signature contents. Unsigned PDFium
tabs leave the editor unloaded. Ctrl+drag highlight uses the shared selection
path on PDFium tabs.

SolokPDF and ng Windows debug builds passed. The debug unit runner passed
104843 tests with each engine. The PDFium CI set passed 39/39; the MuPDF run
passed 36/39, with three PDFium-specific assertions in `sig-status`,
`catalog-layout` and `theme-switch` inapplicable to MuPDF. Both engines passed
`issue-6467`, `issue-6468`, `create-annot-enters-edit-mode`, RTF, encrypted PDF
tools and password reuse. `issue-6455` passed on both with the VS compiler
environment; `issue-6448` and `issue-6459` failed on both (no WebView thumbnail
and no PDF after the simulated Convert click).

The locked desktop prevented the foreground/click checks in `issue-6269`,
`issue-6385`, `issue-6464` and `sig-validation` on both engines. `issue-5918`
did not switch to the next Markdown file; `issue-6380` saw no WebView resource
requests. These need an unlocked desktop rerun. Network-dependent EU Trusted
List and revocation probes and the large external RTF corpus were skipped.

Follow-up commits `c97ca137f` restored the upstream vs2022 projects, and
`0522b0580` passed PDFium tabs' passwords to PDF Info and extraction after
review.
