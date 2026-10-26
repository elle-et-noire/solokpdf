# PDFium annotations

PDFium documents used to have no annotation support: `EngineSupportsAnnotations`
was true only for EngineMupdf, whose model wraps `pdf_annot` and relies on
MuPDF's journal for undo. This is the port to PDFium's annotation API, using
the prebuilt PDFium binaries.

## Design

- `src/shared/AnnotationBackend.h` is the interface. `EngineBase::GetAnnotationBackend()`
  returns it; EnginePdfium implements it, EngineMupdf returns null.
- `Annotation::backend` marks a backend annotation (`engine`/`pdfannot` stay null).
  The Annotation.cpp accessors and the `EngineMupdf*` annotation entry points
  forward to the backend, so the ~30 UI call sites stay unchanged. Internally,
  MuPDF-only code checks `IsLiveMupdf`; the public `AnnotationIsLive` covers both.
- EnginePdfium identifies an annotation by page and index in `/Annots`
  (`PdfiumAnnot`) and caches what the UI reads (rect, quads, contents, author,
  date, colors, opacity): PDFium parses a page's content on every load. A page's
  annotations are read when it renders, as EngineMupdf does, or when listed.
  Edits load the page, change the annotation and reread the cache.
- PDFium redraws a missing appearance for text markup, Square, Circle, Ink,
  Text and Popup, so edits to those drop `/AP`. `FPDFAnnot_SetColor` refuses an
  annotation that has one.
- Saving is `FPDF_SaveAsCopy` with `FPDF_INCREMENTAL` into a temporary file that
  replaces the document; the app then reloads it, as after a MuPDF save.
- The UI's annotation editing is gated on `supportsAnnots` instead of `isPdf`,
  which stays MuPDF-only because it also shows MuPDF's PDF tools.

## Limits of the prebuilt PDFium API

It can't write arrays, numbers or names into an annotation dictionary: line end
points (`/L`), polygon vertices, line endings (`/LE`), FreeText alignment (`/Q`)
and Text icon names (`/Name`) can't be set. It can't remove quad points or `/IC`,
and has no undo. FreeText, Line, Polygon and Stamp need appearances we build.

## Stages

1. Done: listing, hit testing, selection, text markup (Highlight, Underline,
   Squiggly, StrikeOut) from a text selection, contents, color, opacity,
   delete, incremental save and save as.
2. Text notes, Square, Circle, Ink; moving and resizing.
3. Undo/redo (snapshots of the document), copy/paste and cut.
4. FreeText, Line, Polygon/PolyLine, Stamp, FileAttachment: display only until
   the API gaps are worked around (own appearance streams, or a PDFium build).
5. Filling in form fields.

## Tests

`tests/ad-hoc-pdfium-annots.ts`: an existing highlight is listed, a keyboard
selection becomes a drawn highlight, the incremental save keeps the original
bytes as its prefix, the reload still lists both, and MuPDF reads them.
Upstream tests passing with PDFium: `palette-delete-annotation`,
`command-palette-annotations`. `create-annot-enters-edit-mode` passes its
highlight half and waits for stage 2 (Text notes).

These upstream annotation tests fail on this host with MuPDF too, with and
without these changes, because injected mouse input is dropped:
`annot-undo-redo`, `annot-copy-paste`, `annot-cut-paste`, `annot-filter-toolbar`,
`shape-annotation-placement`, `ink-annotation-placement`, `annot-color-dropdown`,
`annot-contents-click-away`.
