import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdId, makeTopBottomPdf, runStandalone, tmpPath } from "./util.ts";
import { ControlCommand } from "./control.ts";
import { killAndWait, launchControlled, sendCommand, waitToolWindow } from "./win-automation.ts";
import { sleep } from "./winapi.ts";

export async function testit(): Promise<void> {
  const dir = tmpPath("restore-session-option");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SolokPDF-settings.txt");
  writeFileSync(
    path,
    "UiLanguage = en\nCheckForUpdates = false\nRememberOpenedFiles = false\nRestoreSession = false\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir], { saveSettings: true });
  try {
    sendCommand(frame, cmdId("CmdOptions"));
    const dialog = await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" });
    if (!dialog) throw new Error("Settings dialog did not open");

    const toggle = async (idx: number) => {
      const res = await client.request(ControlCommand.TestAdvSettingsRows, ["toggle-common", idx]);
      return String(res[1]);
    };
    if (!(await toggle(7)).includes("RestoreSession=false"))
      throw new Error("Restore option changed while file history was disabled");
    if (!(await toggle(6)).includes("RememberOpenedFiles=true")) throw new Error("File history did not enable");
    if (!(await toggle(7)).includes("RestoreSession=true")) throw new Error("Restore option did not toggle");
    if (!(await toggle(6)).includes("RememberOpenedFiles=false")) throw new Error("File history did not disable");
    if (!(await toggle(7)).includes("RestoreSession=true"))
      throw new Error("Restore option changed while file history was disabled");
    await toggle(6);
    await client.request(ControlCommand.TestAdvSettingsRows, ["save", 0]);
    await sleep(500);

    const saved = readFileSync(path, "utf8");
    if (!/RememberOpenedFiles\s*=\s*true/.test(saved) || !/RestoreSession\s*=\s*true/.test(saved)) {
      throw new Error(`Settings were not saved:\n${saved}`);
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }

  const pdf = tmpPath("restore-session-option.pdf");
  writeFileSync(pdf, makeTopBottomPdf(2));
  const opened = await launchControlled(["-appdata", dir, pdf], { saveSettings: true });
  try {
    await opened.client.waitForRenderIdle();
  } finally {
    await opened.client.quit().catch(() => {});
    await killAndWait(opened.proc);
  }

  const withSession = readFileSync(path, "utf8");
  if (!withSession.includes("SessionData")) throw new Error("Session data was not saved");
  writeFileSync(path, withSession.replace(/RememberOpenedFiles\s*=\s*true/, "RememberOpenedFiles = false"));
  const noHistory = await launchControlled(["-appdata", dir], { saveSettings: true });
  try {
    await noHistory.client.waitForSessionRestored();
    const tab = await noHistory.client.request(ControlCommand.TestCurrentTab, []);
    if (String(tab[1]).includes(pdf)) throw new Error("Session restored while file history was disabled");
  } finally {
    await noHistory.client.quit().catch(() => {});
    await killAndWait(noHistory.proc);
  }
}

if (import.meta.main) await runStandalone(testit);
