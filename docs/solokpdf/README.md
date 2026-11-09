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

## Status (2026-11-09)

Current source on `solokpdf-dev` includes E11's in-memory settings application.
Build and test results retain the dates and scope recorded with each change.

| Area           | Current state                                                                                                | Details                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| PDF engine     | PDFium renders PDFs; MuPDF is the fallback and lazy editor.                                                  | [Limitations](limitations.md), [annotations](annotations.md), [forms](forms.md)                                      |
| Upstream       | Merged through `8b716234f` on 2026-11-08 (D7).                                                               | [Merge results and remaining checks](upstream-merges.md#merge-result-2026-11-08)                                     |
| Text selection | Theme-colored translucent overlays; selection-only glyph rendering removed.                                  | [Current colors](features.md#selection-colors), [implementation record](selection-overlay-plan.md)                   |
| Sidebar trees  | Virtual bookmarks and favorites are the default in Debug and Release; physical-device checks remain pending. | [Migration plan and results](tree-view-replacement-plan.md), [manual reader check](tree-view-screen-reader-check.md) |
| Keyboard input | Context and binding checks partly shared; physical input checks remain pending.                              | [Handoff](keyboard-handoff.md), [investigation](keyboard-investigation.md)                                           |
| Settings       | Palette and settings-screen changes apply in memory; `-for-testing` keeps the settings file unchanged (E11). | [Behavior](features.md#settings), [validation](history.md#e11-settings-application-2026-11-09)                       |
| Remaining work | Tree acceptance checks, keyboard follow-up, manual checks and suite sharding.                                | [Backlog](backlog.md)                                                                                                |

## Resuming work

Read [agents.md](../../agents.md), [readme.md](../../readme.md), this file and
[backlog.md](backlog.md), then the current behavior and plan for the area at hand.
E11 is complete; keyboard follow-up remains under E12.
Tree implementation is in place; E10 remains open for the F2 acceptance checks.
Build instructions are in the root readme; local GUI tests follow
[testing.md](testing.md). Screen-reader and physical-device checks have separate
manual steps; automated checks do not establish those results.

## Document map

| Purpose            | Documents                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Current behavior   | [features.md](features.md), [limitations.md](limitations.md), [annotations.md](annotations.md), [forms.md](forms.md)                 |
| Open work          | [backlog.md](backlog.md)                                                                                                             |
| Tree migration     | [tree-view-replacement-plan.md](tree-view-replacement-plan.md), [tree-view-screen-reader-check.md](tree-view-screen-reader-check.md) |
| Keyboard follow-up | [keyboard-handoff.md](keyboard-handoff.md), [keyboard-investigation.md](keyboard-investigation.md)                                   |
| Test procedures    | [testing.md](testing.md)                                                                                                             |
| Historical results | [history.md](history.md), [upstream-merges.md](upstream-merges.md), [selection-overlay-plan.md](selection-overlay-plan.md)           |
| Measurements       | [data/](data/), cited by `history.md`                                                                                                |

## Keeping docs current

Keep current behavior in `features.md` and `limitations.md`, open work in
`backlog.md`, and dated results in `history.md`. Mark completed plans with their
implementation commit; retain their original acceptance criteria as history.
Move completed backlog rows to [history.md](history.md#completed-backlog).
Record upstream merges in `upstream-merges.md` and measurements in `data/`.
Update this status when the default behavior or active work changes. Keep test
results dated and distinguish automated checks from pending manual checks.
