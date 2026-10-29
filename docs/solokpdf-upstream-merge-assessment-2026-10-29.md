# Upstream merge assessment — 2026-10-29

`upstream/master` was fetched at `a30e4d642` (2026-10-28). The merge base
with `solokpdf-dev` is `842ea1be5` (2026-10-22). Upstream is **71 commits**
ahead of that base. This assessment uses local commit `ece895b27` as the
SolokPDF side.

## Changes since the base

Areas overlap; the counts below are not additive. The feature and fix counts
use commit subjects; path counts include every commit touching that area.

| Area | Commits | Notable changes |
| --- | ---: | --- |
| Features and behavior | 17 feature-titled | Sidebar auto-hide and middle panel, Merge PDF cut/copy/paste and rotation, annotation popup font size, GIF image conversion, EPUB media links. |
| Fixes | 36 fix/deflake-titled or `fixes #` | Printing to XPS drivers, markdown folder isolation and raw HTML handling, ebook covers and layout, image scroll restoration, free-text editing, clipboard/test stability. |
| MuPDF and patches | 8 touching `ext/mupdf` or `ext/patches` | PDF script name-tree and array fixes, type 1 shading speed, CSS counters, font fallback, EPUB media links. Patches `0065`–`0072` accompany vendored edits. |
| Other dependencies | 4 touching `ext/gpui`, `ext/a-brotli`, `ext/heicdec`, or `ext/versions.txt` | GPUI update and Brotli revision/header split; one AVIF decoder fix. |
| ng | 23 touching `src/ng` | Middle sidebar, Merge PDF operations, Home page, HTML key scrolling, and shared settings/UI fixes. |

The sidebar, Merge PDF, printing, and markdown fixes are the most useful
upstream changes to take soon. The GPUI and Brotli updates need build review
because they replace large generated sources.

## Trial merge

Ran `git merge --no-commit --no-ff upstream/master` in a detached worktree at
`ece895b27`. Git reported six conflicting files:

| File | Conflict |
| --- | --- |
| `cmd/gen-commands.ts` | Both sides appended commands: SolokPDF theme/Vim commands and upstream sidebar auto-hide. Preserve both and stable local IDs. |
| `src/shared/Commands.h` | Generated IDs overlap at 539; regenerate after deciding command order. |
| `src/shared/Commands.cpp` | Generated command table has the same appended-command overlap. |
| `src/Settings.cpp` | Generated field count, names, and descriptions differ for SolokPDF `VimKeys` and upstream settings. |
| `src/ng/Settings.cpp` | Same generated settings conflict in ng. |
| `src/SumatraControl.cpp` | Both sides assigned debug-control ID 139 (`TestShortcutsDialog` / `TestMarkdownServed`); adjust the paired `tests/control.ts` enum. |

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
