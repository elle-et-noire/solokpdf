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
- About links to this repository's docs, limitations, source and licenses;
  its footer names the upstream SumatraPDF version with links to upstream's
  website and manual. Upstream's author's product promos are not shown.
- Upstream binary update checks are disabled for this fork. Installer and file
  associations are not configured or validated; use the portable application.
- Copyright/license files remain unchanged. The package includes root notices,
  vendored license files and all PDFium `licenses/` texts plus the pin manifest.
  MuPDF and its AGPL obligations remain because the fallback/library remain.
- No binary, downloaded PDF, build cache, PDB or archive is added to Git.

## Theme-colored icon

The app icon is SumatraPDF's (badge, band, "PDF") traced to vector paths in
`src/solokpdf/AppIcon.svg`: badge and band are a few cubics fitted to the
original outline, the letters rounded rects fitted to its text. Windows draw it
in the theme's colors with GDI+ at each size: the badge in the title bar color
(`InactiveTabBackgroundColor`, see below), so it melts into it, and the band and
"PDF" in the document text color (`TextColor`), which the theme already keeps
readable on its background. Title bar, taskbar, Alt+Tab, About and dialogs
follow; windows update on a theme change, open dialogs keep their icon.

The exe's icon (Explorer, Start, shortcuts) can't follow the theme; it is the
same drawing in One Dark's colors. `tools/solokpdf/make-icon.py` generates it
(`src/solokpdf/SolokPDF.ico`) and the path data (`AppIconPaths.h`) from the SVG.

## Chrome-style tabs

Upstream drew the selected tab and the empty tab strip in the toolbar's color
and only unselected tabs as boxes, so the unselected ones stood out. As in
Chrome, the title bar, tab strip, caption buttons and window border now take
`InactiveTabBackgroundColor` (`ThemeTabStripColor`); unselected tabs merge into
it (a hovered one shows a faint box). The selected tab and the toolbar take
the canvas color around the pages, which themed pages share (upstream:
`ControlBackgroundColor`), so with the toolbar hidden the tab joins the
document. `ActiveTabBackgroundColor` now defaults to it; the built-in themes no
longer set it. Every tab shows its close
button (upstream: the selected one only); non-selected tabs narrower than 100
DIP hide it. Hovered, the ✕ steps toward the text color instead of turning
white on a red circle.

The menu bar beside the tabs takes the title bar color and `TextColor`; a
hovered or open menu shows the selected tab's color. Upstream let darkmodelib
draw it as a box in `ControlBackgroundColor` with `DarkerTextColor`.

The sidebar's view icons (Bookmarks, Thumbnails, Favorites) and other icon
buttons hover and select in the toolbar's colors (`HotBackgroundColor`, and
the selection color below for a toggled-on one).

Splitters (sidebar, panels, AI chat) take the panel's color, without upstream's
darker bar; it shows while hovered or dragged.

17 themes got a new strip color: one step darker than the toolbar (contrast at
least 1.18, OKLCH lightness step at most 0.11), taken from the theme's own
colors where one fits (Monokai and Gruvbox their page background, Latte and Ayu
their hover color, Gruvbox Light, Rose Pine Dawn, Sepia and GitHub Dark their
edge color, Purpy its notification background) and otherwise the toolbar's hue
darkened. Themes whose toolbar is too dark to go below (Dark, Nebula, Purpy,
Purpy Slate, GitHub Dark, Mocha, Macchiato, Tokyo Night, Ayu, Palenight) get a
lighter strip instead.

Where the strip nearly matches the canvas (contrast under 1.13), it takes the
nearest palette color instead, darker if one fits: `ControlBackgroundColor`
for Choco, Choco Navy, Purpy, Purpy Slate, Nord, Gruvbox, Night Owl and
Palenight, `NotificationBackgroundColor` for Solarized Dark and Monokai,
`EdgeColor` for Light Warm. Toolbar buttons hover and toggle against the
canvas the same way: `HotBackgroundColor` and the selection color unless they
nearly vanish on it (Purpy, Purpy Slate, Light Warm, Rose Pine Dawn, One Dark)
or coincide (Night Owl).

## Selection colors

One palette color marks every selection: toggled-on toolbar and sidebar view
buttons, the selected bookmark and list rows, and text selected on pages
(`ThemeSelectedBackgroundColor`). Of the theme's own colors (edge, hover, tab,
notification), it is the one furthest from the control background toward the
text color that keeps text on it at contrast 4.0 or more: mostly `EdgeColor`,
Everforest Light's disabled edge; Solarized Dark and Greeny, whose text is too
faint on their edge color, fall back to `HotBackgroundColor`, as do One Dark,
Night Owl and Ayu. The window background is left out: themed pages take it, so
a selection on them would vanish. Upstream shifted the background's HSL
lightness by 25 to 45 units, which made saturated themes garish (Solarized
Dark a bright teal, Greeny a bright green).

The bookmark tree keeps its unfocused selection color when it has the focus
(upstream: the system's blue highlight); high contrast mode still uses the
system highlight. Text and rectangle selections on pages take that color too,
with no outline: the overlay's color and alpha are solved so the page
background turns exactly into it. This applies while `FixedPageUI.SelectionColor`
is the default `#ffff00` and the page is on the same light/dark side as the
sidebar (otherwise, e.g. a white page under a dark theme with
`DocumentColorsFollowTheme = off`, the selection stays yellow). The current find
match and touch selection handles stay yellow.

Lists (thumbnails, annotations, find results, command palette) and the
Favorites tree draw no dotted focus outline; the selection shows where the
keys go.

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

Choco and Purpy (upstream #5194, no source palette) had pages and UI in
unrelated hues: Choco a brown page under a navy UI, Purpy a slate page under a
purple UI. Each now comes in two variants that keep every color's lightness and
take the other side's hue; text, link, hot-edge and notification highlight
colors are unchanged. Choco spreads the page's brown to the UI, Choco Navy the
UI's navy to the page; Purpy spreads the UI's purple to the page, Purpy Slate
the page's slate to the UI. The name keeps the color it names.

Themes change from the keyboard: the command palette (Ctrl+K) lists every
theme as "Set theme '…'" (upstream hides them there), and the Change Theme
dialog previews with the arrow keys, applies with Enter and cancels with Esc.
`T` / `Shift+T` (`CmdNextTheme` / `CmdPrevTheme`, new) step through the themes
in menu order, wrapping, and show the new theme's name.
`tests/ad-hoc-theme-keyboard.ts` drives all three.

`smart` is now the default (upstream: `off`); a settings file that saved `off`
keeps it. Light keeps white pages, and its canvas is white to match (upstream:
gray, as with `off`); Light Gray (new) is the gray-page variant, with gray
sidebar, tabs, toolbar and title bar too.

`tests/ad-hoc-pdfium-theme.ts` checks a dark and a light theme: no white paper,
both photos untouched, a figure's gray backdrop recolored, and `legacy` recoloring
photos; it fails on the previous build. `issue-6088` and `issue-5911`, run with
SolokPDF's settings file, pass on both engines, as does `ad-hoc-pdfium`.

`ad-hoc-pdfium-theme-switch` keeps one PDFium tab open through dark → light →
dark, then smart → legacy → off → smart. Photo and paper counts return to their
original values. PDFium's cached image rectangles describe page objects and do
not depend on theme or mode; `UpdateDocumentColors` advances the render cache's
dark-mode epoch. B6 needs no engine invalidation.

## Overlay scrollbars

Added 2026-11-01.

`Scrollbars = overlay` is the default (upstream: `windows`); a settings file
that saved `windows` keeps it.

`Scrollbars = smart` and `overlay` draw with the theme native scrollbars use
(`DarkMode_Explorer` in dark themes), so they look like `windows` ones: on
Windows 11 a thin line that widens with arrows on hover, cross-faded over the
theme's transition time with an ease-out. Both bars shown fill the corner box,
with a size grip that resizes the frame when it isn't maximized.

- `overlay` keeps room for the bars beside the page (right and bottom window
  margins grow by the bar widths), so fit width and scrolling to the edge never
  leave the page's edge under a bar, and the page doesn't move as bars come and
  go.
- `smart` has no background: the thumb (a thin line at rest, wide on hover)
  and, on hover, the arrows, over the page; no corner box. The empty track
  still takes clicks while hovered. It fades out 1.5 s after the mouse stops
  or a scroll (was 3 s and 5 s, at once) and takes no room.
- Every theme, Light and Dark included, tints the bars: `ScrollbarColor` and
  `ScrollbarThumbColor` (new theme fields), by default `ControlBackgroundColor`
  and a palette color: `EdgeColor`, or `DisabledTextColor` where `EdgeColor`'s
  contrast with the track is under 1.5 (One Dark, Night Owl, Ayu, Nord, …).
  Lists, the thumbnails included, take `ScrollbarThumbColor` too. A lightness
  shift of the track made saturated themes garish (Solarized Dark a bright
  teal, Greeny a bright green). Each pixel of the native look
  keeps its place between Windows' track and thumb colors, mapped onto the
  theme's pair. High contrast and `windows` bars keep Windows' colors.

The thumbnails' scrollbar (sidebar and command palette) is drawn the same way
(`PaintThemedBar`): as wide as a native bar, a thin line at rest that widens
with arrows on hover over the theme's transition, arrows stepping a row. It
runs along the list's right edge over its whole height, outside the padding.
The current page's frame takes the theme's `HotEdgeColor` (upstream: a fixed
blue); the other pages get a 1px frame in `ScrollbarThumbColor` (upstream:
none, so Light's white pages vanished on its white sidebar).

`tests/smart-scrollbars-autohide.ts` reads the bars off the screen and checks
an auto-hidden smart bar stays hidden.

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
