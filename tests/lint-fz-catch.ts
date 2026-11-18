// Lint: every MuPDF catch in src/ (outside the frozen src/ng) consumes its error through src/shared/mupdf/fz-catch.h.
//
// A fz_catch() that leaves the error pending makes the next throw or fz_drop_context()
// on that context print "UNHANDLED EXCEPTION!" (E111: a canceled themed render). The
// fz_catch_* macros consume it before the body runs (fz_catch_rethrow propagates it
// after), so src/ may not use raw fz_catch() or MuPDF's own consume/rethrow calls,
// which would act on an error that is already gone.
//
// Run standalone: bun tests/lint-fz-catch.ts

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const helperFile = "shared/mupdf/fz-catch.h";

// file:function -> why it may call a MuPDF error-state function directly
const allowed: Record<string, string> = {
  "shared/EngineMupdf.cpp:EngineMupdf_UnitTestThemeCancel": "asserts no error is left pending",
};

const rawCatch = /\bfz_catch\s*\(/;
const rawContext = /\bfz_new_context(?:_imp)?\s*\(/;
const contextFactory = "shared/mupdf/fz-context.h:NewMupdfContext";
const rawErrorCall =
  /\b(?:fz_report_error|fz_ignore_error|fz_convert_error|fz_rethrow|fz_rethrow_if|fz_rethrow_unless|fz_morph_error|fz_caught)\s*\(/;
const ignoreWithReason = /\bfz_catch_ignore\s*\([^,()]+,\s*"[^"]+"\s*\)/;
const rethrowCatch = /\bfz_catch_rethrow\s*\([^()]*\)\s*\{/g;
const earlyExit = /\b(?:return|break|goto)\b/;
// a function definition's first line: starts in column 0, has a '(', isn't a declaration
const funcStart = /^[A-Za-z_][^;]*?\b([A-Za-z_~][\w:~]*)\s*\(/;

// Blanks comments and string / char literals, keeping offsets.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}

function enclosingFunc(lines: string[], index: number): string {
  for (let i = index; i >= 0; i--) {
    const m = funcStart.exec(lines[i]);
    if (m && !lines[i].startsWith("#")) return m[1];
  }
  return "";
}

function lineOf(code: string, offset: number): number {
  return code.slice(0, offset).split("\n").length;
}

// offset just past the '}' matching the '{' at open
function blockEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i + 1;
  }
  return code.length;
}

export async function testit(): Promise<void> {
  const srcDir = join(import.meta.dir, "..", "src");
  const violations: string[] = [];
  const seen = new Set<string>();
  const files = readdirSync(srcDir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(srcDir, entry.name);
    if (!entry.isDirectory()) return [path];
    if (entry.name === "ng") return [];
    return readdirSync(path, { recursive: true }).map((name) => join(path, name));
  });
  for (const path of files) {
    const name = relative(srcDir, path).replaceAll("\\", "/");
    if (name === helperFile || !/\.(?:c|cpp|h|m|mm)$/.test(name)) continue;
    const text = readFileSync(path, "utf-8");
    const raw = text.split("\n");
    const code = stripComments(text);
    const lines = code.split("\n");

    lines.forEach((line, i) => {
      const where = `src/${name}:${i + 1}: ${raw[i].trim()}`;
      if (rawCatch.test(line)) violations.push(`raw fz_catch: ${where}`);
      if (rawContext.test(line) && `${name}:${enclosingFunc(lines, i)}` !== contextFactory) {
        violations.push(`MuPDF context must be created through a logging factory: ${where}`);
      }
      if (/\bfz_catch_ignore\s*\(/.test(line) && !ignoreWithReason.test(raw[i])) {
        violations.push(`fz_catch_ignore needs a reason string: ${where}`);
      }
      if (!rawErrorCall.test(line)) return;
      const key = `${name}:${enclosingFunc(lines, i)}`;
      if (!allowed[key]) {
        violations.push(`MuPDF error-state call outside fz-catch.h: ${where}`);
        return;
      }
      seen.add(key);
    });

    // the rethrow runs after the body, so leaving it early would keep the error pending
    for (const m of code.matchAll(rethrowCatch)) {
      const open = m.index + m[0].length - 1;
      const body = code.slice(open, blockEnd(code, open));
      if (earlyExit.test(body)) {
        const n = lineOf(code, m.index);
        violations.push(`fz_catch_rethrow body leaves early: src/${name}:${n}: ${raw[n - 1].trim()}`);
      }
    }
  }
  for (const key of Object.keys(allowed)) {
    if (!seen.has(key)) violations.push(`unused fz-catch allowlist entry: ${key}`);
  }
  if (violations.length) {
    throw new Error(
      `Use src/${helperFile} for MuPDF catches and a logging factory for contexts:\n${violations.join("\n")}`,
    );
  }
  console.log("PASS: Win32 and shared MuPDF catches consume their errors");
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
