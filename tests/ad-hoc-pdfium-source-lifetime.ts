import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, EXE, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { postMessage, processGuiResources, waitForTopWindow, WM_CLOSE } from "./winapi.ts";

const kTag = "ad-hoc-pdfium-source-lifetime";
const kOriginal = "ORIGINALWORD";
const kReplacement = "REPLACEDWORD";
const kCopyCommands = ["clone-page", "clone-editor-page"] as const;
const kLifetimeCycles = 6;
const kHandleTolerance = 4;

function fixture(word: string, size: "small" | "big"): string {
  const content = `BT /F1 18 Tf 72 700 Td (${word}) Tj ET`;
  const appearance = `/Tx BMC BT /F1 12 Tf 2 10 Td (${word}) Tj ET EMC`;
  return assemblePdf(
    [
      `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R] >> /ViewerPreferences << /NumCopies ${word === kOriginal ? 3 : 7} >> >>`,
      "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [7 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Type /Annot /Subtype /Widget /F 4 /P 3 0 R /FT /Tx /T (field) /V (${word}) /DA (/F1 12 Tf 0 g) /Rect [72 600 300 630] /AP << /N 8 0 R >> >>`,
      `<< /Type /XObject /Subtype /Form /BBox [0 0 228 30] /Resources << /Font << /F1 5 0 R >> >> /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
    ],
    { header: size === "big" ? `%PDF-1.4\n%${"x".repeat(33 * 1024 * 1024)}\n` : undefined },
  );
}

async function query(client: ControlClient, args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(`${args.join(" ")}: ${res[1]}`);
  return String(res[1]);
}

async function check(size: "small" | "big", action: "rename" | "replace" | "delete"): Promise<void> {
  const dir = tmpPath(`${kTag}/${size}-${action}`);
  rmSync(dir, { recursive: true, force: true });
  const appdata = join(dir, "settings");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), "ReloadModifiedDocuments = false\nRestoreSession = false\n");
  const path = join(dir, "source.pdf");
  const moved = join(dir, "moved.pdf");
  const original = Buffer.from(fixture(kOriginal, size), "latin1");
  writeFileSync(path, original);

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      if ((await query(client, ["editor"])) !== "editor=none") throw new Error("editor loaded before test");
      const before = new Map<string, string>();
      for (const command of kCopyCommands) before.set(command, await query(client, [command, 1]));
      if (action === "delete") unlinkSync(path);
      else renameSync(path, moved);
      if (action === "replace") writeFileSync(path, fixture(kReplacement, "small"), "latin1");

      const errors: string[] = [];
      const prefs = await query(client, ["print-prefs"]);
      if (!prefs.includes("copies=3")) errors.push(`print prefs: ${prefs}`);
      for (const command of [...kCopyCommands, "cached-text"] as const) {
        try {
          const text = await query(client, [command, 1]);
          if (!text.includes(kOriginal) || text.includes(kReplacement)) throw new Error(text);
          if (command !== "cached-text" && Number(/^ink=(-?\d+)/.exec(text)?.[1] ?? -1) <= 0) {
            throw new Error(`no printed content: ${text}`);
          }
          if (command !== "cached-text" && text !== before.get(command)) {
            throw new Error(`print output changed: ${text}`);
          }
          if (command === "cached-text" && (await query(client, ["editor"])) !== "editor=loaded") {
            throw new Error("full form text did not load the editor");
          }
        } catch (error) {
          errors.push(`${command}: ${error}`);
        }
      }
      const saved = join(dir, "original-copy.pdf");
      writeFileSync(saved, Buffer.concat([original, Buffer.from("\ntrailing data")]));
      const result = await client.request(ControlCommand.TestSaveFileAs, [saved]);
      if (result[0] !== 0 || !readFileSync(saved).equals(original)) errors.push(`source copy: ${result}`);
      const handles = processGuiResources(proc.pid!).handles;
      for (let cycle = 0; cycle < kLifetimeCycles; cycle++) {
        for (const command of kCopyCommands) {
          const text = await query(client, [command, 1]);
          if (text !== before.get(command)) errors.push(`${command} cycle ${cycle}: ${text}`);
        }
      }
      const growth = processGuiResources(proc.pid!).handles - handles;
      if (growth > kHandleTolerance) errors.push(`clone handles grew by ${growth}`);
      if (action !== "delete") {
        const alias = join(dir, "alias.pdf");
        linkSync(moved, alias);
        for (const target of [moved, alias]) {
          const copy = client.request(ControlCommand.TestSaveFileAs, [target]);
          const dialog = await Promise.race([copy.then(() => 0), waitForTopWindow(proc.pid!, "#32770", 5000)]);
          if (dialog) postMessage(dialog, WM_CLOSE, 0, 0);
          const result = await copy;
          if (result[0] !== 0 || !readFileSync(target).equals(original)) errors.push(`copy onto source: ${result}`);
        }
      }
      if (errors.length) throw new Error(`${size} ${action}: ${errors.join("; ")}`);
    },
    ["-appdata", appdata, "-log-to-file", join(dir, "app.log"), "-view", "single page", "-page", "2", path],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  console.log(`${size} ${action}: clone, editor and source copy retained the open document`);
}

export async function testit(): Promise<void> {
  const errors: string[] = [];
  for (const size of ["small", "big"] as const) {
    for (const action of ["rename", "replace", "delete"] as const) {
      try {
        await check(size, action);
      } catch (error) {
        errors.push(String(error));
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
