# Upstream merge assessment — 2026-10-29

`upstream/master` was fetched at `a30e4d642` (2026-10-28). The merge base
with `solokpdf-dev` is `842ea1be5` (2026-10-22). Upstream is **71 commits**
ahead of that base. This assessment uses local commit `ece895b27` as the
SolokPDF side.

## Changes since the base

Areas overlap; the counts below are not additive. The feature and fix counts
use commit subjects; path counts include every commit touching that area.

| Area                  |                                                                     Commits | Notable changes                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Features and behavior |                                                           17 feature-titled | Sidebar auto-hide and middle panel, Merge PDF cut/copy/paste and rotation, annotation popup font size, GIF image conversion, EPUB media links.                            |
| Fixes                 |                                          36 fix/deflake-titled or `fixes #` | Printing to XPS drivers, markdown folder isolation and raw HTML handling, ebook covers and layout, image scroll restoration, free-text editing, clipboard/test stability. |
| MuPDF and patches     |                                     8 touching `ext/mupdf` or `ext/patches` | PDF script name-tree and array fixes, type 1 shading speed, CSS counters, font fallback, EPUB media links. Patches `0065`–`0072` accompany vendored edits.                |
| Other dependencies    | 4 touching `ext/gpui`, `ext/a-brotli`, `ext/heicdec`, or `ext/versions.txt` | GPUI update and Brotli revision/header split; one AVIF decoder fix.                                                                                                       |
| ng                    |                                                        23 touching `src/ng` | Middle sidebar, Merge PDF operations, Home page, HTML key scrolling, and shared settings/UI fixes.                                                                        |

The sidebar, Merge PDF, printing, and markdown fixes are the most useful
upstream changes to take soon. The GPUI and Brotli updates need build review
because they replace large generated sources.

## Trial merge

Ran `git merge --no-commit --no-ff upstream/master` in a detached worktree at
`ece895b27`. Git reported six conflicting files:

| File                      | Conflict                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `cmd/gen-commands.ts`     | Both sides appended commands: SolokPDF theme/Vim commands and upstream sidebar auto-hide. Preserve both and stable local IDs.       |
| `src/shared/Commands.h`   | Generated IDs overlap at 539; regenerate after deciding command order.                                                              |
| `src/shared/Commands.cpp` | Generated command table has the same appended-command overlap.                                                                      |
| `src/Settings.cpp`        | Generated field count, names, and descriptions differ for SolokPDF `VimKeys` and upstream settings.                                 |
| `src/ng/Settings.cpp`     | Same generated settings conflict in ng.                                                                                             |
| `src/SumatraControl.cpp`  | Both sides assigned debug-control ID 139 (`TestShortcutsDialog` / `TestMarkdownServed`); adjust the paired `tests/control.ts` enum. |

Git auto-merged the remaining changes, including app, shared, ng, and build
files. That is a text-merge result, not a build or behavior check. The trial
was aborted and the temporary worktree removed; no merge was made on
`solokpdf-dev`.

## Recommended approach

Merge `upstream/master` in a separate integration branch. Resolve the command
and control IDs first, then reconcile `cmd/gen-settings.ts` and
`cmd/ng-gen-settings.ts` and regenerate commands/settings rather than editing
generated strings. Review auto-merged SolokPDF PDFium and Vim paths, the
sidebar, and Merge PDF behavior. Build SolokPDF and ng, then run targeted
tests for those areas. Keep the existing MuPDF patch ledger intact.

Rough effort: **2–4 engineer-days** for conflict resolution, regeneration,
builds, and focused tests. Further runtime issues may extend that estimate.

## Merge result

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

Open: no known merge regression. The full suites and ng GUI runtime were not
run. The website checkout is absent, so generated settings docs were skipped.

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
thumbnails option, in layout code identical to upstream's. The ng build, full
suites and these click tests on an unlocked desktop were not run.
