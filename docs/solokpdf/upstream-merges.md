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
requests. Network-dependent EU Trusted List and revocation probes and the large
external RTF corpus were skipped.

Later test-cursor and DPI fixes removed the general cursor-input constraint;
foreground popups still need an unlocked desktop.

Follow-up commits `c97ca137f` restored the upstream vs2022 projects, and
`0522b0580` passed PDFium tabs' passwords to PDF Info and extraction after
review.

## Merge result (2026-11-08)

Merged `upstream/master` at `8b716234f`, 207 commits after `254c2ae7c`, into
`solokpdf-dev` (D7). Upstream brought PDF layers, the measuring tool, Replace
Image, Mirror Pages, Trim Pages To Selection, Read Columns, Count Words, Show
Selected Text, the page info bar, tab groups, Ctrl+Shift+T window reopen,
toolbar wrapping, auto-scroll timer, `InvertMouseWheel`, `FitWidthPercent`,
`TabsEqualWidth`, `TocWrapText`, mouse side-button and media-key shortcuts,
Previous/Next Chapter, Open from URL, OFD documents, link `/QuadPoints`, KiCad
JavaScript menus, Arabic copy fixes, markdown-it, MuPDF patches `0083`–`0085`
and a refactor moving duplicated orig/ng functions into `src/shared/*Common.cpp`.

Conflicts (48 files):

| File                                                        | Resolution                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build.yml`, `linux-daily.yml`, `.gitignore`                | Workflows stay deleted; `.gitignore` is the union.                                                                                                                     |
| `cmd/gen-commands.ts`, settings generators, generated files | Upstream's entries first, SolokPDF's after; regenerated, SolokPDF defaults kept. Both added Ctrl+T → CmdNewTab; one kept. No other default shortcut collides.          |
| `SumatraControl.cpp`, `tests/control.ts`                    | Upstream ids to 162 (161–162 ng only); SolokPDF's 163–173. `lint-control-ids` passes.                                                                                  |
| `ext/patches/README.md`                                     | SolokPDF's patches renamed `solok-0001`–`solok-0020` in their own table, applied after upstream's numbered ones; none shares a MuPDF file with `0083`–`0085`.          |
| Moved to `*Common.cpp`                                      | SolokPDF's edits re-applied there: thumbnail colors and pending flag, PDFium encryption in the command context, editor routing for signatures and attachments, probes. |
| `Canvas.cpp`, `WindowBase.cpp`, `Win.cpp`, `MainWindow.cpp` | Kept key-scroll amounts, test activation and clipboard helpers with upstream's lifetime checks; upstream's removed unused helpers stay removed.                        |
| Theme UI, tabs, TOC, palette, settings dialogs              | Kept SolokPDF colors, every-tab ✕ and single settings screen; the pinned Home tab has no ✕; wrapped TOC rows draw with SolokPDF's hover.                               |
| `EngineBase.cpp`, `RenderCache.cpp`, `EngineMupdf.cpp`      | Upstream's retired page-text list; SolokPDF's `RenderViewPage` with upstream's `RenderWasDropped`; OFD signatures/attachments with PDFium editor routing.              |
| Tests                                                       | Upstream tests write `SETTINGS_FILE` and use the test cursor; SolokPDF's test order stays first in `run-almost-all.ts`.                                                |

Follow-ups for PDFium tabs and SolokPDF defaults:

| Feature                                               | PDFium status                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Link `/QuadPoints` (#6472)                            | Read with `FPDFLink_GetQuadPoints`; hit test shared with MuPDF.                                     |
| JavaScript menu links (#6503)                         | Already from the editor's links; passes.                                                            |
| Attachment numbers                                    | Copied to PDFium's TOC entries (were -1).                                                           |
| `elementsGeneration`                                  | PDFium frees no elements; the canvas adds the editor's generation, whose elements PDFium hands out. |
| Layers (#6486)                                        | Hidden: PDFium draws default states and can't change them.                                          |
| Measure snapping (#750)                               | PDFium path points.                                                                                 |
| Replace Image / Edit Image in Another App             | Hidden: PDFium wouldn't show the replaced image.                                                    |
| Mirror, Trim To Selection, Count Words, Selected Text | Work unchanged.                                                                                     |
| Read Columns                                          | Fixed for overlay scrollbars on both engines.                                                       |
| Arabic copy (#6483, #6485, #6488)                     | Spaces and ligatures fixed; ActualText words stay in visual order.                                  |
| Page info bar                                         | PDF version, Encrypted and Signed from PDFium.                                                      |
| Theme colors                                          | Page info bar takes the toolbar's canvas color; Layers and Signatures lists the sidebar's.          |

Upstream tests assume upstream defaults: `issue-6476` now keeps the Home
tab, `issue-6221` uses Windows scrollbars, `issue-6469` expects no list
focus ring (SolokPDF dropped it), and on PDFium `issue-6486` and
`replace-image` check that the features are hidden and `issue-6485` checks its
ligature lines. `replace-image` saves the edited image again until the file
watcher, which starts on its own thread, sees it. The ng settings golden file
gains `FavoritesManualOrder`, which upstream added without updating it.

Tests: SolokPDF and ng Windows debug builds passed; `lint-command-ids`, `lint-control-ids`,
`lint-desktop-input`, `lint-system-clipboard` and `lint-posted-tasks` passed.
The debug unit runner passed 105092 tests and ng `test_util` 106830. The
SolokPDF CI set passed 62/64 after the last change; `ad-hoc-pdfium-commands`
then gained the two hidden image commands as intended differences and passed,
and `ad-hoc-selection-outlines` passed four reruns. 61 merge-touched upstream
and SolokPDF tests ran on PDFium and 56 on MuPDF (step-4 features, tabs, TOC,
thumbnails, auto-scroll, mouse buttons, tab groups, keyboard, IME, theme keys):
all pass except `issue-4788` on both engines (fixed after the merge: it
now measures with `DocumentColorsFollowTheme = off`, since smart colors tint
the page with Light's #f2f2f2) and `overlay-scrollbar-theme` on PDFium (screen capture needs a
visible desktop). Not done: the full suites, a dark/light screenshot check of
the new UI, and byte verification of the MuPDF patch ledger (no pristine
1.28.5 checkout here).

Review fixes: signed OFD files lost their signature bar because the merge
took every EngineMupdf document for a PDF (`issue-1909`); upstream's
keyboard focus ring returned to the thumbnails sidebar and is off again
(`issue-6469` now checks the ring's state after Down); a PDFium tab no
longer clears layer states a MuPDF tab saved. Read Columns now centers a
column on the page area beside an overlay scrollbar (B74), and `issue-6221`
checks Mirror with overlay scrollbars against the page rect (B75). These review
fixes are complete; the unperformed validation listed above remains unverified.
