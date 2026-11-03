import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowed: Record<string, string> = {
  "winapi.ts": "Win32 definitions",
  "win-automation.ts": "ng/mac cursor fallback",
  "issue-3472.ts": "foreground scrollbar interaction",
  "issue-6045.ts": "foreground help window interaction",
  "issue-6269.ts": "CI-only foreground variant uses the app control command",
  "ad-hoc-4600-dialog.ts": "dialog pixel checks",
  "ad-hoc-4600-margin.ts": "margin pixel checks",
  "ad-hoc-4600-notif.ts": "notification pixel checks",
  "ad-hoc-4600-perfile.ts": "per-file pixel checks",
};

const desktopInput = /\b(?:setCursorPos|SetForegroundWindow|setForegroundWindow)\s*\(/;

export async function testit(): Promise<void> {
  const violations: string[] = [];
  for (const name of readdirSync(import.meta.dir)) {
    if (!name.endsWith(".ts") || name === "lint-desktop-input.ts") continue;
    const lines = readFileSync(join(import.meta.dir, name), "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (desktopInput.test(line) && !allowed[name]) violations.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  if (violations.length) throw new Error(`desktop input calls outside allowlist:\n${violations.join("\n")}`);
  console.log("PASS: desktop input calls are allowlisted");
}

if (import.meta.main) await testit();
