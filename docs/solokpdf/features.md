# SolokPDF features

Behavior SolokPDF adds to or changes from SumatraPDF. PDF engine behavior is in
[limitations.md](limitations.md).

## Windows menus

The menu bar is File, View, Go To, Favorites, Tools, Settings and Help.
Debug and prerelease builds also show Debug.

- File starts with **Open…**, which opens the default picker. Change the default
  under Settings. File groups other ways to open a document, external viewers
  and email, and file management. Recent documents remain above Exit.
- View puts page layouts, fit width, fit page, rotation and fullscreen at the
  top level. Other magnifications are under Zoom. Page Display contains reading
  and page options, and Window Layout contains sidebar and toolbar controls.
- Tools starts with Command Palette. It also contains Selection, Read Aloud,
  PDF Operations, Measurement and document AI chat. The palette offers hex
  view and either file picker for one-time use.
- Right-click selected text for Copy and Highlight, a web link for Copy Link
  Address, or an image for Copy Image and Save Image. Page favorites, annotations
  and cursor-based reading stay on the page menu. A selection takes priority
  when the clicked point is also on a link or image.
- Right-click a tab to close, duplicate or locate it. Close Multiple Tabs
  groups the bulk actions. The bookmarks menu starts with chapter or embedded
  file actions when available. On Home, Remove From History and Delete File are
  separate actions.

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
- The default-app association works through `Applications\SolokPDF.exe`;
  installer behavior remains unvalidated.
- Copyright/license files remain unchanged. The package includes root notices,
  vendored license files and all PDFium `licenses/` texts plus the pin manifest.
  MuPDF and its AGPL obligations remain because the fallback/library remain.
- No binary, downloaded PDF, build cache, PDB or archive is added to Git.

## Upstream additions (D14)

The 2026-11-15 merge adds Save Trimmed Pages As, View As Hex, Custom AI chat
with an API endpoint, and Close Tabs of Missing Files. `KeepMissingSessionTabs`
controls missing session placeholders. The new views use the existing theme
colors; Settings stays on Ctrl+, with the single settings screen.

Per-build crash/log directories use the PE build ID under SolokPDF-data.
PDFium remains the default engine; ordinary text, rendering and thumbnails
keep using PDFium. See [PDF tools](limitations.md#pdf-tools) for exports.

## Network comics

Network RAR comics and CBX files above the memory limit use local copies keyed
by source path, size and write time. File information bypasses the network
attribute cache. Unchanged versions reuse a complete copy; a newer version
keeps a separate path so existing engines and Clones retain their input.

Copies remain private until copying finishes and source metadata is rechecked.
Metadata, copy or publication failures fall back to the source path. Changes
that preserve both size and write time are not detected. See the
[E30 results](history.md#e30-network-comic-cache-2026-11-10).

## Theme-colored icon

The app icon is SumatraPDF's (badge, band, "PDF") traced to vector paths in
`src/solokpdf/AppIcon.svg`: badge and band are a few cubics fitted to the
original outline, the letters rounded rects fitted to its text. Windows draw it
with GDI+ at each size in the document text color (`TextColor`), which the
theme already keeps readable on its title bar: band and badge as one shape, cut
by a 6-unit gap along the badge's upper-left edge (at least 1 px) and by "PDF",
so the title bar shows through both. The gap runs past the outline at both ends
and the cuts are multiplied out of the shape's coverage, so its ends are clean
cuts with no hairlines. Title bar, taskbar, Alt+Tab, About and dialogs follow;
windows update on a theme change, open dialogs keep their icon. The big icon
(taskbar, Alt+Tab) sits on the taskbar, not the title bar, so it takes the
text color only where that shows there by contrast 3; else the canvas color,
else one pushed toward white or black. The taskbar's color comes from Windows'
personalization settings (light, dark, or the accent shade) and is re-read
when they change.

The exe's icon (Explorer, Start, shortcuts) can't follow the theme; it is the
same drawing in One Dark's text color. `tools/solokpdf/make-icon.py` generates it
(`src/solokpdf/SolokPDF.ico`) and the path data (`AppIconPaths.h`) from the SVG.

## Chrome-style tabs

Ctrl+T opens a new Home tab like the "+" button, including when Home search has
focus. Ctrl+Shift+T still reopens the last closed file; plain T changes theme.

Home from "+", Ctrl+T or the Home command leaves the focus on its file list
(upstream focused the search box, which hid the selection outline).
Plain keys on Home run their shortcuts, such as T for the next theme. A search
starts by clicking the box, Ctrl+F, or `/` with Vim keys on (E90).

`NoHomeTab` defaults to true: opening a file leaves no pinned Home tab behind.
Home from "+" or the Home command is replaced when a file opens from it. Set
`NoHomeTab = false` to keep the pinned Home tab.

Upstream drew the selected tab and the empty tab strip in the toolbar's color
and only unselected tabs as boxes, so the unselected ones stood out. As in
Chrome, the title bar, tab strip, caption buttons and window border now take
`InactiveTabBackgroundColor` (`ThemeTabStripColor`); unselected tabs merge into
it (a hovered one shows a faint box). The selected tab and the toolbar take
the canvas color around the pages, which themed pages share (upstream:
`ControlBackgroundColor`), so with the toolbar hidden the tab joins the
document. `ActiveTabBackgroundColor` now defaults to it; the built-in themes no
longer set it. Greeny's and Light Warm's `InactiveTabBackgroundColor` now sit
1.3 to 1.4 from the canvas, as the other themes' do (were 2.55 and 1.72). Every tab shows its close
button (upstream: the selected one only); non-selected tabs narrower than 100
DIP hide it, and the pinned Home tab has none. Hovered, the ✕ steps toward
the text color instead of turning
white on a red circle. Minimize, maximize and close are 46 DIP wide, as Windows
11 draws them (upstream: square, as tall as the caption). A hovered or pressed close
button's red reaches the window's top and outer edges, as in Windows 11
(upstream stopped 1–2 px short); those border pixels still resize.

The menu bar beside the tabs takes the title bar color and `TextColor`; a
hovered or open menu shows the selected tab's color. Upstream let darkmodelib
draw it as a box in `ControlBackgroundColor` with `DarkerTextColor`.

The sidebar, splitters included, takes the canvas color, as the toolbar does
(`ThemeSidebarColor`); its search fields take `ControlBackgroundColor`, and they and
the Bookmarks and Favorites trees a 6×4 DIP margin (upstream: flush with the
panel's edges). A hovered bookmark or favorite fills its row with the hover
color below (upstream: the Explorer theme's own hot face). The Signatures and
Layers lists take the canvas color too (upstream: `ControlBackgroundColor`).

The filter fields of Advanced Settings, Keyboard Shortcuts, Zoom and the
command palette have the sidebar search field's `EdgeColor` border and text
margins (upstream: borderless). In the default Light theme the find bar's
and Find window's box stays native white, as its ring and drop-down button
are, also after a theme switch.

The Windows bookmark tree uses the virtual sidebar control and follows the
document's `Scrollbars` setting. Long titles scroll horizontally;
page numbers, title wrapping, and search-match text highlighting are not shown.
`ShowTocPageNumbers` and `TocWrapText` do not affect the Windows tree.

A hovered toolbar or sidebar button is filled halfway from its surface to the
selection color (`ThemeHoverColorOn`), so hover and toggled-on read as two
steps of one color; a toggled-on button keeps the selection color under the
mouse (upstream: it took the hover color).

Toolbar buttons light up in a rounded box 2 DIP inside their neighbors and 4
DIP inside the bar's top and bottom (upstream: the full button, edge to edge).

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
`EdgeColor` for Light Warm.

## Virtual sidebar trees

Bookmarks and favorites use virtual trees by default in Debug and Release
since `3412a2174` (2026-11-09). The former opt-in switches have been removed.
Normal launches and `-for-testing` use the same control.

The virtual trees use the existing `TreeModel` and support `Scrollbars` modes
`windows`, `overlay`, `smart` and `hidden`, horizontal scrolling, filtering,
keyboard navigation, UI Automation and MSAA. Titles remain single-line without
fixed page numbers or search-match highlighting. The scroll area reaches the
document area's bottom, with 4 DIP padding below the last row.
`TocHighlightAllMatches = false` highlights only the current bookmark, as in 3.6
(upstream: every bookmark on the current page and its parents, always).
Always-visible overlay bars reserve room in the tree's viewport so a revealed
row or title stays clear of the bars.
Rows are measured when first shown, so collapsed branches of a large outline
cost nothing until expanded.
Expanders are Segoe Fluent Icons chevrons (Segoe MDL2 Assets on Windows 10):
`>` collapsed (`<` in RTL), `v` expanded, sized like upstream's Explorer
TreeView glyphs and centered in the expander cell (upstream's sit about 2 px
right of and below its center). They follow theme colors: the row's text
color, softened at rest and full on the hovered row (upstream: OS theme
glyphs in fixed grays). Without either font, Marlett triangles stand in.

See the [rollout results](history.md#virtual-sidebar-rollout-2026-11-09) and
[F2 acceptance record](history.md#virtual-sidebar-acceptance-2026-11-09).
Use the [test setup](testing.md#virtual-sidebar-trees) and
[physical check procedure](testing.md#physical-tree-checks) for rechecks.

## Selection colors

Home list rows, Home thumbnails and F12 page thumbnails show a selection as
in Windows 11 and macOS: the selection color (`ThemeSelectionBg`, from
`SelectionBackgroundColor` when the theme sets it) behind the entry, and a
2-DIP rounded outline in that color's own hue, mixed toward the text color
until it stands out from the surface by 3:1 (`ThemeSelectionEdgeOn`, WCAG
1.4.11; the fill alone is 1.35). The fill takes the hover fill's shape: the
row in the list, the cell and caption in Home thumbnails, the gap between the
page and its outline in F12; it never tints a page image. The selected entry's
text takes `SelectionTextColor`, as in the bookmarks. High contrast mode uses
the system highlight. Upstream drew a fixed blue outline on Home list rows, a
text-color ring on Home thumbnails and a 3-px blue frame on the current F12
page; E89 kept the text-color ring, but a 2-DIP ring in the text color is the
Fluent keyboard focus visual, too harsh as a lasting selection mark (E94).

On Home the selection marks the entry chosen by a click, the arrow keys or the
filter; hovering no longer moves it (upstream did, so the mouse took the
selection from the keys). A hovered Home entry gets a fill of its own, as in
Explorer: the hover step on Home's background (`ThemeHoverColorOn`, half the
selection step). Selected and hovered, it keeps the selection look, as the
bookmarks do: hover adds no third shade. The selection hides while the search
box has the focus (as upstream; Enter there opens nothing); the hover fill
stays. A thumbnail's tooltip follows whichever moved last, the mouse or the
keys (E93). F12 page thumbnails, which upstream gives no hover feedback, get
the selection outline at half strength, with no fill: the same 2-DIP ring, in
its hue, mixed from the sidebar until it stands out by the square root of the
outline's ratio (`ThemeHoverEdgeOn`, about 1.75:1 against 3:1; E95). E92's
hover fill there, 1.13:1 in a 4-DIP band, was hard to see. The current page
keeps its selection look when hovered, and leaving the sidebar clears it
(E92). Page thumbnails keep their thin frame; the selection outline sits
four DPI-scaled pixels outside the page. The sidebar reserves room for the
outline at its edges and between rows. Neither Home nor the sidebar has a
separate keyboard focus ring.

The command palette and the floating selection toolbar are the topmost layer,
so they take a raised surface (`ThemeRaisedColor`), lighter than the canvas
as Fluent's flyouts (#2c2c2c over #202020 dark, #f9f9f9 over #f3f3f3 light).
A theme's `ControlBackgroundColor` wins; otherwise the canvas is mixed toward
white until it stands out by Fluent's own step, 1.17 in dark themes and 1.05
in light ones, as long as the text keeps 4.5:1 on it: Solarized Dark (1.05)
and Greeny (1.03) stop there. Muted text keeps its minimum contrast on both
the canvas and the raised surface. Dialogs and other controls keep
`ControlBackgroundColor`'s canvas fallback. On the page, the toolbar has an
`EdgeColor` border and a drop shadow; those, not the card's color, set it
apart from images (E91). The shadow is Fluent 2's shadow8 (0 0 2px and
0 4px 8px), black at 12/14% and twice that in dark themes, as Fluent's; a
flyout's larger shadow would shade the line the toolbar sits 6 DIP from.
Shadows are not chrome, so it is not a theme color. It is painted on the
canvas under the toolbar and goes with it. On a black page (Dark) it cannot
show; the border alone separates there. High contrast mode has no shadow, as
Windows. Upstream's toolbar has none; E89 gave it the tab strip's color, the
receding window-frame layer.
The annotation editing toolbar takes the same colors and shadow. The read-aloud and
auto-scroll bars keep the notification color but outline their buttons and
draw their slider track in `EdgeColor` (was a fixed gray).

A selection uses `SelectionBackgroundColor` and `SelectionTextColor` from the
current theme in bookmarks, favorites, dialog lists, Markdown pages and selected
toolbar and sidebar buttons. If unset, the background is derived from its surface
to contrast 1.35 with it, and the text
is adjusted to contrast 4.5 with that background. Explicit colors are respected.
Windows high contrast mode uses its system selection colors. Native edit controls,
HTML, CHM and the manual use their own selection colors.

The fallback selection background stands out equally in every theme, in the
surface's own hue. Upstream shifted the background's HSL lightness by 25 to 45
units, which made saturated themes garish (Solarized Dark a bright teal, Greeny
a bright green); picking a palette color instead mostly picked `EdgeColor`, a
line color, too strong and sometimes off-hue (Solarized Light's gray-blue).

Every list and button that marks a selection or a hover takes these two steps
on its own background, where each used to shift the lightness by its own amount
(14 to 45 units): the command palette, the find results, the files-in-folder and
annotation lists, Advanced Settings and the other dialogs' lists, the Merge
grid, the Home page's view buttons, the minimize and maximize buttons, the
sidebar splitters and dialog buttons (resting at the hover step, the default
one at the selection). Slider tracks and the Home list's separators take
`EdgeColor`. Context menus aren't ours to color: Windows draws them.

The built-in themes' `EdgeColor` (borders, dividers, scrollbar thumbs) stands
out from the canvas by contrast 1.7 to 2 and from fields by 1.3 or more.
Dracula, Monokai, Solarized Dark and Gruvbox had theirs over 2.2; Night Owl,
One Dark, Ayu, Rose Pine Dawn and Light Warm under 1.35, so field borders all
but vanished, and Dark from 3.5, Light Gray, Greeny, Purpy, Purpy Slate, GitHub
Dark, Palenight, Gruvbox Light and Sepia under 1.6; Solarized Light, Everforest
Light and Dark had a cool gray on a warm or neutral background.

The bookmark tree uses the theme pair when focused; high contrast uses the
system pair. Document selection uses a translucent overlay without changing
the text. `TextSelectionColor`, `SearchMatchColor`, and
`CurrentSearchMatchColor` set overlay colors in the current theme. Use
`#aarrggbb` to set opacity; `#rrggbb` uses the default opacity. Search is
painted first, so overlapping selection and search colors blend. Forward
search and link destinations retain their separate highlight setting.
Lists (thumbnails, annotations, find results, command palette) and the
Favorites tree draw no dotted focus outline; the selection shows where the
keys go.

## Theme page colors

Added 2026-10-27.

Home and the area around PDF pages use the theme's `BackgroundColor`. With
`DocumentColorsFollowTheme = off`, pages retain document colors. With `smart`,
pages use theme text and background colors while embedded images retain their
colors. With `legacy`, images are recolored too. Shift+I swaps page colors for
the current session.

PDFium and MuPDF recolor text, paths and gradients while keeping image colors,
including where text overlaps images. PDFium uses a temporary per-page snapshot
for this; see [limitations](limitations.md) for its fallback. Home and page
thumbnails use cached image bounding rectangles during recoloring.

A stencil mask (`/ImageMask`, e.g. the rules dvips and Ghostscript write) paints
its fill color like a path, so it takes theme colors and is not an image element.
Both engines apply this one rule (`IsPdfPicture`, B76).

Pages with uncolored pattern strokes, or colored Type 3 glyphs under a fill
alpha below 1, use MuPDF in every color mode, so `off` also retains their
original colors and transparency. Renderer selection is cached independently
of theme colors and zoom.

F12 page thumbnails use the same page colors as the view. Home saves neutral PNGs
with a versioned sidecar containing the engine class and image rectangles. Both
recolor cached bitmaps, so text or transparent areas inside an image rectangle
can retain their original colors. Changing the theme or
`DocumentColorsFollowTheme` refreshes the cached renders. Old PNGs color without
image exclusions until that file is next opened. Covers and image files keep
their pixels.

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
in menu order, wrapping, and show the new theme's name. Zoom and theme
notifications can appear together. Esc dismisses one visible notification in
the current window after handling open tools such as Find. Persistent warnings, page
information and cursor position take priority over zoom and theme feedback.
`tests/ad-hoc-theme-keyboard.ts` drives all three.

`smart` is now the default (upstream: `off`); a settings file that saved `off`
keeps it. Light keeps white pages, and its canvas is white to match (upstream:
gray, as with `off`); Light Gray (new) is the gray-page variant, with gray
sidebar, tabs, toolbar and title bar too.

`tests/ad-hoc-pdfium-theme.ts` checks a dark and a light theme: no white paper,
both photos untouched, a figure's gray backdrop recolored, and `legacy` recoloring
photos; it fails on the previous build. `ad-hoc-theme-stencil-mask` checks black
stencil-mask rules take the theme text color in the view and on Home, on both engines.

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
  `ScrollbarThumbColor` (new theme fields), by default the canvas color
  and a palette color: `EdgeColor`, or `DisabledTextColor` where `EdgeColor`'s
  contrast with the track is under 1.5 (custom themes only).
  Lists, the thumbnails included, take `ScrollbarThumbColor` too. A lightness
  shift of the track made saturated themes garish (Solarized Dark a bright
  teal, Greeny a bright green). Each pixel of the native look
  keeps its place between Windows' track and thumb colors, mapped onto the
  theme's pair. High contrast and `windows` bars keep Windows' colors.

The thumbnails' scrollbar (sidebar and command palette) is drawn the same way
(`PaintThemedBar`): as wide as a native bar, a thin line at rest that widens
with arrows on hover over the theme's transition, arrows stepping a row. It
runs along the list's right edge over its whole height, outside the padding.
The current page's frame is 3 px of `ScrollbarThumbColor` (upstream: a fixed
blue); the other pages get a 1px frame in it (upstream: none, so Light's white
pages vanished on its white sidebar).

`tests/smart-scrollbars-autohide.ts` reads the bars from a capture of the
canvas and checks an auto-hidden smart bar stays hidden.

The bars are layered child windows of the canvas or sidebar tree they scroll
(upstream: popups over the frame), so they hide, move and clip with it (E97).
Windows the frame floats over the canvas, such as the auto-hiding sidebar,
cover the canvas's bars instead of the bars covering them.

## Popups over a window

Popups that belong to a window inside the frame (the toolbar's hover
drop-down, Home's About hover, the canvas tip, the citation hover and the
Edit PDF hover card) move with it when the frame or the window moves, and go
when it hides or the canvas shows another tab or document (upstream: they
stay at their screen place). A tip shown at the
cursor goes when the cursor leaves the canvas. The overlay toolbar stays up
while the cursor is in its drop-down (E98–E100).

The find bar, the selection toolbar, the annotation toolbar, the comment card
and the read-aloud and Automatically Scroll bars are placed from what the
canvas shows. They are placed again whenever the canvas moves or resizes,
not only when the frame moves. The ones about the document go with its tab.
The compact find bar also follows the toolbar's search button when the toolbar
moves on its own. It uses the frame for placement while the toolbar is hidden.
Opening the next or previous file in the same tab dismisses the find UI.
The annotation toolbar keeps the original markup click position when the
selection scrolls out of view or its tab is switched away and back (E125).
The annotation toolbar no longer shows over the desktop while the window is
minimized (E110). These popups and the ones above hide with the minimized
frame and come back where they were when it is restored, also one shown while
it was minimized (E121). Home's keyboard tooltip returns for the same selection
while the frame is active (E126). One hidden meanwhile stays
hidden, e.g. the selection toolbar after the selection was cleared; Esc on
the minimized window closes the find bar (E138). The comment
card and the annotation toolbar's contents edit come back open, with their
text and the focus: losing the focus to the minimize is not a click away
(E136, E137); the focus going to another window meanwhile is: the card
closes and the edit commits (E139), and the focus stays in that window, as
after a click there without a minimize. With another app active, the restore
doesn't take the focus: the popup gets it back when the window is activated
(E142). Hovers (the
toolbar drop-down, About hover, citation hover and Edit PDF hover card) go with
the minimize, as they do when another window activates (E124). The floating
find window, the annotation list and the window's other popups that don't sit
next to a control follow the same rules: back where they were, with their focus,
unless closed meanwhile (Esc closes the find window while minimized) (E140).
So do the keyboard help, Merge PDF and the PDF tool dialogs, and the AI chat
splitter's drag bar; Document Properties, which the window doesn't own, stays
on screen. A message box or file dialog taking the focus meanwhile is like
another app: the popup keeps its state and gets the focus back once the window
is active again (E143). What the app does on its own, later or as an edit ends, moves the
focus only from its own window: closing the search bar while another app or
window has the focus leaves it there, and a click on another window that ends the
free text box or an Advanced Settings value keeps the focus there (E144).
The same holds for Advanced Settings' drop-down closing, a Change Theme preview,
a tab shown or a CHM / Markdown page navigating for the app, and the command
palette or Navigate Files closing. A contents or Advanced Settings value edit
whose focus another app took gets it back once its window (the dialog, for
Advanced Settings) is active again, as after a minimize (E146).

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

Reading-bar adjustments, annotation-placement completion and keyboard-caret
navigation discard a pending count (E13).

## Find history

Alt+Down opens the search field's history; Alt+Up closes it in both the compact
bar and floating find window. The keys stay with the search field.

## Form text and search

Form edits and Undo/Redo refresh text, search matches, counts, snippets and
selection coordinates in both engines, including JavaScript changes on other
pages. See [forms.md](forms.md#text-and-search-after-edits).

## Settings

Settings > Settings and Ctrl+, open one screen. Commonly used settings appear
first with translated labels; the filter also finds their raw setting names.
Layout, zoom, and inverse search retain their choices. Advanced Settings
shortcuts open the same screen.

The palette and settings screen apply changes from memory, including derived
fonts, colors and shortcuts. Saving remains separate: `-for-testing` applies
changes for the current process without updating the settings file (E11).
Normal runs save changes; external file edits still reload settings.

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

| Keys                             | Action                                                       |
| -------------------------------- | ------------------------------------------------------------ |
| `gg`, `G`, `{n}gg`, `{n}G`       | First, last, or numbered page                                |
| `/`, `n`, `N`                    | Find box, next match, previous match                         |
| `Ctrl+O`, `Ctrl+I`               | Navigation back, forward                                     |
| `f`                              | Label visible links; type a label to follow, Esc to cancel   |
| `m{a-z}`, `'{a-z}`, `` `{a-z} `` | Set or jump to a document mark                               |
| `''`                             | Return to the position before the last jump                  |
| `Ctrl+D/U`, `Ctrl+F/B`           | Half-page or full-page down/up; counts apply                 |
| `Ctrl+E/Y`                       | One wheel line down/up (`KeyScrollLineAmount`); counts apply |
| `zz`, `zt`, `zb`                 | Center current page, align its top or bottom                 |
| `yy`, `{n}yy`                    | Copy current page text, or text from `n` pages               |
| `gt`, `gT`, `{n}gt`              | Next, previous, or numbered tab                              |
| `:`                              | Bottom command line                                          |

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
Vim matches the character produced by `ToUnicodeEx`, including `/`, `'`,
`` ` ``, and `:` on JIS keyboards; the JIS regression test covers these keys.
Ng has the setting and command ids but still needs GPUI input, hints, marks,
and command-line UI.
