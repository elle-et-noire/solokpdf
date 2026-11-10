# PDFium forms and signing

## External updates

Automatic reload waits while the current document has unsaved edits or an
active text/choice editor. The pending update survives tab switches. Canceling
the editor lets the update run on the next tab selection. Reloading another
window leaves the editor intact.

Reload Document commits active form input, then offers Save, Discard or Cancel
for unsaved changes. A failed save or Cancel keeps the document and Undo history.
Save's intentional reload and Discard Changes still proceed.
`tests/auto-reload-unsaved.ts` covers both engines on Windows.
Dirty-state omissions and dialog reentry remain separate E36 and E34 work.

## Document JavaScript

PDFium reports document JavaScript but does not run MuPDF's scripts itself.
When `DisableJavaScript` is off and PDFium finds a document-level action, the
engine opens its existing MuPDF annotation editor before the first render.
MuPDF runs the scripts there, and its widget drawing shows initialized values
over PDFium's page. The check is a PDFium action count; files without actions
and runs with JavaScript disabled do not load the editor on open. This keeps
ordinary files on the PDFium-only path. Deferring the editor until after the
first render would need a second render and could show stale field values.
`tests/ad-hoc-pdfium-document-js.ts` checks the behavior in both engines.

## Digital signing

Sign Document uses the PDFium document's lazy MuPDF annotation editor. Opening
the dialog loads it only when needed to list unsigned fields and count existing
signatures. A click on an unsigned signature field uses the same editor and
preselects that field. Ordinary PDF opens and renders do not load MuPDF.

`PdfSign.cpp` signs the editor, including `CmdSignDocument certify` and its
DocMDP permissions. The existing save path writes the signed file with MuPDF's
incremental save, then reloads it through the configured engine. PDFium's save
is avoided because it can copy every parsed object. Reload retains the current
display state, including the page position.

Annotation and form edits already live in that editor. Signing adds its change
there, so Save As or overwrite saves those edits and the signature together.
Canceling the save leaves them unsaved, as in the MuPDF document path. The
existing unsaved-changes prompt handles them on close or reload.

Failed signature preparation restores the field, lock/certification settings,
Undo/Redo history, pending signers and loaded widgets. Existing edits and
signatures survive. Certificate and image inputs are read before editing;
preparation requires an idle Undo journal. A successful preparation is one
Undo step. Canceling or failing the subsequent save keeps that signature dirty.
`tests/sign-rollback.ts` covers both Windows engines.

`tests/ad-hoc-pdfium-signing.ts` signs and certifies through both engines,
verifies the saved bytes, and reopens the result. `tests/issue-5964.ts` covers
the signature-field click; `tests/ad-hoc-sign-document.ts` covers the dialog.
