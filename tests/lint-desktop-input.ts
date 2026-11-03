import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowed: Record<string, string> = {
  "winapi.ts:ffi-cursor": "Win32 cursor binding",
  "winapi.ts:ffi-key-up": "release held modifier keys",
  "winapi.ts:ffi-foreground": "Win32 foreground binding",
  "winapi.ts:cursor-wrapper": "Win32 cursor wrapper",
  "winapi.ts:cursor-call": "Win32 cursor call",
  "winapi.ts:key-up-call": "release held modifier keys",
  "winapi.ts:foreground-wrapper": "Win32 foreground wrapper",
  "winapi.ts:foreground-call": "Win32 foreground call",
  "win-automation.ts:cursor-import": "ng/mac cursor fallback import",
  "win-automation.ts:cursor-fallback": "ng/mac cursor fallback",
  "issue-3472.ts:foreground-import": "foreground scrollbar interaction import",
  "issue-3472.ts:foreground-scroll": "foreground scrollbar interaction",
  "issue-6045.ts:foreground-import": "foreground help interaction import",
  "issue-6045.ts:foreground-help": "foreground help interaction",
  "ad-hoc-4600-dialog.ts:foreground-import": "dialog pixel checks import",
  "ad-hoc-4600-dialog.ts:foreground-frame": "dialog pixel checks",
  "ad-hoc-4600-dialog.ts:foreground-dialog": "dialog pixel checks",
  "ad-hoc-4600-margin.ts:foreground-import": "margin pixel checks import",
  "ad-hoc-4600-margin.ts:foreground-margin": "margin pixel checks",
  "ad-hoc-4600-notif.ts:foreground-import": "notification pixel checks import",
  "ad-hoc-4600-notif.ts:foreground-frame": "notification pixel checks",
  "ad-hoc-4600-notif.ts:foreground-notif": "notification pixel checks",
  "ad-hoc-4600-perfile.ts:foreground-import": "per-file pixel checks import",
  "ad-hoc-4600-perfile.ts:foreground-perfile": "per-file pixel checks",
};

const desktopInput =
  /\b(?:setCursorPos|setForegroundWindow|forceForeground|SetCursorPos|SetForegroundWindow|BringWindowToTop|SetActiveWindow|SwitchToThisWindow|keybd_event|SendInput)\b/;
const marker = /(?:\/\/|\/\*) desktop-input: ([a-z0-9-]+)/;

export async function testit(): Promise<void> {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(import.meta.dir)) {
    if (!name.endsWith(".ts") || name === "lint-desktop-input.ts") continue;
    const lines = readFileSync(join(import.meta.dir, name), "utf-8").split("\n");
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith("//")) return;
      const code = line.replace(/\s*\/\/ desktop-input: .*$/, "");
      if (!desktopInput.test(code)) return;
      const id = marker.exec(line)?.[1];
      const key = `${name}:${id}`;
      if (!id || !allowed[key] || seen.has(key)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
      seen.add(key);
    });
  }
  for (const key of Object.keys(allowed)) {
    if (!seen.has(key)) violations.push(`unused desktop-input allowlist: ${key}`);
  }
  if (violations.length) throw new Error(`desktop input references outside allowlist:\n${violations.join("\n")}`);
  console.log("PASS: desktop input references are allowlisted");
}

if (import.meta.main) await testit();
