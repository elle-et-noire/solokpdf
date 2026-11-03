
General rules for this task (SolokPDF, C:\work\solokpdf):
- Read AGENTS.md, docs/solokpdf/README.md, docs/solokpdf/backlog.md and the
  relevant parts of docs/solokpdf/limitations.md first.
- Test-first: write or extend a test (tests/ad-hoc-pdfium-*.ts pattern, or an
  existing upstream test run against both engines with SOLOKPDF_ENGINE=mupdf /
  default PDFium), observe it fail on PDFium, then fix, then see it pass.
- Match MuPDF behavior on PDFium tabs. Keep ordinary PDF open/render on the
  PDFium-only path; never change PDFium's font, antialiasing, render
  resolution or color processing; keep PDFium the default engine.
- Check for a PDF engine with IsPdfPageEngine(kind) (src/shared/EngineAll.h),
  never kindEnginePdfium directly outside `#if defined(SOLOKPDF_PDFIUM) &&
  !defined(SUMATRA_NG)`: src/shared/ is also built by ng and by upstream's
  non-PDFium build.
- Never route routine work (opening, rendering, text extraction, search,
  selection, links, hover, thumbnails) through the hidden MuPDF editor
  (AnnotationEditor(EditorLoad::Load)): it doubles memory and open time and
  locks files of 32 MiB or more. The editor is only for editing (annotations,
  forms, signatures, redaction), document JavaScript, and data PDFium lacks
  that a document actually uses, gated by a cheap PDFium check. Fix routine
  paths with PDFium's own API instead.
- Where PDFium lacks an API, reuse the lazy hidden MuPDF editor
  (EngineBase::AnnotationEditor / existing *Mupdf helpers taking path+data)
  rather than re-implementing PDF parsing.
- Build/test (PowerShell): `. ./tools/solokpdf/env.ps1`, then
  `bun cmd/solok-build.ts -quick` (debug app only, out/dbg64/SumatraPDF.exe,
  what tests run; use `-dbg` once at the end, or if -quick fails), then
  `bun tools/solokpdf/run-hidden.ts -- bun tests/<test>.ts --no-build`.
- Run builds and every test that launches the app with sandbox escalation
  (outside your sandbox). Inside it MSBuild fails, and WebView2 (Markdown,
  HTML, CHM, help) crashes with an error dialog on the owner's desktop and
  "browser not ready" in tests. Never run them inside the sandbox. Never run
  an app-launching test on the owner's visible desktop; use `run-hidden.ts`.
- Time matters: don't build Release or take timing measurements unless the
  task explicitly asks for them; one Release build at most when it does.
  Don't re-run unchanged passing tests; run each targeted test once after the
  final change.
  Run only the targeted tests named or clearly related; no full suites.
- clang-format changed src/ files:
  D:\vs2026\VC\Tools\Llvm\x64\bin\clang-format.exe -i -style=file <files>
  prettier only touched .ts/.md files:
  .work\build-deps\node_modules\.bin\prettier --write <files>
- Don't add *.test.ts files; don't edit .github/ unless the task is CI;
  vs2022/ must stay unchanged. If a link fails with LNK1201 on a .pdb,
  rename the pdb aside and rebuild; don't kill processes.
- Add a fast new ad-hoc test (< ~15 s, no external files) to
  tests/run-solokpdf-ci.ts.
- Move the item's row from docs/solokpdf/backlog.md to the "Completed backlog" of docs/solokpdf/history.md (status done + commit
  subject) and the matching text in docs/solokpdf/limitations.md.
- Commit locally, one commit per backlog item (do NOT push), AGENTS.md
  commit rules, each message ending with:

  Co-Authored-By: Codex <noreply@openai.com>

  prompt: 計画的に、網羅的にやって（バックログ <ID>）

- Final report: per item, what failed before, what changed, test results,
  anything left (and set that item to blocked with the reason if you could
  not finish it).
