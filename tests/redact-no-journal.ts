import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("redact-no-journal");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nRestoreSession = false\nCheckForUpdates = false\n");
  const pdf = join(dir, "redact.pdf");
  const content = "BT /F1 24 Tf 72 650 Td (SECRET) Tj ET";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>",
      "<< /Type /Annot /Subtype /Redact /P 3 0 R /Rect [72 600 300 700] >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
    "latin1",
  );
  for (const engine of ["mupdf", "pdfium"]) {
    const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
      env: { SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_NO_JOURNAL: "1" },
    });
    try {
      await client.waitForRenderIdle();
      if ((await client.request(ControlCommand.TestCurrentPdf, ["redact-faults"]))[1] !== "supported") {
        console.log("SKIP redact-no-journal: Debug fault injection unavailable");
        return;
      }
      const before = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
      if (!/annotations=1\b/.test(before) || !/type=Redact\b/.test(before)) {
        throw new Error(`${engine}: missing redaction before apply\n${before}`);
      }
      sendCommandSync(frame, cmdId("CmdApplyRedactions"));
      const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
      if (
        !/annotations=1\b/.test(raw) ||
        !/type=Redact\b/.test(raw) ||
        !/page1text=.*SECRET/.test(raw) ||
        !/canUndo=0 canRedo=0 modified=0/.test(raw) ||
        !/actionNotification=Failed to apply redactions/.test(raw)
      ) {
        throw new Error(`${engine}: redaction changed without a journal\n${raw}`);
      }
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
