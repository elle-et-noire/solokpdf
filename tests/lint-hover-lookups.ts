// Lint: hover's page lookups stay in hover code (E127).
//
// A lookup under the pointer has two kinds. A user action (click, press,
// double-click, key) calls DisplayModel's Get* / IsOverText, which answer as
// with no render running: a busy try frees the page and waits. Hover calls the
// Try* lookups and the cached text, which answer busy instead of waiting, and
// looks again later. An action that took a hover lookup's value would drop
// itself while a render runs, the bug E123 and E127 fixed. The lookups
// themselves live in DisplayModel, TextSelection and the engines; a caller
// elsewhere goes in `allowed`, keyed by file and enclosing function, only when
// it is hover (or a test hook that reports hover's view).
//
// Run standalone: bun tests/lint-hover-lookups.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowed: Record<string, string> = {
  "Canvas.cpp:CitationHoverAt": "hover: citation popup",
  "Canvas.cpp:HoverMoveAt": "hover: annotation under the mouse",
  "Canvas.cpp:ShowCitationAt": "hover: citation popup (TestRefHover, hover retry)",
  "Canvas.cpp:SetTextOrArrorCursor": "hover: I-beam",
  "Canvas.cpp:OnSetCursorMouseNone": "hover: cursor shape and tooltips",
  "RefHoverCanvas.cpp:RefHoverOnCanvasMouseMove": "hover: citation popup",
  "SumatraControl.cpp:ExecuteControlRequest": "-dbg-control: reports hover's view (widget-cursor)",
  "shared/MainWindowCommon.cpp:NewCommandCtx": "menu and toolbar state, rebuilt on every page change",
  "shared/RefHoverShow.cpp:RefHoverOnTimer": "hover: popup crop's text read",
  "shared/RefHoverText.cpp:RefHoverTextAt": "hover: citation lookup and popup crop",
  "shared/RefHoverText.cpp:RefHoverPlainTextAt": "hover: cached text for citation lookup",
  "shared/RefHoverText.cpp:FindReferenceLocation": "hover: plain-text citation fallback",
  "shared/LinkFollow.cpp:RecomputeLinkHints": "keyboard link hints: the scroll branch retries on busy",
};

// the files that define the lookups (the one place the action / hover rule lives)
const lookupLayer = new Set([
  "shared/DisplayModel.cpp",
  "shared/TextSelection.cpp",
  "shared/EngineBase.cpp",
  "shared/EngineMupdf.cpp",
  "solokpdf/EnginePdfium.cpp",
]);

const hoverLookup =
  /\b(?:TryOverText|TryOverGlyph|TryElementAtPos|TryElementsOnPage|TryAnnotationAtPos|TryAnnotationAtPosHover|TryWidgetCursorAt|CachedTextForPage|RefHoverPlainTextAt)\s*\(|\bEngineWait::NoWait\b/;
// a function definition's first line: starts in column 0, has a '(', isn't a declaration
const funcStart = /^[A-Za-z_][^;]*?\b([A-Za-z_~][\w:~]*)\s*\(/;

// Blanks comments and string / char literals, keeping line count.
function stripComments(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return code.split("\n");
}

function enclosingFunc(lines: string[], index: number): string {
  for (let i = index; i >= 0; i--) {
    const m = funcStart.exec(lines[i]);
    if (m && !lines[i].startsWith("#")) return m[1];
  }
  return "";
}

export async function testit(): Promise<void> {
  const srcDir = join(import.meta.dir, "..", "src");
  const violations: string[] = [];
  const seen = new Set<string>();
  const files = readdirSync(srcDir, { recursive: true }) as string[];
  for (const f of files) {
    const name = f.replaceAll("\\", "/");
    if (name.startsWith("ng/") || !/\.(?:cpp|c)$/.test(name) || lookupLayer.has(name)) continue;
    const text = readFileSync(join(srcDir, name), "utf-8");
    const raw = text.split("\n");
    const lines = stripComments(text);
    lines.forEach((line, i) => {
      if (!hoverLookup.test(line)) return;
      const key = `${name}:${enclosingFunc(lines, i)}`;
      if (!allowed[key]) {
        violations.push(`src/${name}:${i + 1} (${key}): ${raw[i].trim()}`);
        return;
      }
      seen.add(key);
    });
  }
  for (const key of Object.keys(allowed)) {
    if (!seen.has(key)) violations.push(`unused hover-lookup allowlist entry: ${key}`);
  }
  if (violations.length) {
    throw new Error(
      "hover lookups outside hover code; a user action uses DisplayModel's Get* / IsOverText, hover allowlists " +
        `in tests/lint-hover-lookups.ts:\n${violations.join("\n")}`,
    );
  }
  console.log("PASS: hover lookups stay in hover code");
}

if (import.meta.main) {
  // pure static lint - no app build needed
  try {
    await testit();
  } catch (e) {
    console.error(`FAIL: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  }
}
