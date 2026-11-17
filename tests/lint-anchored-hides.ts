// Lint: owners hide and test anchored popups through the anchor layer (E124, E138).
//
// Windows hides the popups a frame owns while it is minimized. Hiding a hidden
// window tells no one, so the anchor layer (src/base/Win.cpp) would show it
// again on restore. HideAnchoredPopup() tells it; ShowAppWindow(SW_HIDE),
// HwndSetVisible(), VirtHost::Show(false) / SetPos(r, false) and
// WindowBase::SetIsVisible(false) go through it. HwndIsVisible() (so
// VirtHost::IsVisible()) reports such a popup shown until the restore, so an
// owner's state, and a hide guarded by it, don't depend on the minimize.
//
// Only raw Win32 calls bypass the layer. Owners need the popup's HWND to place
// and paint it, so a handle type wouldn't rule them out. In a file that
// anchors a popup (or hides one anchored elsewhere, `companions`), a raw hide
// or visibility test is allowed only for a window that is not anchored, keyed
// by file and enclosing function.
//
// Run standalone: bun tests/lint-anchored-hides.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowed: Record<string, string> = {
  "Toolbar.cpp:ShowOrHideToolbar": "the toolbar, a child window",
};

// files that hide a popup another file anchors
const companions: Record<string, string> = {
  "RefHover.cpp": "hides RefHoverPopup.cpp's citation popup",
};

const anchors = /\bAnchorPopup\s*\(/;
const rawCall = /\bShowWindow\s*\([^;]*\bSW_HIDE\b|\bSWP_HIDEWINDOW\b|\bIsWindowVisible\s*\(/;
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
  const seenCompanions = new Set<string>();
  const files = readdirSync(srcDir, { recursive: true }) as string[];
  for (const f of files) {
    const name = f.replaceAll("\\", "/");
    // the anchor layer itself
    if (name.startsWith("ng/") || !/\.(?:cpp|c)$/.test(name) || name === "base/Win.cpp") continue;
    const text = readFileSync(join(srcDir, name), "utf-8");
    const lines = stripComments(text);
    const companion = !!companions[name];
    if (companion) seenCompanions.add(name);
    if (!companion && !lines.some((l) => anchors.test(l))) continue;
    const raw = text.split("\n");
    lines.forEach((line, i) => {
      if (!rawCall.test(line)) return;
      const key = `${name}:${enclosingFunc(lines, i)}`;
      if (!allowed[key]) {
        violations.push(`src/${name}:${i + 1} (${key}): ${raw[i].trim()}`);
        return;
      }
      seen.add(key);
    });
  }
  for (const key of Object.keys(allowed)) {
    if (!seen.has(key)) violations.push(`unused anchored-hides allowlist entry: ${key}`);
  }
  for (const name of Object.keys(companions)) {
    if (!seenCompanions.has(name)) violations.push(`missing anchored-hides companion: src/${name}`);
  }
  if (violations.length) {
    throw new Error(
      "raw hides or visibility tests in files with anchored popups; use HideAnchoredPopup() (or ShowAppWindow) " +
        "and HwndIsVisible(), " +
        `allowlists in tests/lint-anchored-hides.ts:\n${violations.join("\n")}`,
    );
  }
  console.log("PASS: anchored popups are hidden and tested through the anchor layer");
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
