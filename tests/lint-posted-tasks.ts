// Lint: a task posted with a raw MainWindow* or WindowTab* must go through
// PostForWindow / PostForTab (src/shared/MainWindowCommon.cpp).
//
// A posted task runs later, after the window or tab may have been closed and
// freed. Each such task used to re-check validity itself, and the ones that
// forgot (or wrote to the tab before checking) were use-after-frees.
//
// Also: a posted task or timer handler, and the functions of its file it calls (3 deep),
// moves the focus or activation only after HwndMoveFocus / HwndRefocusWhenActive, which
// take it only from the mover's windows (E144, E146). It runs after the input, when the
// focus may be in another app or window. A raw move after one stays where it went, e.g.
// `if (HwndMoveFocus(hwnd, hwnd)) SetFocusTo(listBox)`. Calls into other files, COM
// callbacks and window messages posted by hand aren't followed.
//
// Run standalone: bun tests/lint-posted-tasks.ts  (also runs in run-almost-all.ts)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// uitask::Post(MkFunc0(Fn, win), ...)
const INLINE_POST = /uitask::Post\(\s*MkFunc0(<\s*(MainWindow|WindowTab)\s*>)?\(\s*\w+\s*,\s*(win|tab)\s*\)/;
// auto fn = MkFunc0<WindowTab>(Fn, tab); ... uitask::Post(fn, ...)
const TYPED_FUNC = /\b(\w+)\s*=\s*MkFunc0<\s*(MainWindow|WindowTab)\s*>/;

// raw focus or activation moves
const RAW_FOCUS =
  /(?:^|[^\w>.:])(?:::)?(?:HwndSetFocus|SetFocus|SetFocusTo|EditSetFocus|SetActiveWindow|SetForegroundWindow|HwndToForeground|HwndSetFocusForce|BringWindowToTop|RaiseAppWindow)\s*\(|(?:->|\.)(?:SetFocus|SetFocusTo)\s*\(/; // desktop-input: focus-names
const SOURCED = /\b(?:HwndMoveFocus|HwndRefocusWhenActive)\s*\(/;
// the posted function, or the timer handler, on a line posting or assigning it
const DEFERRED = [
  /MkMethod0<\s*\w+\s*,\s*&\w+::(\w+)\s*>/,
  /MkFunc0(?:<[^>]*>)?\(\s*(\w+)\s*,/,
  /MkFunc0Void\(\s*(\w+)\s*\)/,
  /PostFor(?:Window|Tab)\(\s*[\w>-]+\s*,\s*(\w+)/,
];
const TIMER = /onTimer\s*=\s*MkMethod1<[^;]*&\w+::(\w+)\s*>/;
const DEPTH = 3;
// moves made on purpose, with the reason
const ALLOWED: Record<string, string> = {
  "SumatraControl.cpp:ExecuteControlRequest": "test hooks: the test's request stands for input",
  "ExplorerQuickLook.cpp:ShowExplorerQuickLook": "Explorer asked to show the document and hands the foreground over",
  "SumatraPDF.cpp:CloseWindow": "closing the last window's document, for the user's close or tabs setting change",
  "SumatraPDF.cpp:ShowMainWindow": "a window created for the user, e.g. the tabs setting changed",
  "Notifications.cpp:OnTimer": "a notification is a child window: on top of its siblings, not activated",
};

// a function's body in the file's text, by its name
function bodyOf(text: string, name: string): string | null {
  const re = new RegExp(String.raw`^\w[^;{}\n]*?\b(?:\w+::)?${name}\s*\([^;{]*\)\s*(?:const\s*)?\{`, "m");
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  const start = i;
  for (let depth = 1; i < text.length && depth > 0; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  return text.slice(start, i - 1);
}

function stripComment(line: string): string {
  return line.replace(/\/\/.*$/, "");
}

// raw focus moves reached from the file's posted tasks and timer handlers before a sourced move
function deferredFocusMoves(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const roots = new Set<string>();
  lines.forEach((line, i) => {
    const t = TIMER.exec(line);
    if (t) roots.add(t[1]!);
    if (!/uitask::Post|PostFor(?:Window|Tab)\(/.test(lines.slice(i, i + 4).join("\n"))) return;
    for (const re of DEFERRED) {
      const m = re.exec(line);
      if (m && !m[1]!.startsWith("RunPostedFor")) roots.add(m[1]!);
    }
  });
  const base = file.replace(/^.*[\\/]src[\\/]/, "").replace(/^shared[\\/]/, "");
  const sourcedCache = new Map<string, boolean>();
  const sourced = (name: string): boolean => {
    if (!sourcedCache.has(name)) sourcedCache.set(name, SOURCED.test(bodyOf(text, name) ?? ""));
    return sourcedCache.get(name)!;
  };
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (name: string, depth: number, path: string) => {
    if (seen.has(name) || ALLOWED[`${base}:${name}`]) return;
    seen.add(name);
    const body = bodyOf(text, name);
    if (body === null) return;
    let moved = false;
    for (const raw of body.split("\n")) {
      const line = stripComment(raw);
      if (RAW_FOCUS.test(line) && !moved && !SOURCED.test(line)) {
        found.push(`${file}: ${path}: ${line.trim()}`);
      }
      const calls = [...line.matchAll(/(?<![\w.>])(\w+)\s*\(/g)].map((m) => m[1]!);
      moved = moved || SOURCED.test(line) || calls.some((c) => c !== name && sourced(c));
    }
    if (depth <= 1) return;
    for (const m of stripCommentAll(body).matchAll(/(?<![\w.>])(\w+)\s*\(/g)) {
      walk(m[1]!, depth - 1, `${path} > ${m[1]}`);
    }
  };
  for (const root of roots) walk(root, DEPTH, root);
  return found;
}

function stripCommentAll(body: string): string {
  return body.split("\n").map(stripComment).join("\n");
}

function* cppFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      yield* cppFiles(p);
    } else if (name.endsWith(".cpp")) {
      yield p;
    }
  }
}

export async function testit(): Promise<void> {
  const srcDir = join(import.meta.dir, "..", "src");
  const violations: string[] = [];
  for (const file of cppFiles(srcDir)) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, i) => {
      if (INLINE_POST.test(line)) {
        violations.push(`${file}:${i + 1}: ${line.trim()}`);
        return;
      }
      const m = TYPED_FUNC.exec(line);
      if (!m) {
        return;
      }
      const posted = new RegExp(String.raw`uitask::Post\(\s*${m[1]}\b`);
      if (lines.slice(i + 1, i + 4).some((l) => posted.test(l))) {
        violations.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  if (violations.length > 0) {
    throw new Error(
      "tasks posted with a raw MainWindow* / WindowTab* - use PostForWindow / PostForTab instead:\n" +
        violations.join("\n"),
    );
  }
  const focusMoves: string[] = [];
  for (const file of cppFiles(srcDir)) {
    // ng's focus is GPUI's
    if (/[\\/]src[\\/]ng[\\/]/.test(file)) continue;
    focusMoves.push(...deferredFocusMoves(file));
  }
  if (focusMoves.length > 0) {
    throw new Error(
      "deferred focus moves not made from the mover's windows - use HwndMoveFocus / HwndRefocusWhenActive:\n" +
        focusMoves.join("\n"),
    );
  }
  console.log("PASS: no raw window / tab pointers or raw focus moves in posted tasks");
}

if (import.meta.main) {
  // pure static lint - no app build needed
  try {
    await testit();
  } catch (e) {
    console.error(`❌ ${(e as Error)?.message ?? e}`);
    process.exit(1);
  }
}
