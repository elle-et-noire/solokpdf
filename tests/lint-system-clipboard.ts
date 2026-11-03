import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowed: Record<string, { reason: string; calls: string[] }> = {
  "winapi.ts": {
    reason: "Win32 bindings used only by guarded real-clipboard tests",
    calls: [
      "OpenClipboard",
      "CloseClipboard",
      "EmptyClipboard",
      "SetClipboardData",
      "GetClipboardData",
      "GetClipboardSequenceNumber",
      "setClipboardText",
      "getClipboardText",
      "emptyClipboard",
      "clipboardSeqNo",
      "holdClipboard",
      "getClipboardDibInfo",
      "getClipboardFormats",
      "pbpaste",
    ],
  },
  "test-clipboard.ts": {
    reason: "ng and explicit real-clipboard fallback",
    calls: ["setClipboardText", "getClipboardText", "emptyClipboard", "pbcopy", "pbpaste"],
  },
  "ad-hoc-b67-clipboard.ts": { reason: "read-only system sequence proof", calls: ["clipboardSeqNo"] },
  "issue-6360.ts": {
    reason: "CF_DIB interoperability and clipboard contention; CI or opt-in only",
    calls: ["clipboardSeqNo", "emptyClipboard", "holdClipboard", "getClipboardDibInfo", "getClipboardFormats"],
  },
  "issue-5890.ts": { reason: "ng file-drop fallback; CI or opt-in only", calls: ["Set-Clipboard"] },
  "ad-hoc-paste-image-annot.ts": {
    reason: "external image paste; CI or opt-in only",
    calls: ["System.Windows.Forms.Clipboard"],
  },
  "ad-hoc-png-optimize.ts": {
    reason: "external image paste; CI or opt-in only",
    calls: ["System.Windows.Forms.Clipboard"],
  },
};

const systemClipboard =
  /\b(?:OpenClipboard|CloseClipboard|EmptyClipboard|SetClipboardData|GetClipboardData|GetClipboardSequenceNumber|setClipboardText|getClipboardText|emptyClipboard|clipboardSeqNo|holdClipboard|getClipboardDibInfo|getClipboardFormats|pbcopy|pbpaste)\b|Get-Clipboard|Set-Clipboard|System\.Windows\.Forms\.Clipboard/g;

export async function testit(): Promise<void> {
  const violations: string[] = [];
  for (const name of readdirSync(import.meta.dir)) {
    if (!name.endsWith(".ts") || name === "lint-system-clipboard.ts") continue;
    const lines = readFileSync(join(import.meta.dir, name), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith("//")) return;
      for (const match of line.matchAll(systemClipboard)) {
        if (!allowed[name]?.calls.includes(match[0])) violations.push(`${name}:${index + 1}: ${match[0]}`);
      }
    });
  }
  if (violations.length) throw new Error(`system clipboard outside allowlist:\n${violations.join("\n")}`);
  console.log("PASS: system clipboard calls are allowlisted");
}

if (import.meta.main) await testit();
