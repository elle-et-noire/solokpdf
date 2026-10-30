// Use-after-free of a lazy tab's TabState (crash 2026-09-16-01-15-62d8).
//
// A lazily restored tab borrows its TabState from gInitialSessionData. With
// RememberOpenedFiles = false, RememberSessionState() frees gSettings->sessionData
// and returns early, so SyncInitialSessionData() frees the snapshot and clones
// nothing: RefreshLazyTabStatePointers() has nothing to repoint to and every lazy
// tab keeps a freed pointer. Selecting that tab loads it and SetTabState() reads
// the freed TabState (crash in ParseStoredPagePos).
//
// Uses a scratch -appdata dir and no -for-testing, so the session is restored and
// ScheduleSaveSettings() is not suppressed. Restoring needs RememberOpenedFiles,
// so it is turned off after the restore by rewriting the settings file, like
// unchecking "Remember opened files" in Settings.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cmdId, pollUntil, runStandalone, SETTINGS_FILE, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";
import { killAndWait, killProcessesNamed, launchControlled, sendCommandSync } from "./win-automation.ts";
import { sleep } from "./winapi.ts";

const LAZY_PDF = resolve("tests/issue-1189.pdf");
const LOADED_PDF = resolve("tests/issue-6095.epub");

const APPDATA = tmpPath("lazy-tab-state-after-save-appdata");
const SETTINGS_PATH = join(APPDATA, SETTINGS_FILE);
const LOG_PATH = join(APPDATA, "log.txt");

function settingsText(rememberOpenedFiles: boolean): string {
  const tabState = (path: string) => `      [
        FilePath = ${path}
        DisplayMode = single page
        PageNo = 1
        Zoom = fit page
        Rotation = 0
        ScrollPos = -1 -1
        ShowToc = false
      ]`;
  // RememberOpenedFiles = false is what makes the save drop the whole session
  return `UiLanguage = en
CheckForUpdates = false
RestoreSession = true
LazyLoading = true
UseTabs = true
RememberOpenedFiles = ${rememberOpenedFiles}
RememberStatePerDocument = true
ReuseInstance = false
SessionData [
  [
    TabStates [
${tabState(LAZY_PDF)}
${tabState(LOADED_PDF)}
    ]
    TabIndex = 2
    WindowState = 1
    WindowPos = 100 100 800 600
  ]
]
`;
}

function loadCount(): number {
  try {
    return readFileSync(LOG_PATH, "utf8").split("LoadSettings(").length - 1;
  } catch {
    return 0;
  }
}

function waitForLoads(n: number): Promise<number> {
  return pollUntil(loadCount, (count) => count >= n, {
    timeoutMs: 10000 * SLOW_BUILD_FACTOR,
    error: (count) => `lazy-tab-state-after-save: ${count} settings loads, want ${n}`,
  });
}

export async function testit(): Promise<void> {
  await killProcessesNamed("SumatraPDF.exe");
  rmSync(APPDATA, { recursive: true, force: true });
  mkdirSync(APPDATA, { recursive: true });
  writeFileSync(SETTINGS_PATH, settingsText(true), "utf8");
  const { proc, client, frame } = await launchControlled(["-appdata", APPDATA, "-log-to-file", LOG_PATH], {
    saveSettings: true,
  });
  try {
    await client.waitForSessionRestored(30000);
    await client.waitForRenderIdle(30000);

    // the settings watcher reloads the file with opened-file memory off
    const before = loadCount();
    writeFileSync(SETTINGS_PATH, settingsText(false), "utf8");
    await waitForLoads(before + 1);

    // frees gInitialSessionData; the still-lazy first tab borrows from it
    sendCommandSync(frame, cmdId("CmdToggleFavoritesSort"));
    const saveDeadline = Date.now() + 5000 * SLOW_BUILD_FACTOR;
    let previous = "";
    let saved = false;
    while (Date.now() < saveDeadline) {
      const current = readFileSync(SETTINGS_PATH, "utf8");
      if (current === previous && !current.includes(`FilePath = ${LAZY_PDF}`)) {
        saved = true;
        break;
      }
      previous = current;
      await sleep(50);
    }
    if (!saved) {
      throw new Error("lazy-tab-state-after-save: settings save did not drop session data");
    }

    // selecting the lazy tab loads it and reads its TabState
    sendCommandSync(frame, cmdId("CmdPrevTab"));
    await client.waitForRenderIdle(30000);

    await client.quit();
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`lazy-tab-state-after-save: exit code ${exitCode}, want 0`);
    }
  } finally {
    await killProcessesNamed("SumatraPDF.exe");
    rmSync(APPDATA, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
