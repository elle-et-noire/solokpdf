import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdId, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, sendCommand, waitToolWindow } from "./win-automation.ts";

export async function testit(): Promise<void> {
  const dir = tmpPath("keyboard-help-content");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", dir]);
  try {
    sendCommand(frame, cmdId("CmdToggleKeyboardHelp"));
    const help = await waitToolWindow(client, proc.pid!, "keyboard-help", { title: "Keyboard Shortcuts" });
    if (!help) throw new Error("Keyboard help did not open");

    const labels = (await client.virtTree()).filter((row) => row.hwnd === help).map((row) => row.text);
    if (!labels.includes("Type a count before a scroll or page key (e.g. 3j).")) {
      throw new Error("Count prefix is absent from keyboard help");
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
