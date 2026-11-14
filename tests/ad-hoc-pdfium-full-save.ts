import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, EXE, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { FRAME_CLASS, sendCommandSync } from "./win-automation.ts";
import { waitForTopWindow } from "./winapi.ts";

const kSecret = "SECRETWORD";
const kKeep = "KEEPWORD";

type PdfSize = "small" | "big";

function fixture(size: PdfSize): Buffer {
  const content = `BT /F1 24 Tf 72 700 Td (${kSecret} ${kKeep}) Tj ET`;
  const second = "BT /F1 24 Tf 72 700 Td (SECOND PAGE) Tj ET";
  return Buffer.from(
    assemblePdf(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 2 /Kids [3 0 R 7 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Annot /Subtype /Redact /P 3 0 R /Rect [66 690 247 725] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R /Annots [9 0 R] >>",
        `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
        "<< /Type /Annot /Subtype /Square /P 7 0 R /Rect [72 500 200 600] /Contents (ORIGINAL) >>",
      ],
      { header: `%PDF-1.7\n%${"x".repeat(size === "big" ? 33 * 1024 * 1024 : 256 * 1024)}\n` },
    ),
    "latin1",
  );
}

async function state(client: ControlClient): Promise<string> {
  return String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
}

function applied(raw: string, status: "dirty" | "clean"): void {
  if (
    !raw.includes(`modified=${status === "dirty" ? 1 : 0}`) ||
    /page1text=.*SECRETWORD/.test(raw) ||
    !/page1text=.*KEEPWORD/.test(raw)
  )
    throw new Error(`Wrong redacted document state: ${raw}`);
}

async function check(engine: string, size: PdfSize): Promise<void> {
  const label = `${engine}-${size}`;
  const dir = tmpPath(`full-pdf-save/${label}`);
  const appdata = join(dir, "settings");
  mkdirSync(appdata, { recursive: true });
  const source = join(dir, "source.pdf");
  const original = fixture(size);
  writeFileSync(source, original);
  writeFileSync(join(appdata, SETTINGS_FILE), "UiLanguage = en\nReloadModifiedDocuments = false\n");
  const ran = await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      if ((await client.request(ControlCommand.TestCurrentPdf, ["save-faults"]))[1] !== "supported") {
        console.log("SKIP full-pdf-save: Debug fault injection unavailable");
        return false;
      }
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      await state(client);
      sendCommandSync(frame, cmdId("CmdApplyRedactions"));
      applied(await state(client), "dirty");
      const before = readdirSync(dir).sort().join("\n");
      const failed = await client.request(ControlCommand.TestCurrentPdf, ["save-result"]);
      if (!existsSync(source) || !readFileSync(source).equals(original))
        throw new Error(`${label}: failed full save destroyed the original`);
      if (
        !String(failed[1]).includes("saved=0 message=Failed to save") ||
        !String(failed[1]).includes("injected full-save")
      )
        throw new Error(`${label}: no save failure reported: ${failed[1]}`);
      applied(await state(client), "dirty");
      const afterFailure = readdirSync(dir).sort().join("\n");
      if (afterFailure !== before)
        throw new Error(`${label}: temporary output leaked\nbefore:\n${before}\nafter:\n${afterFailure}`);

      chmodSync(source, 0o444);
      try {
        const denied = await client.request(ControlCommand.TestCurrentPdf, ["save-result"]);
        if (
          !String(denied[1]).includes("saved=0 message=Failed to save") ||
          !existsSync(source) ||
          !readFileSync(source).equals(original)
        )
          throw new Error(`${label}: publication failure lost the original: ${denied[1]}`);
        applied(await state(client), "dirty");
      } finally {
        chmodSync(source, 0o666);
      }
      if (readdirSync(dir).sort().join("\n") !== before) throw new Error(`${label}: publication temp leaked`);

      const saved = await client.request(ControlCommand.TestCurrentPdf, ["save-result"]);
      if (!String(saved[1]).includes("saved=1")) throw new Error(`${label}: retry failed: ${saved[1]}`);
      await client.waitForRenderIdle();
      applied(await state(client), "clean");
      if (readFileSync(source).equals(original)) throw new Error(`${label}: successful save did not write`);
      sendCommandSync(frame, cmdId("CmdGoToNextPage"));
      await client.waitForRenderIdle();
      const second = await client.request(ControlCommand.TestCurrentPdf, ["cached-text", 2]);
      if (!String(second[1]).includes("SECOND PAGE")) throw new Error(`${label}: tab lost unread page: ${second[1]}`);
      const edited = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "AFTER SAVE"]);
      if (!String(edited[1]).includes("changed=1")) throw new Error(`${label}: tab cannot edit: ${edited[1]}`);
      const again = await client.request(ControlCommand.TestCurrentPdf, ["save-result"]);
      if (!String(again[1]).includes("saved=1")) throw new Error(`${label}: second save failed: ${again[1]}`);
      const reopened = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "AFTER SAVE"]);
      if (!String(reopened[1]).includes("before='AFTER SAVE'"))
        throw new Error(`${label}: reopen lost the edit: ${reopened[1]}`);
      if (readdirSync(dir).sort().join("\n") !== before) throw new Error(`${label}: successful save leaked temp`);
      return true;
    },
    ["-appdata", appdata, source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_SAVE_FAILURE: "f" } },
  );
  if (ran) console.log(`${label}: full save preserves source, retries and reopens`);
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  for (const engine of ["pdfium", "mupdf"]) {
    for (const size of ["small", "big"] as const) {
      if (process.env.FULL_SAVE_CASE && process.env.FULL_SAVE_CASE !== `${engine}-${size}`) continue;
      await check(engine, size);
    }
  }
}

export async function testQuick(): Promise<void> {
  if (!USE_NG) await check("pdfium", "small");
}

if (import.meta.main) await runStandalone(testit);
