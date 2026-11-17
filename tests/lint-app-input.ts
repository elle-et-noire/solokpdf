// Lint: raw mouse / foreground Win32 calls in src/ stay in the app input layer.
//
// src/base/Win.cpp's `//--- app input` section owns what the app sees of the
// mouse and the foreground (E101): it substitutes the test cursor and the
// hidden desktop's active window. A raw call elsewhere bypasses that and
// reintroduces e008e77f5 (physical input reaching a test). Read input through
// the layer (GetCursorPosition, GetMessageCursorPosition, HwndWindowFromPoint,
// HwndGetForeground, ArmMouseLeave / TrackMouseLeave). Calls that are not
// about input go in `allowed`, keyed by file and enclosing function.
//
// Run standalone: bun tests/lint-app-input.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowed: Record<string, string> = {
  "base/Win.cpp:HwndSetFocusForce": "AttachThreadInput to the foreground thread to take focus",
  "base/Win.cpp:InitConsoleState": "startup: the console window to restore after attaching",
  "SumatraPDF.cpp:SetStartupDpi": "startup DPI from the cursor's monitor, before any test cursor",
  "CommandPalette.cpp:SafeDeleteCommandPaletteWnd": "re-raises the owner unless another app took activation",
  "NavFilesInFolder.cpp:SafeDeleteNavFilesWnd": "re-raises the owner unless another app took activation",
  "gui/win/PlatformWindowWin.cpp:PlatformWindowActivateIfForeground": "raises unless another app took activation",
  "gui/win/Edit.cpp:SetFocusAttached": "AttachThreadInput to the foreground thread to take focus",
  "SumatraControl.cpp:ActivateForTest": "-dbg-control activate: attaches thread input and raises the window",
  "ScreenshotCapture.cpp:TakeScreenshots": "window to re-activate after a hotkey screenshot",
  "shared/ExplorerQuickLook.cpp:ApplyExplorerQuickLookChrome": "places the preview on Explorer's monitor",
  "shared/ExplorerQuickLook.cpp:ExplorerTopLevel": "system-wide: is Explorer the foreground app",
  "shared/ExplorerQuickLook.cpp:ExplorerForegroundAllowsPreview": "system-wide: is Explorer the foreground app",
  "shared/ExplorerQuickLook.cpp:QuickLookKeyboardProc": "low-level keyboard hook: which app gets Space",
  "Toolbar.cpp:OnCaptionDrag": "child hit test at the message's own point, not the cursor",
};

const rawInput =
  /\b(?:GetCursorPos|GetPhysicalCursorPos|GetMessagePos|GetForegroundWindow|TrackMouseEvent|_TrackMouseEvent|WindowFromPoint|WindowFromPhysicalPoint|ChildWindowFromPoint|ChildWindowFromPointEx|RealChildWindowFromPoint)\s*\(/;
// a function definition's first line: starts in column 0, has a '(', isn't a declaration
const funcStart = /^[A-Za-z_][^;]*?\b([A-Za-z_~][\w:~]*)\s*\(/;
const layerFile = "base/Win.cpp";
const layerStart = "//--- app input";

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

// [first, last) line indexes of the app input section
function layerRange(lines: string[]): [number, number] {
  const start = lines.findIndex((l) => l.startsWith(layerStart));
  if (start < 0) throw new Error(`${layerFile}: '${layerStart}' section not found`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("//---"));
  return [start, end < 0 ? lines.length : end];
}

export async function testit(): Promise<void> {
  const srcDir = join(import.meta.dir, "..", "src");
  const violations: string[] = [];
  const seen = new Set<string>();
  const files = readdirSync(srcDir, { recursive: true }) as string[];
  for (const f of files) {
    const name = f.replaceAll("\\", "/");
    if (name.startsWith("ng/") || !/\.(?:cpp|c|h)$/.test(name)) continue;
    const text = readFileSync(join(srcDir, name), "utf-8");
    const raw = text.split("\n");
    const lines = stripComments(text);
    const [layerFirst, layerEnd] = name === layerFile ? layerRange(raw) : [0, 0];
    lines.forEach((line, i) => {
      if (!rawInput.test(line)) return;
      if (i >= layerFirst && i < layerEnd) return;
      const key = `${name}:${enclosingFunc(lines, i)}`;
      if (!allowed[key]) {
        violations.push(`src/${name}:${i + 1} (${key}): ${raw[i].trim()}`);
        return;
      }
      seen.add(key);
    });
  }
  for (const key of Object.keys(allowed)) {
    if (!seen.has(key)) violations.push(`unused app-input allowlist entry: ${key}`);
  }
  if (violations.length) {
    throw new Error(
      "raw mouse/foreground calls outside src/base/Win.cpp's app input layer; use the layer or allowlist " +
        `in tests/lint-app-input.ts:\n${violations.join("\n")}`,
    );
  }
  console.log("PASS: raw mouse/foreground calls stay in the app input layer");
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
