# SolokPDF limitations

Current behavior of PDFium tabs by area, compared with MuPDF. Item status is in
[backlog.md](backlog.md); measurements are in [history.md](history.md).

## Opening files

- PDFium handles file-backed PDFs, in-memory attachments, `.p7m` PDFs and Kindle
  Print Replica. The shell preview/filter DLLs and PDFs generated inside other
  document engines retain their upstream paths. Files above 4 GiB fall back.
- Password-protected PDFs open in PDFium via the password dialog, `-pwd` and
  `DefaultPasswords`; a canceled dialog isn't repeated by MuPDF. PDFium's open
  API accepts a password, not MuPDF's decryption key. When "Remember password"
  is checked, file history keeps the existing MuPDF key and a separate PDFium
  password encrypted with current-user DPAPI. The file's MD5 digest is DPAPI
  entropy, so a changed file cannot reuse it. The password is never stored as
  plain text; deleting the history entry deletes both values. Existing MuPDF
  keys still reopen in MuPDF. DPAPI is user-scoped and local to Windows, so
  copying settings to another account or machine does not carry the PDFium
  password. Encrypted PDFs no longer reach the MuPDF-only PDF tools (e.g.
  Decrypt) through the fallback. PDFium reads the effective print, copy,
  annotation and form permissions from `FPDF_GetDocPermissions` and reads the
  underlying user mask with `FPDF_GetDocUserPermissions`; security revision
  `-1` means unencrypted. The effective mask gives an owner-password opener
  full rights, matching MuPDF's `fz_has_permission`. Document Properties lists
  all four denied operations on either engine. The standard Windows build
  defines `DISABLE_DOCUMENT_RESTRICTIONS`, so both engines report denials but
  allow the operations; changing that policy would change existing MuPDF
  behavior. No MuPDF editor is loaded to read PDFium's permission flags.
  `tests/ad-hoc-pdfium-permissions.ts` compares both engines with restricted
  user and owner passwords and checks the standard build's print/form policy.
- Files of 32 MiB or more keep a handle that shares writes, as MuPDF's does:
  producers can overwrite them while open and the document reloads
  (`tests/ad-hoc-pdfium.ts` covers small and 33 MiB files). PDFium Save As
  after rename/delete reads that handle (`tests/ad-hoc-pdfium-saveas.ts`).
  Hover scans PDFium's page annotation subtypes before loading the hidden
  MuPDF editor; plain pages keep their files renameable, while annotated pages
  retain annotation hover (`tests/ad-hoc-pdfium-hover.ts`). MuPDF's large-file
  handle blocks rename/delete on Windows once its editor is loaded.
- `/OpenAction` (array and GoTo forms) sets the first-open page. PDFium has no
  API for it, so MuPDF reads it when the byte scan finds a catalog key. Release
  cost (3 runs): 0.6–1.1 ms on Attention/BERT, 5.6–5.9 ms on the 41 MB
  vector PDF and 18.8–20.4 ms on IPA, whose AES-256 (R6) key check MuPDF
  repeats.
- The catalog's `/PageLayout` and `/ViewerPreferences/Direction` apply on
  PDFium tabs (`issue-2022` failed before on PDFium: `r2l=0` for a catalog
  declaring R2L). The existing cheap MuPDF OpenAction query reads them before
  the display model is built. It does not load the hidden editor. Both engines
  pass `issue-2022`, including remembered state (B38). The page geometry byte
  scan also looks for `/OpenAction`, `/PageLayout` and `/Direction`, including
  in Flate object streams; without them PDFium skips the query. Encrypted
  object streams and files of 32 MiB or more still query.
  `ad-hoc-pdfium-catalog-layout` checks a plain catalog, a compressed one and a
  catalog without these keys, whose open logs no query (B44).
- Page labels match MuPDF in the toolbar and label lookup (fixture plus
  Attention/BERT/IPA). Labels are read eagerly at open, one call per page.

## Rendering and geometry

- View tiles use integer page extents. Tile edges came back from the
  transform with float error (5507.9995 px) and were floored, drawing about a
  third of high-zoom tiles a pixel off; they now snap within 0.05 px.
  `tests/ad-hoc-pdfium-tiles.ts` checks 45-degree hairlines across tile edges
  at five fractional zooms (res 1–4) for both engines. Page size, link/search
  positions and rendered geometry now match MuPDF for offset/intersected page
  boxes, snapped rotation and `/UserUnit` 0.5, 2 and 3.7
  (`tests/ad-hoc-pdfium-pagebox.ts`). That test also covers compressed page
  dictionaries in plain and Flate object streams. Encrypted object streams
  and files at least 32 MiB use PDFium's own geometry: unusual `/UserUnit` or
  rotation there may differ from MuPDF. Scanning those cases added 18.3 ms
  and 16.2 ms to the measured encrypted IPA and 41 MB vector load-info
  medians, respectively. The 33 MiB fixture checks this limitation.
- Opaque views use an identity gray palette when every rendered pixel is
  opaque and R=G=B; other opaque views use BGR. PDFium still renders unchanged
  BGRA.
- Normal rendering is opaque white. The transparency-grid path uses alpha;
  full transparent-page compositing parity and advanced dark-mode parity are
  not established (E4 dropped: rare documents).
- Theme colors apply to PDFium pages; see
  [Theme page colors](features.md#theme-page-colors).
- `FixedPageUI.WindowBgCol` colors the page surround on PDFium tabs as on
  MuPDF tabs (`tests/ad-hoc-pdfium-window-bg.ts`). The Change Color dialog
  already uses the fixed-page color for PDFium.
- PDFium tabs hide Engineering Drawing Enhancement. MuPDF applies a
  render-device pass to vector strokes, text and narrow fills, adjusts minimum
  line width, and darkens raster drawings; PDFium has no equivalent per-render
  control. The toggle continues to work on MuPDF tabs. `ad-hoc-pdfium-cad`
  checks both command states. `ad-hoc-pdfium-commands` compares every
  command's menu and palette state between engines on plain, outlined,
  annotated, form and encrypted PDFs; this command is the only difference.
  `issue-6361` detects raster CAD on MuPDF and fails on PDFium. Detection
  without the prohibited PDFium color processing would leave the drawing
  unchanged (B21).
- With the active settings file, `issue-3731` passes on MuPDF and fails on
  PDFium: an opt-in external image stream renders blank. PDFium exposes no
  external stream loader. Rendering the page through the MuPDF editor passes,
  but violates the PDFium render path and large-file memory/locking rules
  (B27 dropped: such PDFs are rare).

## Text, search and selection

- PDFium extracts routine page text through its own text API. Character gaps,
  loose glyph boxes, line breaks and a CP-1251 font mapping preserve spacing,
  Unicode and selection bounds. A page with unmapped glyphs, or a shown widget
  whose appearance draws text (or, lacking one, has a value), uses MuPDF text
  only when requested. Hover's text prefetch keeps PDFium's text there until a
  search, selection or copy reads the page, so hovering never loads the editor;
  until then hover shows no I-beam over read-only field text (B49,
  `ad-hoc-pdfium-form-highlight`). Plain pages leave the editor unloaded.
  `ad-hoc-pdfium-text-fallback` extracted all 95 pages of 3 corpus PDFs:
  Attention 15, BERT 16, Japanese IPA 64. `TestCurrentPdf editor` stayed
  `none` after every page (B14 check); no narrowing was needed.
- `TryGetElements` and `TryExtractPageText` skip a page whose render holds the
  PDFium lock, as MuPDF does, so link outlines, link recompute and the I-beam
  hover don't wait for a render on the UI thread (B11). They keep the lock they
  probed and never load the hidden editor: until it is loaded, elements are
  PDFium's (every link but file-attachment ones, which a blocking read adds),
  and text MuPDF must supply returns false, so search reads such a page once,
  blocking. Once loaded, the editor answers through its own non-blocking reads
  (B51, `ad-hoc-pdfium-try-reads`).
- PDFium drops its discretionary hyphen marker from extracted text, so search
  joins split words as MuPDF does. `issue-1189` and the generated B15 search
  test cover this path without loading the editor.
- PDFium keeps the space in `Protected Access` from issue #5871. Its 0.2 em
  filter rejected the condensed font's word gap; the same 0.1 em threshold
  used for MuPDF now keeps it. `issue-5871` fails before and passes after on
  PDFium (B34).
- Rotated text selects along glyph quads, as with MuPDF (`issue-4839`, which
  failed with PDFium before). PDFium reports only axis-aligned boxes, so quads
  are built from each glyph's matrix, origin, advance and the font's
  ascent/descent; on the test's 45° Helvetica they match MuPDF's width and
  direction and are 19% shorter (MuPDF uses the font bbox). Upright pages
  keep no quads, as before.

## Zoom, trim, page boxes and images

- Fit Content and Fit Visible use PDFium page-object bounds, clipped to the
  visible page. Blank pages use the page box. Zoom never loads the editor;
  `issue-6241` checks the content ratio and editor state.
- PDFium reports a 12-point text line as about 60 × 8.7 points. The trim
  guard used to discard it because its height was under 10 points; it now
  discards a box only when both dimensions are under 10 points.
  `issue-trim-margins` fails before and passes after on PDFium; MuPDF and trim
  restore also pass (B29).
- Page box overlays read explicit boxes through PDFium. An inherited box uses
  the editor only when PDFium omits a named box that the file contains.
  `issue-814` and the B20 test check direct and inherited boxes.
- PDFium enumerates image bounds for cursor hit testing and the Selected Image
  menu, cut to clip paths and the page as MuPDF's (`issue-6441`). Copy and
  Save resolve the matching image through the lazy MuPDF editor, preserving
  orientation and CMYK JPEG/TIFF data without changing PDFium rendering.
  `tests/ad-hoc-pdfium-images.ts` checks extraction and orientation;
  `tests/issue-6360.ts` checks the context menu and clipboard.

## Links, outline and navigation

- All eight destination views, link `/Contents` tooltips and GoToR/Launch file
  links match MuPDF on a fixture (links and outline). PDFium reports
  First/Last/Prev/NextPage actions only as unsupported and can't name a GoToR
  destination without loading the target, so a page with such a link reads
  them with MuPDF, like `/OpenAction`. Named links match MuPDF's targets and
  rects, including on a cropped, rotated page; a GoToR with a named `/D` opens
  the target there, as with MuPDF (an explicit page array opens at the start in
  both). Outlines containing named actions or GoToR destinations use the lazy
  MuPDF editor's TOC, including its attachment entries. PDFium reads ordinary
  outlines itself. `tests/ad-hoc-pdfium-outline.ts` compares both engines.
  PDFium reads bookmark colors and bold/italic styles through its own API;
  `issue-3560` checks the sidebar colors against MuPDF.
  GoToE remains unsupported by both engines.
- PDFium's bookmarks tree selects its top-level items. The selection walker
  used to treat the hidden root as collapsed, so the first item stayed
  unselected. `toc-selection-visible` passes on both engines (B28).
- Auto Generate TOC uses MuPDF's numbered-heading scanner for PDFium documents.
  Its text-line and hierarchy rules therefore yield the same entries and pages
  as MuPDF. PDFium opens the hidden editor only when the setting is enabled or
  the command is invoked, and skips it when the PDF has an outline. The scan
  stays on MuPDF's background thread; PDFium displays its generated tree when
  ready. This avoids a second heuristic and leaves ordinary PDF opens and
  renders unchanged. `tests/issue-5724.ts` checks exact entries and pages in
  both engines; `tests/issue-6227.ts` checks the command on demand.
- Plain-text URLs, e-mails and DOIs become links through MuPDF's shared
  linkifier, honoring `DisableAutoLinks`. PDFium uses the lazy MuPDF page
  elements for unsupported actions, other annotations and navigating push
  buttons; a form field's `/TU` tooltip comes from PDFium. Wrapped URLs join
  from PDFium's page text without loading the editor. JavaScript menus and
  button navigation still use MuPDF. `tests/ad-hoc-pdfium-links.ts` checks both
  engines. PDFium text still differs on some plain URLs (4 of 95 sampled
  pages).
- PDFium tabs create a SyncTeX synchronizer when a sidecar exists. Command-line
  and DDE forward search and inverse lookup use the same page coordinates as
  MuPDF. The synchronizer needs only page count for `.synctex` and page media
  boxes for legacy `.pdfsync`. Neither path loads the hidden editor.
  `tests/ad-hoc-pdfium-synctex.ts` compares two pages and their rectangles.
- Known external PDF viewers accept a PDFium tab as a PDF document. Their
  file-extension gate still excludes other formats. `issue-6184` fails before
  and passes after with its temporary HKCU viewer registration (B35).

## Responsiveness

- PDFium reuses its loaded bookmark tree without taking the global render lock.
  Hover annotation and link queries also skip a page while rendering holds
  that lock, as MuPDF's hover does. `issue-6362` scrolls and changes pages
  without stalling locally; Run 3 CI had seen a 4.3-second scroll block with
  its cursor over the window (B23).

## Annotations, forms, signatures and attachments

Details: [annotations.md](annotations.md), [forms.md](forms.md).

- Annotations of PDFium documents are edited, undone and saved by a hidden
  MuPDF document of the same file, which draws them over PDFium's pages once
  loaded, including redaction marks. PDFium's own incremental save, used
  before, wrote every parsed object: one annotation added up to 35 MB.
- PDFium loads the editor when an annotated page needs comment elements and
  before the first annotation journal operation. Plain-page render and hover
  leave it unloaded. The markup diagnostic now reads annotations from all
  pages. `issue-5329` passes on both engines after seeding the active settings
  file; annotation tooltips include authors when enabled (B26).
  Cursor-driven annotation checks need an unlocked Windows session.
- Applying redactions on a PDFium tab rewrites pages in the already loaded
  MuPDF editor and, as on MuPDF tabs, leaves the file unsaved and the step
  undoable. Until Save reloads the tab, PDFium draws, extracts text and lists
  elements of a page that an applied redaction step rewrote through the
  editor; undo returns the page to PDFium (B17). Print and the command
  palette's page thumbnails render a copy read from the file, so while an
  applied redaction is unsaved they render the editor's document instead, on
  both engines (B52). Which pages are redacted is derived from the undo
  journal on apply, undo, redo and save and read without the editor's lock,
  so other pages never wait for it; text extracted while a redaction changes
  a page is dropped, so search can't find redacted words, and redacted pages
  take recolor skip rects and the annotation switch from the editor (B53).
  The editor remains lazy until
  annotation work starts; ordinary PDF open and render are unchanged.
  `tests/ad-hoc-pdfium-redactions.ts` runs `redact-annotations.ts` in both
  engines; `ad-hoc-pdfium-redaction-undo` checks the black box, text, file and
  undo/redo in both, and `annot-undo-one-step`'s redaction part passes on both.
- Document-level JavaScript runs in PDFium documents through the hidden MuPDF
  editor when enabled. Neither engine supports editing XFA forms; PDFium shows
  them read-only and reports XFA in Unsupported Features, matching MuPDF's
  read-only fallback.
  Document Properties lists the ones a document uses ("Unsupported
  Features"; empty for most papers), checked by
  `tests/ad-hoc-pdfium-unsupported.ts`. PDFium documents no longer show it as
  a notification on every load. Signed PDFium documents use the hidden MuPDF
  editor for verification text and certificate details in Document Properties.
  PDFium's signature count gates that load; ordinary PDFs stay on PDFium alone.
  Sign Document and signature-field clicks use the lazy MuPDF editor to sign,
  certify and save incrementally, then reopen the result in PDFium while
  retaining the view state. Unsaved annotation and form edits share that save.
  See [forms.md](forms.md).
- Form field widgets are displayed and printed. `FPDF_ANNOT` draws every
  annotation except widgets, so form fields used to be blank; documents with
  an AcroForm now get a form handle and `FPDF_FFLDraw` after each render
  (`ad-hoc-pdfium`: 9600 widget pixels on screen and in print, as MuPDF). For
  fields without an appearance (`NeedAppearances`) PDFium builds its own, as in
  Chrome: its checkmark glyph and a combo box arrow differ from MuPDF's. Fields
  can be filled through the hidden MuPDF editor, which loads on the first
  click on a field or edit only when PDFium reports an AcroForm.
  `HighlightFormFields` and the hover cursor (I-beam or hand, by MuPDF's
  smallest-widget and read-only rules) read fields with PDFium's form API until
  then, so painting, hovering and clicking off fields do not load it
  (`tests/ad-hoc-pdfium-form-highlight.ts`,
  `tests/ad-hoc-pdfium-form-hover.ts`). Once loaded, MuPDF draws widgets
  over PDFium's page instead of PDFium's widget pass, so edited values do not
  show stale appearances. Text, choice, checkbox and radio edits use MuPDF's
  existing incremental save and undo paths. `tests/issue-6240.ts` checks
  buttons and saving; `tests/ad-hoc-pdfium-forms.ts` checks text and choice
  values, view/print rendering and saved copies in both engines. XFA remains
  unsupported; signing uses the same lazy MuPDF editor for PDFium documents.
  PDFium draws untouched widgets. The first click on a field loads the hidden
  MuPDF editor, whose widgets replace PDFium's widget pass after an edit;
  documents without forms keep the PDFium-only open and render path. Its
  existing edit, undo and incremental save paths handle text, choice and
  button fields. `EngineMupdf::FinishLoading()` enables form JavaScript in that
  editor under the same `DisableJavaScript` setting as a MuPDF document, with
  no separate PDFium script runner. A calculated value survives save and
  reopen in both engines (`tests/ad-hoc-pdfium-form-js.ts`). PDFium checks the
  document's JavaScript action count on open and loads the editor only when it
  is nonzero and JavaScript is enabled. This runs document scripts before the
  first page render; its widgets then show any initialized values. Loading on
  open avoids a second render and lets scripts affect the initial view. PDFs
  without document scripts and runs with `DisableJavaScript` keep the
  PDFium-only open path. `tests/ad-hoc-pdfium-document-js.ts` checks both
  engines, the setting, initialized widget rendering and the no-script path.
- PDFium's attachment count gates loading the hidden MuPDF editor when the TOC
  is first requested. Its attachment entries are copied after PDFium's
  bookmarks; the same editor supplies bytes to Open/Save Attachment. This
  keeps ordinary PDF opens and renders on PDFium alone and avoids PDFium's
  whole-document save. A page-link query checks PDFium annotation subtypes and
  reads FileAttachment links from that editor only when the page has one. The
  editor's quick page load avoids text extraction.
  `tests/ad-hoc-pdfium-unsupported.ts` checks the list against MuPDF;
  `tests/embedded-image-attachment.ts` opens a page attachment in both engines.
- Document Properties parses PDFium's `CreationDate` and `ModDate` as PDF
  dates, including their time zones, matching MuPDF
  (`tests/ad-hoc-pdfium-dates.ts`). Missing Info properties fall back to the
  lazy MuPDF editor when the file has Catalog XMP metadata. Info values win.
  `xmp-properties` checks both engines; a generated XMP document is in the
  quick SolokPDF CI checks.

## PDF tools

- PDF tools accept a PDFium tab. The viewer stays in PDFium while MuPDF's
  existing file tools perform bake, compression, page extraction/deletion,
  encryption/decryption, merge, text extraction and scripts on demand. Merge
  uses the lazy MuPDF editor only for an encrypted tab's password or unsaved
  annotations; bake and extract likewise copy unsaved annotations. File tools
  open or reload their output through the normal PDFium path. View rotation
  already works in both engines; it does not rewrite page rotation in the
  file. `tests/ad-hoc-pdfium-tools.ts`, `merge-struct-parents.ts`,
  `tool-merge.ts` and `pdf-script.ts` cover these paths.

## Printing

- Print **bitmap generation** passed. PDFium tabs read `/ViewerPreferences`
  print defaults through an on-demand MuPDF query, without loading the editor
  (`tests/ad-hoc-pdfium-print-prefs.ts` checks all four values on both
  engines). After Apply Redactions and before Save, print renders the
  redacted document from the editor, not the file (B52,
  `ad-hoc-pdfium-redaction-undo`). Physical printers, print dialogs, spooler
  behavior and export
  workflows were not comprehensively tested (F1 needs the owner).

## Sessions, memory and robustness

- Two-document Tab Groups and normal-session paths persisted across restart.
  `tests/ad-hoc-pdfium-view-state.ts` restores page, zoom and scroll from the
  session and from file history; both engines save identical values (scroll
  within 0.2 pt of the seed). Crash recovery and inactive-tab allocation
  attribution remain unverified.
  `ad-hoc-pdfium-leak` cycles two PDF tabs through open, scroll, zoom, search,
  tab switch and close. A 2-minute local run completed 147 cycles and 12 idle
  samples: Private Bytes 113.1–126.7 MiB (last 115.7), handles 686→680,
  GDI 225–226. The sustained-trend thresholds passed. `--minutes=N` extends
  the duration; hours-long runtime has not been measured (E2).
- `tests/ad-hoc-pdfium-fuzz.ts` mutates a seed covering every link action,
  outline view, named destinations, page labels, boxes/rotation and rotated
  text (plus corpus PDFs when present) at byte and token level (extreme
  numbers, swapped keywords, dangling/cyclic references), then renders each
  input and reads its links, outline and text in one Debug app, flagging a
  crash or a 20 s hang. 1,150 inputs (seeds 1 and 2) found none; most still
  reached rendering, links and the outline. Debug only: no ASan build of
  PDFium or the app, so silent memory errors aren't caught (E3 dropped:
  prebuilt PDFium isn't ASan). Chrome/Edge comparisons remain. A passing close
  stress check is not an exhaustive proof against races.

## Tests and CI

- Run 3 failed `toolbar-hover-dropdown` and `issue-6113` on both engines.
  Locally, toolbar clicks report the real cursor moving to `(0,0)`, and the
  RTL notification capture hangs on the locked desktop. Neither test can
  establish an app regression in this session; B37 is blocked until an
  interactive desktop can run the targeted tests.
- `shape-annotation-placement` failed three of three local MuPDF reruns: the
  first page click did not anchor the rectangle. This locked desktop pins the
  cursor at `(0,0)` during drag tests, so B39 needs an interactive rerun
  before an app change can be judged.
- `issue-5918` passed PDFium and failed MuPDF in Run 3. Three local MuPDF
  reruns failed at next-file navigation, and one local PDFium run failed there
  too. The folder scan completes, but the title remains `page-0000.html`.
  B40 is blocked until the shared navigation failure is isolated; the evidence
  does not support a MuPDF-only fix.
- The clipboard unit-test failure seen on the unchanged baseline came from
  this host: right after `GetClipboardData` the clipboard was no longer open
  (`ERROR_CLIPBOARD_NOT_OPEN`, no formats). ESET's `ebehmoni.dll` and ATOK's
  TIP are injected into the process; which one closes it is unconfirmed. The
  test now opens the clipboard per read and retries, and
  `GetClipboardImageAsPixmap` retries while `CF_BITMAP` is still listed. The
  unit suite then passed 11 runs in a row (before, most runs failed). No tests
  were removed or disabled.
- GitHub Actions CI builds SolokPDF debug on pushes and PRs to `solokpdf-dev`.
  It runs unit tests and selected PDFium, Vim, count-prefix, and update-check
  tests. Pushes and manual runs also build the release ZIP in parallel with
  debug (D1); the ZIP is kept as an Actions artifact for 14 days. No upload
  secrets are used.
- The full-suite workflow runs weekly on Monday at 02:00 JST with separate
  PDFium and MuPDF jobs; manual runs still accept an engine and test filter
  (D4). `run-github-ci.ts` skips the by-design PDFium gaps (`issue-5937`,
  `issue-6361`, `issue-3731`; unless `SOLOKPDF_ENGINE=mupdf`) and the
  hosted-desktop cursor/capture tests (`toolbar-hover-dropdown`,
  `issue-6113`), so a red weekly run means a regression (B50). The suite takes
  ~25 min once a hung test is cut off by the per-test timeout; sharding is
  deferred (D3). Triage: [full-suite-triage.md](full-suite-triage.md).
