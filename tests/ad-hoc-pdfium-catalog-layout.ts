import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  const dir = tmpPath("pdfium-catalog-layout");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "layout.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /PageLayout /TwoColumnRight /ViewerPreferences << /Direction /R2L >> >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]),
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = false\nDefaultDisplayMode = automatic\n",
  );
  await withControlledSumatra(
    EXE,
    async (client) => {
      const mode = await client.request(ControlCommand.TestDisplayMode, ["get"]);
      const direction = await client.request(ControlCommand.TestDisplayMode, ["r2l"]);
      const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (!String(mode[1]).includes("mode=continuous book view") || !String(direction[1]).includes("r2l=1")) {
        throw new Error(`catalog layout: ${mode[1]}, ${direction[1]}`);
      }
      if (editor[1] !== "editor=none") throw new Error(`catalog layout loaded editor: ${editor[1]}`);
    },
    ["-appdata", dir, pdf],
  );
}

if (import.meta.main) await runStandalone(testit);
