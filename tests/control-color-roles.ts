// A control's color role is an input to theme application (E107, E108): a
// refresh that only calls UpdateTheme() keeps Advanced Settings' value edit on
// the selected step, its muted labels follow a previewed theme, and Run PDF
// Script's output keeps its muted text.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlClient, ControlCommand } from "./control.ts";
import { cmdId, pollUntil, runStandalone, tmpPath, SETTINGS_FILE, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, sendCommand, sendCommandSync } from "./win-automation.ts";

const PDF = resolve(import.meta.dir, "issue-1189.pdf");

// dark, so the muted text and the selected step differ from the plain ones
const SETTINGS = `UiLanguage = en
Theme = Dark
CheckForUpdates = false
RestoreSession = false
RememberOpenedFiles = false
`;

function col(raw: string, name: string): string | undefined {
  return new RegExp(`\\b${name}=([0-9a-f]{6})`).exec(raw)?.[1];
}

async function advSettings(client: ControlClient, action: string): Promise<string> {
  const res = await client.request(ControlCommand.TestAdvSettingsRows, [action]);
  return String(res[1] ?? "");
}

async function checkAdvSettings(client: ControlClient, frame: number): Promise<void> {
  sendCommandSync(frame, cmdId("CmdAdvancedSettings"));
  await pollUntil(
    () => advSettings(client, "edit"),
    (s) => s.includes("editing=1"),
    { error: (s) => `control-color-roles: no value edit: ${s}` },
  );
  const onSelected = (s: string) => !!col(s, "selected") && col(s, "editBg") === col(s, "selected");
  const created = await advSettings(client, "colors");
  if (!onSelected(created)) {
    throw new Error(`control-color-roles: value edit not on the selected step: ${created}`);
  }
  const refreshed = await advSettings(client, "update-theme");
  if (!onSelected(refreshed)) {
    throw new Error(`control-color-roles: UpdateTheme() repainted the value edit: ${refreshed}`);
  }
  await advSettings(client, "cancel");
}

// E108: the muted labels follow a previewed theme
async function checkAdvPreview(client: ControlClient, frame: number): Promise<void> {
  sendCommandSync(frame, cmdId("CmdAdvancedSettings"));
  await pollUntil(
    () => advSettings(client, "state"),
    (s) => s.includes("editing="),
    { error: (s) => `control-color-roles: no advanced settings: ${s}` },
  );
  const before = await advSettings(client, "label-colors");
  await advSettings(client, "preview-light");
  const after = await advSettings(client, "label-colors");
  await advSettings(client, "cancel");
  const muted = col(after, "muted");
  if (!muted || muted === col(before, "muted")) {
    throw new Error(`control-color-roles: preview kept the muted color: ${before} -> ${after}`);
  }
  for (const name of ["count", "default", "comment"]) {
    if (col(after, name) !== muted) {
      throw new Error(`control-color-roles: ${name} not in the previewed muted color: ${after}`);
    }
  }
}

async function checkScriptOutput(client: ControlClient, frame: number): Promise<void> {
  sendCommand(frame, cmdId("CmdRunPDFScript"));
  const raw = await pollUntil(
    async () => String((await client.request(ControlCommand.TestPdfScript, ["colors", -1]))[1] ?? ""),
    (s) => s.startsWith("OK"),
    { error: (s) => `control-color-roles: no script dialog: ${s}` },
  );
  if (!col(raw, "muted") || col(raw, "outputText") !== col(raw, "muted")) {
    throw new Error(`control-color-roles: script output not muted: ${raw}`);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP control-color-roles: Win32 controls");
    return;
  }
  const dir = tmpPath("control-color-roles");
  rmSync(dir, { recursive: true, force: true });
  const appdata = join(dir, "appdata");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), SETTINGS);

  const { proc, client, frame } = await launchControlled(["-appdata", appdata, PDF]);
  try {
    await client.waitForRenderIdle();
    await checkAdvSettings(client, frame);
    await checkAdvPreview(client, frame);
    await checkScriptOutput(client, frame);
    console.log("control-color-roles: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
