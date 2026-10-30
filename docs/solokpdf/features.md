# SolokPDF features

Behavior SolokPDF adds to or changes from SumatraPDF. PDF engine behavior is in
[limitations.md](limitations.md).

## Portable identity

SolokPDF disables upstream update checks, commands and settings UI. Existing
`CheckForUpdates` settings remain parseable but have no effect.

- `kAppName` and executable identity change only with `SOLOKPDF_PDFIUM`.
  The underlying upstream target name remains for a small build-system diff;
  the staging wrapper names the runnable application `SolokPDF.exe`.
- `SolokPDF-settings.txt`, local `SolokPDF` / `SolokPDF-data`, instance-map and
  DDE service names are separate. Existing settings are not migrated or overwritten.
- The frame, QuickLook agent class and mutex, QuickLook startup value, and
  preview logging key and directory also have SolokPDF names.
  `ad-hoc-solok-coexist` puts a fake SumatraPDF frame first and checks that
  reuse and DDE reach SolokPDF.
- Upstream binary update checks are disabled for this fork. Installer and file
  associations are not configured or validated; use the portable application.
- Copyright/license files remain unchanged. The package includes root notices,
  vendored license files and all PDFium `licenses/` texts plus the pin manifest.
  MuPDF and its AGPL obligations remain because the fallback/library remain.
- No binary, downloaded PDF, build cache, PDB or archive is added to Git.

## Theme page colors

Added 2026-10-27.

With `DocumentColorsFollowTheme = smart`, PDFium pages take the theme's text and
background colors, as MuPDF's do; `EngineUsesDocumentColorsFollowTheme` used to
exclude PDFium, so its pages stayed white under every theme. Photos keep their
colors on dark and light themes; MuPDF keeps them on dark themes only.

- The recolor is `RenderCache`'s shared bitmap pass. `EnginePdfium`
  `GetBitmapRecolorSkipRects` reports image rects from PDFium's page objects,
  including images in form XObjects, collected on a page's first themed render.
- Each image is decoded once (`FPDFImageObj_GetBitmap`) for MuPDF's classifier,
  now shared as `PdfDarkModeShouldPreserveImagePixels`: scans, layout panels and
  figures on a flat light backdrop (#6088) recolor with the page, as do 1-bit
  images and thin strips.
- Tiles showing a photo skip gray storage: a gray tile's palette recolor can't
  spare it. `off` renders as before; `legacy` recolors everything.
- `RenderCache` no longer keeps only a tile's largest skip rect; MuPDF already
  returns at most one.

New themes: Catppuccin Latte/Frappe/Macchiato, Gruvbox Light, Everforest Light,
Rose Pine Dawn, Sepia.

Inactive tabs of 13 dark themes took colors from outside their palettes, mostly
purple (Solarized Dark `#5b0c6f`): upstream copied an old computed blend. They
now use a neighboring color of the theme's own palette, as Light and Dark do.

Themes change from the keyboard: the command palette (Ctrl+K) lists every
theme as "Set theme '…'" (upstream hides them there), and the Change Theme
dialog previews with the arrow keys, applies with Enter and cancels with Esc.
`T` / `Shift+T` (`CmdNextTheme` / `CmdPrevTheme`, new) step through the themes
in menu order, wrapping, and show the new theme's name.
`tests/ad-hoc-theme-keyboard.ts` drives all three.

`smart` is now the default (upstream: `off`); a settings file that saved `off`
keeps it. Light keeps white pages; Light Gray (new) is the gray-page variant,
with gray sidebar, tabs, toolbar and title bar too.

`tests/ad-hoc-pdfium-theme.ts` checks a dark and a light theme: no white paper,
both photos untouched, a figure's gray backdrop recolored, and `legacy` recoloring
photos; it fails on the previous build. `issue-6088` and `issue-5911`, run with
SolokPDF's settings file, pass on both engines, as does `ad-hoc-pdfium`.

`ad-hoc-pdfium-theme-switch` keeps one PDFium tab open through dark → light →
dark, then smart → legacy → off → smart. Photo and paper counts return to their
original values. PDFium's cached image rectangles describe page objects and do
not depend on theme or mode; `UpdateDocumentColors` advances the render cache's
dark-mode epoch. B6 needs no engine invalidation.

## Count prefix

`KeyScrollLineAmount` sets the vertical keyboard line step (default 48 px at
96 DPI); values below 1 fall back to `ScrollLineAmount`. `j`/`k`, Up/Down,
command counts, and count prefixes use it. Wheel, touchpad, scrollbar arrows,
and horizontal scrolling retain `ScrollLineAmount`. Ng uses the same keyboard
step; its command count behavior remains separate.

In the document view, digits prefix the next scroll or page command (`3j`,
`10k`). The prefix multiplies a command's own count argument, stops at 9999,
and clears on Esc, mouse input, focus loss, or another command. A shortcut
assigned to a digit takes precedence. The pending count appears at the bottom
right. This Windows UI behavior has no ng counterpart yet.

## Keyboard shortcuts dialog

Settings > Customize Keyboard Shortcuts opens a filterable command and binding
list. It captures key combinations, accepts command arguments, warns before
reassigning a key, and removes or resets user bindings. OK saves Shortcuts and
reloads accelerators immediately; Cancel discards edits. Built-in keys cannot
be removed because the settings format has no way to suppress them without
assigning the key to another command. Ng needs a GPUI version of this dialog.

## Vim key mode

`VimKeys = true` enables the mode; it is off by default. Settings > Vim Key
Mode and the command palette toggle it. User `Shortcuts` take precedence.
Keys work in the document canvas or frame, not in edit fields.

| Keys                             | Action                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| `gg`, `G`, `{n}gg`, `{n}G`       | First, last, or numbered page                              |
| `/`, `n`, `N`                    | Find box, next match, previous match                       |
| `Ctrl+O`, `Ctrl+I`               | Navigation back, forward                                   |
| `f`                              | Label visible links; type a label to follow, Esc to cancel |
| `m{a-z}`, `'{a-z}`, `` `{a-z} `` | Set or jump to a document mark                             |
| `''`                             | Return to the position before the last jump                |
| `Ctrl+D/U`, `Ctrl+F/B`           | Half-page or full-page down/up; counts apply               |
| `Ctrl+E/Y`                       | One wheel line down/up (`ScrollLineAmount`); counts apply  |
| `zz`, `zt`, `zb`                 | Center current page, align its top or bottom               |
| `yy`, `{n}yy`                    | Copy current page text, or text from `n` pages             |
| `gt`, `gT`, `{n}gt`              | Next, previous, or numbered tab                            |
| `:`                              | Bottom command line                                        |

The command line accepts a page number, `q` (close tab), `qa` (exit), `w`
(Save As), `tabn`, `tabp`, `set vim`, and `set novim`. Up/Down recall commands
for the session; other text opens a filtered command palette. Marks use page
coordinates and persist in `FileState.VimMarks` when file history is enabled.

Displaced defaults: `g` Go To Page dialog, `n` next page, `f` fullscreen,
`m` cursor position, `Ctrl+O` Open, `Ctrl+D` Properties, `Ctrl+F` Find,
`Ctrl+B` Add Favorite, and `Ctrl+Y` Custom Zoom. `Ctrl+E` and `Ctrl+U`
were unbound. The menus retain the displaced commands. `p`, Space and
PageDown retain previous-page and page-down navigation.

Link hints use the existing page-link path and work on fixed-page documents.
The Windows keyboard layout supplies `/`, `'`, `` ` ``, and `:` through OEM
keys; other layouts need verification. Ng has the setting and command ids but
still needs GPUI input, hints, marks, and command-line UI.
