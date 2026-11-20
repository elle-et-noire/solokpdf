# PDFium annotations

PDFium draws the pages. A hidden MuPDF engine for the same file edits annotations
and uses MuPDF's journal for Undo/Redo.

## Why not PDFium's annotation API

Early editing prototypes used PDFium's annotation API (commits 680bf3c31 and
853a1f3f6). Saving and annotation creation exposed two limits.

- `FPDF_SaveAsCopy` with `FPDF_INCREMENTAL` writes every object PDFium has
  parsed, not just the changed ones. Saving one annotation added 1.8 MB to a
  2.2 MB paper, 2.3 MB to a 2.6 MB one and 35 MB to a 41 MB one. Undo
  snapshots built on it cost 0.8 s per step on the 41 MB file.
- The API can't write arrays, numbers or names into an annotation: line end
  points (`/L`), vertices, line endings, `/BS` widths, FreeText alignment and
  note icons. FreeText, Line, Polygon and Stamp also need appearance streams
  we would have to build, fonts included.

## Design

```
UI ──► EngineMupdf* annotation entry points ──► AnnotEngineMupdf(engine)
                                                   │
          EnginePdfium::AnnotationEditor() ◄───────┘ (EnginePdfium)
                   │ loads on first use
                   ▼
          hidden EngineMupdf: annotations, undo journal, save
                   │ EngineMupdfDrawAnnotations()
                   ▼
EnginePdfium::RenderPage: PDFium draws the page and form fields, then
MuPDF draws the annotations into the same pixels
```

- `EngineBase::HasAnnotationEditor()` / `AnnotationEditor(EditorLoad)`:
  EnginePdfium has one. `AnnotEngineMupdf()` resolves the engine that holds a
  document's annotations, so the EngineMupdf\* annotation entry points and the
  UI work unchanged. The Annotation objects are the editor's.
- The editor loads when editing or when a query needs MuPDF. PDFium can
  answer some hover queries and skip annotation lists for PDFs without markup.
  Until the editor loads, PDFium draws the annotations. Each tile takes its
  annotation layer from one engine. [Annotation list checks](history.md#e68-annotation-lists-without-the-editor-2026-11-16)
- The overlay matrix is PDFium's page-to-tile mapping, built from
  `EngineBase::Transform`. The annotations of a normal, a `/Rotate 90` and a
  cropped page landed within 1 px of MuPDF's own rendering, also with the
  view rotated.
- Undo is MuPDF's journal, copy/paste the shared clipboard code, saving
  `EngineMupdfSaveUpdated` on the editor: an incremental update of 0.7–1.6 KB
  for one annotation on the corpus files. The app then reloads the document.
- Rendering doesn't serialize the editor: MuPDF's writer marks changes as saved
  and adds a journal step, so it can't run per edit.
- PDFium draws form fields with `FPDF_FFLDraw` until the editor loads. Then
  MuPDF draws and edits the widgets, without a duplicate PDFium pass.
- FileAttachment icons use the editor's link only when PDFium finds that
  subtype on the queried page. The editor loads that page without extracting
  text, so ordinary pages keep PDFium's link path.

## Limits

- Redaction marks use the same lazy MuPDF editor as other annotations.
  Applying them rewrites the editor's pages; the change remains unsaved and
  undoable until Save (B17). Print uses the editor's redacted pages before Save.
- Page space is assumed equal in both engines; pages with `/UserUnit` aren't
  checked.
- A clone reads saved annotations from the retained original input. Printing is the B52
  exception: after Apply Redactions and before Save, it uses the editor's
  redacted document.

## Tests

`tests/ad-hoc-pdfium-annots.ts`, each part saved incrementally and read back by
MuPDF:

- an existing highlight is listed; a keyboard selection becomes a drawn
  highlight;
- a note, square, circle and drawn ink are created and drawn; the square is
  moved and resized, the ink moved;
- a create and a move are undone and redone; a square is copied, cut and
  pasted, and the cut-and-paste undone and redone as one step;
- a Japanese free text, line, polygon, polyline, stamp and caret are created
  and drawn.

`tests/issue-6240.ts` toggles radio buttons and checkboxes and reopens the
saved copy. `tests/ad-hoc-pdfium-forms.ts` edits text and choice values, checks
view/print pixels, and reopens the saved copy in both engines.

Mouse input is window messages. Upstream tests passing with PDFium:
`palette-delete-annotation`, `command-palette-annotations`,
`ink-annotation-bounds`, `create-annot-enters-edit-mode`, the free text part of
`annot-undo-one-step`, `annot-filter-close-tab`, `annot-filter-close-window`,
`annot-filter-syntax`, `annot-text-popup-reload`, `file-link-no-dest`,
`ad-hoc-paste-image-annot`, `ad-hoc-annot-edit-race`.

Earlier locked-desktop runs dropped injected mouse input in the tests below;
the included tests passed in hosted CI run
41349548951: `annot-undo-redo`, `annot-copy-paste`,
`annot-cut-paste`, `annot-filter-toolbar`, `annot-list-placement`,
`annot-color-dropdown`, `annot-contents-click-away`, `annot-nudge`,
`annot-moveable-types`, `ink-thickness`, `stamp-edit-toolbar-name`, and the
shape, ink, line, polyline, text, free text, stamp and caret placement tests.
Later cursor and DPI changes removed the general cursor-input constraint;
current local runs use the [hidden-desktop procedure](testing.md#local-windows-runs).
Foreground popups still have [desktop constraints](testing.md#desktop-dependent-checks).
`tests/ad-hoc-pdfium-redactions.ts` runs `redact-annotations` with both engines.
