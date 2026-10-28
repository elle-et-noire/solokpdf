# PDFium annotations

PDFium documents used to have no annotation support: `EngineSupportsAnnotations`
was true only for EngineMupdf, whose model wraps `pdf_annot` and relies on
MuPDF's journal for undo. PDFium documents now edit their annotations through a
hidden EngineMupdf of the same file; PDFium still draws the pages.

## Why not PDFium's annotation API

Stages 1–2 ported editing to PDFium's annotation API (commits 680bf3c31,
853a1f3f6). Two limits ended that:

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
- The editor loads on the first annotation query: a hover, the annotation
  list, edit mode, a create. 38–98 ms in a Debug build on the corpus papers.
  Until then PDFium draws the annotations (`FPDF_ANNOT`), so viewing only
  costs nothing. A tile reads the editor once, so it never gets annotations
  from both engines.
- The overlay matrix is PDFium's page-to-tile mapping, built from
  `EngineBase::Transform`. The annotations of a normal, a `/Rotate 90` and a
  cropped page landed within 1 px of MuPDF's own rendering, also with the
  view rotated.
- Undo is MuPDF's journal, copy/paste the shared clipboard code, saving
  `EngineMupdfSaveUpdated` on the editor: an incremental update of 0.7–1.6 KB
  for one annotation on the corpus files. The app then reloads the document.
- Rendering doesn't serialize the editor: MuPDF's writer marks changes as saved
  and adds a journal step, so it can't run per edit.
- Form fields stay PDFium's (`FPDF_FFLDraw`); their widgets in the editor are
  never used.
- FileAttachment icons use the editor's link only when PDFium finds that
  subtype on the queried page. The editor loads that page without extracting
  text, so ordinary pages keep PDFium's link path.

## Limits

- Redaction is MuPDF-only: applying it rewrites page content, which PDFium
  draws from the file. Its commands are hidden for PDFium documents.
- Page space is assumed equal in both engines; pages with `/UserUnit` aren't
  checked.
- A clone (printing, thumbnails) reloads the file, so it shows the saved
  annotations, as an EngineMupdf clone does.

## Stages

1. Done: text markup, contents, color, opacity, delete, save.
2. Done: notes, Square, Circle, Ink, moving and resizing, ink erasing.
3. Done: undo/redo, copy, cut and paste.
4. Done: FreeText (Japanese included), Line, Polygon/PolyLine, Stamp, Caret,
   FileAttachment.
5. Filling in form fields.

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

Mouse input is window messages. Upstream tests passing with PDFium:
`palette-delete-annotation`, `command-palette-annotations`,
`ink-annotation-bounds`, `create-annot-enters-edit-mode`, the free text part of
`annot-undo-one-step`, `annot-filter-close-tab`, `annot-filter-close-window`,
`annot-filter-syntax`, `annot-text-popup-reload`, `file-link-no-dest`,
`ad-hoc-paste-image-annot`, `ad-hoc-annot-edit-race`.

These upstream annotation tests fail on this host with MuPDF too, because
injected mouse input is dropped: `annot-undo-redo`, `annot-copy-paste`,
`annot-cut-paste`, `annot-filter-toolbar`, `annot-list-placement`,
`annot-color-dropdown`, `annot-contents-click-away`, `annot-nudge`,
`annot-moveable-types`, `ink-thickness`, `stamp-edit-toolbar-name`, and the
shape, ink, line, polyline, text, free text, stamp and caret placement tests.
`redact-annotations` passes with MuPDF only.
