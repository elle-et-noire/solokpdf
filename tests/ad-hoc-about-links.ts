import assert from "node:assert/strict";
import { ControlCommand } from "./control.ts";
import { cmdId, pollUntil, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled, sendCommand } from "./win-automation.ts";
import { isWindowVisible, postMessage, waitForTopWindow, WM_CLOSE } from "./winapi.ts";

const aboutClass = "SUMATRA_PDF_ABOUT";
const repo = "https://github.com/elle-et-noire/solokpdf";
const upstream = "https://www.sumatrapdfreader.org";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = writeAppdata("about-links", "UiLanguage = en\nRestoreSession = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", dir]);
  try {
    for (let i = 0; i < 2; i++) {
      sendCommand(frame, cmdId("CmdHelpAbout"));
      const hwnd = await waitForTopWindow(proc.pid, aboutClass);
      assert.ok(hwnd, "About window did not open");
      const [code, text] = await client.request(ControlCommand.TestVirtTree, ["about-links"]);
      assert.equal(code, 0);
      const lines = String(text).trimEnd().split("\n");
      if (i === 0 && lines.some((line) => line.startsWith("manual\tSumatraPDF manual\t"))) {
        console.log("About links: SolokPDF required");
        return;
      }
      assert.ok(lines.includes(`source\tGitHub repository\t${repo}`));
      assert.ok(lines.includes(`licenses\tVarious Open Source\t${repo}/blob/solokpdf-dev/AUTHORS`));
      assert.ok(
        lines.some(
          (line) => line.startsWith("based on SumatraPDF ") && line.endsWith(`\tSumatraPDF website\t${upstream}/`),
        ),
      );
      assert.ok(lines.includes(`\tSumatraPDF manual\t${upstream}/docs/SumatraPDF-documentation`));
      postMessage(hwnd, WM_CLOSE, 0, 0);
      await pollUntil(() => !isWindowVisible(hwnd), Boolean, { error: "About did not close" });
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
