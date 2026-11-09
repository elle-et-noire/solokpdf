// Saving Advanced Settings while the home page is showing used to crash:
// ReloadSettings destroyed homeRoot after LoadSettings had already rebuilt
// the layout cache, so DrawHomePage painted a null VirtRoot.
//
// Run: bun tests/adv-settings-home-reload.ts [--no-build]

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, cmdId, runStandalone, tmpPath, SETTINGS_FILE } from "./util.ts";
import { sleep } from "./winapi.ts";
import { killAndWait, launchControlled, sendCommandSync, waitForExit } from "./win-automation.ts";
import { ControlCommand, type ControlClient } from "./control.ts";

async function adv(client: ControlClient, action: string, arg = 0): Promise<string> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const res = await client.request(ControlCommand.TestAdvSettingsRows, [action, arg]);
    const exitCode = res[0] as number;
    const out = String(res[1] ?? "");
    if (exitCode === 0) {
      return out;
    }
    if (exitCode !== 2) {
      throw new Error(`adv-settings-home-reload: TestAdvSettingsRows(${action}) failed: ${out.trim()}`);
    }
    await sleep(50);
  }
  throw new Error(`adv-settings-home-reload: Advanced Settings never ready for ${action}`);
}

async function testMode(mode: "testing" | "saved"): Promise<void> {
  const appdata = tmpPath(`adv-settings-home-reload-${mode}`);
  rmSync(appdata, { recursive: true, force: true });
  mkdirSync(appdata, { recursive: true });
  const pdf = join(appdata, "doc.pdf");
  copyFileSync(join(ROOT, "ext", "a-zlib", "zlib.3.pdf"), pdf);
  const settingsPath = join(appdata, SETTINGS_FILE);
  writeFileSync(
    settingsPath,
    `UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = true\nShowStartPage = true\nFileStates [\n\t[\n\t\tFilePath = ${pdf}\n\t\tOpenCount = 1\n\t]\n]\n`,
  );
  const original = readFileSync(settingsPath, "utf8");
  const modified = statSync(settingsPath).mtimeMs;

  const { proc, client, frame } = await launchControlled(["-appdata", appdata], { saveSettings: mode === "saved" });
  try {
    const homeDeadline = Date.now() + 8000;
    let home = await client.homeSelection();
    while (!home.ready && Date.now() < homeDeadline) {
      await sleep(50);
      home = await client.homeSelection();
    }
    if (!home.ready) {
      throw new Error(`adv-settings-home-reload: home page never ready (${home.raw})`);
    }

    sendCommandSync(frame, cmdId("CmdAdvancedSettings"));
    const toggled = await adv(client, "toggle", 0);
    if (!toggled.includes("toggled=DisableJavaScript changed=1")) {
      throw new Error(`adv-settings-home-reload: unexpected toggle: ${toggled.trim()}`);
    }
    const saved = await adv(client, "save");
    if (!saved.includes("saved=1")) {
      throw new Error(`adv-settings-home-reload: save failed: ${saved.trim()}`);
    }

    const ping = await client.request(ControlCommand.Ping);
    if (ping[0] !== "pong") {
      throw new Error(`adv-settings-home-reload: ping after save: ${JSON.stringify(ping)}`);
    }

    const afterDeadline = Date.now() + 8000;
    let after = await client.homeSelection();
    while (!after.ready && Date.now() < afterDeadline) {
      await sleep(50);
      after = await client.homeSelection();
    }
    if (!after.ready) {
      throw new Error(`adv-settings-home-reload: home page not ready after save (${after.raw})`);
    }

    sendCommandSync(frame, cmdId("CmdAdvancedSettings"));
    const values = await adv(client, "nondefault");
    if (!values.includes("DisableJavaScript=true default=false")) {
      throw new Error(`adv-settings-home-reload: saved change reverted (${mode})`);
    }
    await adv(client, "esc");
    await client.quit();
    if (!(await waitForExit(proc))) {
      throw new Error("adv-settings-home-reload: app did not exit");
    }
    if (mode === "testing") {
      if (readFileSync(settingsPath, "utf8") !== original || statSync(settingsPath).mtimeMs !== modified) {
        throw new Error("adv-settings-home-reload: -for-testing wrote settings");
      }
    } else if (!/DisableJavaScript\s*=\s*true\b/.test(readFileSync(settingsPath, "utf8"))) {
      throw new Error("adv-settings-home-reload: normal run did not save DisableJavaScript");
    }
    console.log(`adv-settings-home-reload: OK (${mode})`);
  } finally {
    client.close();
    await killAndWait(proc);
    rmSync(appdata, { recursive: true, force: true });
  }
}

export async function testit(): Promise<void> {
  await testMode("testing");
  await testMode("saved");
}

if (import.meta.main) {
  await runStandalone(testit);
}
