import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { makeTopBottomPdf, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, waitToolWindow } from "./win-automation.ts";
import { enumChildWindows, getClassName, sendText, sleep } from "./winapi.ts";

async function adv(client: ControlClient, action: string, arg = 0): Promise<string> {
  const res = await client.request(ControlCommand.TestAdvSettingsRows, [action, arg]);
  if (res[0] !== 0) throw new Error(`${action}: ${res[1]}`);
  return String(res[1]);
}

async function saved(path: string, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const text = readFileSync(path, "utf8");
    if (pattern.test(text)) return text;
    await sleep(50);
  }
  throw new Error(`Settings were not saved: ${readFileSync(path, "utf8")}`);
}

async function check(engine: string): Promise<void> {
  const dir = tmpPath(`b70-settings-${engine}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "history.pdf");
  const settings = join(dir, SETTINGS_FILE);
  writeFileSync(pdf, makeTopBottomPdf(1));
  writeFileSync(
    settings,
    `UiLanguage = en\nCheckForUpdates = false\nRememberOpenedFiles = true\nRestoreSession = false\nEnableTeXEnhancements = true\nVimKeys = true\nShowCaption = true\nFileStates [\n  [\n    FilePath = ${pdf}\n    OpenCount = 1\n  ]\n]\n`,
  );
  const { proc, client } = await launchControlled(["-appdata", dir], {
    saveSettings: true,
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    if ((await client.layout()).items.tabs?.visible !== true) throw new Error("Initial tab bar was not visible");
    for (const name of ["CmdOptions", "CmdAdvancedSettings"]) {
      const visibility = await client.request(ControlCommand.TestCommandVisibility, [name, "palette"]);
      if (!String(visibility[1]).includes("vis=show"))
        throw new Error(`${name} missing from palette: ${visibility[1]}`);
    }
    const binding = await client.request(ControlCommand.TestShortcutsDialog, ["resolve", "", "ctrl+,"]);
    if (binding[1] !== "CmdOptions") throw new Error(`Ctrl+, resolved to ${binding[1]}`);
    const pressed = await client.request(ControlCommand.TestShortcutsDialog, ["press", "", "ctrl+,"]);
    if (pressed[1] !== "CmdOptions") throw new Error(`Ctrl+, ran ${pressed[1]}`);
    const dialog = await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" });
    if (!dialog) throw new Error("Settings screen did not open");

    const common = await adv(client, "common");
    if (!common.startsWith("section=Commonly used\n")) throw new Error(`Common section missing: ${common}`);
    for (const [name, label] of [
      ["DefaultDisplayMode", "Default Layout:"],
      ["DefaultZoom", "Default Zoom:"],
      ["ShowToc", "Show the bookmarks sidebar when available"],
      ["RememberStatePerDocument", "Remember these settings for each document"],
      ["UseTabs", "Use tabs"],
      ["CheckForUpdates", "Automatically check for updates"],
      ["RememberOpenedFiles", "Remember opened files"],
      ["RestoreSession", "Reopen last documents at startup"],
      ["InverseSearchCmdLine", "Set inverse search command line"],
      ["EnableTeXEnhancements", "Enable TeX enhancements"],
    ]) {
      if (!common.includes(`${name}|${label}\n`)) throw new Error(`Missing common setting ${name}: ${common}`);
    }
    if (!(await adv(client, "choices", 0)).includes("Page Aspect"))
      throw new Error("Layout choices missing Page Aspect");
    if (!(await adv(client, "choices", 1)).includes("Fit Page")) throw new Error("Zoom choices missing Fit Page");
    await adv(client, "toggle-common", 9);
    if ((await adv(client, "common")).includes("InverseSearchCmdLine"))
      throw new Error("Inverse search stayed visible with TeX enhancements off");
    await adv(client, "toggle-common", 9);
    if (!(await adv(client, "common")).includes("InverseSearchCmdLine"))
      throw new Error("Inverse search did not return with TeX enhancements on");

    let filter = 0;
    enumChildWindows(dialog, (hwnd) => {
      if (getClassName(hwnd) === "Edit") {
        filter = hwnd;
        return false;
      }
      return true;
    });
    if (!filter) throw new Error("Filter box missing");
    sendText(filter, "bookmarks sidebar");
    const byLabel = await adv(client, "visible");
    if (!byLabel.includes("ShowToc|Show the bookmarks sidebar when available") || !byLabel.includes("ShowToc|ShowToc"))
      throw new Error(`Translated-label filter omitted a row: ${byLabel}`);
    sendText(filter, "ShowToc");
    if (!(await adv(client, "visible")).includes("ShowToc|Show the bookmarks sidebar when available"))
      throw new Error("Raw-name filter omitted the common row");
    sendText(filter, "");

    await adv(client, "esc");
    await sleep(100);
    const vim = await client.request(ControlCommand.TestVimKeys, ["key", "Ctrl+,"]);
    if (vim[0] !== 0) throw new Error(`Vim Ctrl+, failed: ${vim[1]}`);
    if (!(await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" })))
      throw new Error("Vim Ctrl+, did not open the settings screen");
    await adv(client, "esc");
    await sleep(100);
    const advanced = await client.request(ControlCommand.TestInvokeCommand, ["CmdAdvancedSettings"]);
    if (advanced[0] !== 0) throw new Error(`CmdAdvancedSettings failed: ${advanced[1]}`);
    if (!(await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" })))
      throw new Error("CmdAdvancedSettings did not open the settings screen");

    if (!(await adv(client, "toggle-common", 7)).includes("RestoreSession=true"))
      throw new Error("RestoreSession did not toggle");
    if (!(await adv(client, "toggle-common", 6)).includes("RememberOpenedFiles=false"))
      throw new Error("RememberOpenedFiles did not toggle");
    if (!(await adv(client, "toggle-common", 4)).includes("UseTabs=false")) throw new Error("UseTabs did not toggle");
    if (!(await adv(client, "choose-common", 0)).includes("DefaultDisplayMode=page aspect"))
      throw new Error("Layout choice did not apply");
    if (!(await adv(client, "choose-common", 1)).includes("DefaultZoom=fit width"))
      throw new Error("Zoom choice did not apply");
    if (!(await adv(client, "choose-common", 8)).includes("InverseSearchCmdLine=test-editor %f:%l"))
      throw new Error("Inverse search text did not apply");
    await adv(client, "save");
    const text = await saved(settings, /RememberOpenedFiles\s*=\s*false/);
    if (!/RestoreSession\s*=\s*true/.test(text)) throw new Error("RestoreSession was not saved");
    if (!/UseTabs\s*=\s*false/.test(text)) throw new Error("UseTabs was not saved");
    if (!/DefaultDisplayMode\s*=\s*page aspect/.test(text)) throw new Error("Layout was not saved");
    if (!/DefaultZoom\s*=\s*fit width/.test(text)) throw new Error("Zoom was not saved");
    if (!/InverseSearchCmdLine\s*=\s*test-editor %f:%l/.test(text)) throw new Error("Inverse search was not saved");
    if (text.includes(pdf)) throw new Error("Disabling history did not clear FileStates");
    const newTab = await client.request(ControlCommand.TestCommandVisibility, ["CmdNewTab", "menu"]);
    if (!String(newTab[1]).includes("vis=hide")) throw new Error(`UseTabs=false did not take effect: ${newTab[1]}`);
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  await check("pdfium");
  await check("mupdf");
}

if (import.meta.main) await runStandalone(testit);
