# SolokPDF docs

SolokPDF is a Windows fork of SumatraPDF that renders PDFs with PDFium. MuPDF
remains as the fallback (`SOLOKPDF_ENGINE=mupdf` selects it for comparison)
and as a hidden editor of the same file, loaded only for annotations, forms,
signatures, redaction, document JavaScript and data PDFium lacks. Only the
original Win32 application is in scope; `src/ng/` is not.

## Priority

The move to PDFium is for its current text appearance: the user wants to avoid
MuPDF's thinner-looking text. Preserve PDFium's font selection, antialiasing,
render resolution and color processing. Do not switch the default to MuPDF to
meet memory/startup targets. Font-info v2 remains probe-only because it changes
rendered output.

## Resuming work

Work on branch `solokpdf-dev`. Read `AGENTS.md`, `readme.md`, this file and
[backlog.md](backlog.md), then the parts of [limitations.md](limitations.md)
for the area at hand. When an item lands, update its backlog row (status and
commit subject) and the matching text in `limitations.md`; put measurements in
[history.md](history.md) and condensed data in `data/`.

## Status

The first development milestone (native build, PDFium pages in the original
UI, MuPDF comparison, reproducible steps and explicit gaps) has been reached.
Full feature/performance parity and release readiness have not been reached.

## Documents

- [backlog.md](backlog.md): ordered work list and item status.
- [limitations.md](limitations.md): current PDFium-tab behavior and known
  limitations by area.
- [features.md](features.md): SolokPDF-only features (identity, theme page
  colors, count prefix, shortcuts dialog, Vim keys).
- [history.md](history.md): baseline, engine map, phases 2–5, font cache and
  other measurements, dropped CI cache plan, full-suite triage log.
- [annotations.md](annotations.md): annotation editing on PDFium tabs through
  the hidden MuPDF editor.
- [forms.md](forms.md): document JavaScript, forms and signing on PDFium tabs.
- [full-suite-triage.md](full-suite-triage.md): upstream full-suite failures
  per engine and their classification.
- [review-2026-10-29.md](review-2026-10-29.md): review of the SolokPDF UI
  commits up to `0e219f451`.
- [upstream-merge-assessment-2026-10-29.md](upstream-merge-assessment-2026-10-29.md):
  upstream merge assessment of 2026-10-29.
- `data/`: condensed measurement JSON cited by `history.md`.
