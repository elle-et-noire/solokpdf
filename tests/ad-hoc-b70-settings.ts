import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, makeTopBottomPdf, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, sendCommand, waitToolWindow } from "./win-automation.ts";
import { enumChildWindows, getClassName, getFocusedHwnd, postMessage, sendText, sleep, WM_KEYDOWN } from "./winapi.ts";

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

async function pressSettings(client: ControlClient, pid: number, frame: number): Promise<void> {
  const focus = getFocusedHwnd(frame);
  if (!focus) throw new Error("No focused control for Ctrl+,");
  await client.request(ControlCommand.TestFocusState, ["ctrl-down"]);
  postMessage(focus, WM_KEYDOWN, 0xbc, 0);
  await sleep(150);
  await client.request(ControlCommand.TestFocusState, ["ctrl-up"]);
  if (!(await waitToolWindow(client, pid, "advanced-settings"))) throw new Error("Ctrl+, did not open settings");
  await adv(client, "cancel");
  await sleep(100);
}

async function check(engine: string): Promise<void> {
  const dir = tmpPath(`b70-settings-${engine}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "history.pdf");
  const pdf2 = join(dir, "second.pdf");
  const settings = join(dir, SETTINGS_FILE);
  writeFileSync(pdf, makeTopBottomPdf(1));
  writeFileSync(
    pdf2,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
      "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
    "latin1",
  );
  writeFileSync(
    settings,
    `UiLanguage = en\nCheckForUpdates = false\nRememberOpenedFiles = true\nRestoreSession = false\nEnableTeXEnhancements = true\nVimKeys = true\nShowCaption = true\nFileStates [\n  [\n    FilePath = ${pdf}\n    OpenCount = 1\n  ]\n]\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf, pdf2], {
    saveSettings: true,
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    if ((await client.layout()).items.tabs?.visible !== true) throw new Error("Initial tab bar was not visible");
    const edit = await client.setFormField(1, 0, "unsaved");
    if (edit[0] !== 0) throw new Error(`Could not create unsaved edit: ${edit[1]}`);
    sendCommand(frame, cmdId("CmdZoomIn"));
    await sleep(150);
    const initialView = String((await client.request(ControlCommand.TestScrollState, []))[1]);
    await client.request(ControlCommand.TestFocusState, ["activate"]);
    await pressSettings(client, proc.pid!, frame);
    sendCommand(frame, cmdId("CmdFindFirst"));
    await sleep(200);
    if (getClassName(getFocusedHwnd(frame)) !== "Edit") throw new Error("Find box was not focused");
    await pressSettings(client, proc.pid!, frame);
    await client.request(ControlCommand.TestFocusState, ["page-edit"]);
    if (getClassName(getFocusedHwnd(frame)) !== "Edit") throw new Error("Page box was not focused");
    await pressSettings(client, proc.pid!, frame);
    for (const name of ["CmdOptions", "CmdAdvancedSettings"]) {
      const visibility = await client.request(ControlCommand.TestCommandVisibility, [name, "palette"]);
      if (!String(visibility[1]).includes("vis=show"))
        throw new Error(`${name} missing from palette: ${visibility[1]}`);
    }
    const binding = await client.request(ControlCommand.TestShortcutsDialog, ["resolve", "", "ctrl+,"]);
    if (binding[1] !== "CmdOptions") throw new Error(`Ctrl+, resolved to ${binding[1]}`);
    const pressed = await client.request(ControlCommand.TestShortcutsDialog, ["press", "", "ctrl+,"]);
    if (pressed[1] !== "CmdOptions") throw new Error(`Ctrl+, ran ${pressed[1]}`);
    let dialog = await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" });
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
    const editors = (await adv(client, "choices", 8)).trim().split("\n").filter(Boolean);
    if (!editors.length) console.log("No detected inverse-search editor; detected-editor check skipped");
    if (editors.length && !(await adv(client, "common-values")).includes(`InverseSearchCmdLine=${editors[0]}\n`))
      throw new Error("Detected editor is not displayed before opening its dropdown");
    await adv(client, "test-editor");
    if (!(await adv(client, "common-values")).includes("InverseSearchCmdLine=test-detected-editor %f:%l\n"))
      throw new Error("Detected editor was not displayed");
    if (!(await adv(client, "choices", 8)).startsWith("test-detected-editor %f:%l\n"))
      throw new Error("Detected editor was not offered");
    await adv(client, "save");
    await saved(settings, /InverseSearchCmdLine\s*=\s*test-detected-editor %f:%l/);
    await sleep(100);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdOptions"]);
    dialog = await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" });
    if (!dialog) throw new Error("Settings did not reopen after saving the detected editor");
    if (!(await adv(client, "toggle-common", 2)).includes("ShowToc=false")) throw new Error("ShowToc did not toggle");
    if (!(await adv(client, "toggle-common", 3)).includes("RememberStatePerDocument=false"))
      throw new Error("Per-document state did not toggle");
    await adv(client, "cancel");
    await sleep(100);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdOptions"]);
    dialog = await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" });
    if (!dialog) throw new Error("Settings did not reopen after Cancel");
    if (!(await adv(client, "toggle-common", 2)).includes("ShowToc=false"))
      throw new Error("Cancel did not restore ShowToc");
    if (!(await adv(client, "toggle-common", 3)).includes("RememberStatePerDocument=false"))
      throw new Error("Cancel did not restore per-document state");
    await adv(client, "toggle-common", 2);
    await adv(client, "toggle-common", 3);
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
    if (!(await adv(client, "toggle-common", 7)).includes("RestoreSession=true"))
      throw new Error("Disabled RestoreSession changed");
    if (!(await adv(client, "toggle-common", 3)).includes("RememberStatePerDocument=true"))
      throw new Error("Disabled per-document state changed");
    const disabled = await adv(client, "disabled-paths", 7);
    if (
      disabled.trim().split("\n").length < 2 ||
      disabled
        .split("\n")
        .filter(Boolean)
        .some((s) => s !== "RestoreSession=true restored=0")
    )
      throw new Error(`Disabled rows changed or restored: ${disabled}`);
    if (!(await adv(client, "toggle-common", 4)).includes("UseTabs=false")) throw new Error("UseTabs did not toggle");
    if (!(await adv(client, "type-zoom", 175)).includes("DefaultZoom=175")) throw new Error("Typed zoom did not apply");
    if (!(await adv(client, "type-zoom", 0)).includes("DefaultZoom=175"))
      throw new Error("Invalid zoom changed the value");
    if (!(await adv(client, "choose-common", 0)).includes("DefaultDisplayMode=page aspect"))
      throw new Error("Layout choice did not apply");
    if (!(await adv(client, "choose-common", 1)).includes("DefaultZoom=fit width"))
      throw new Error("Zoom choice did not apply");
    const values = await adv(client, "common-values");
    if (!values.includes("DefaultDisplayMode=Page Aspect\n") || !values.includes("DefaultZoom=Fit Width\n"))
      throw new Error(`Selected values do not match choices: ${values}`);
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
    if ((await client.layout()).items.tabs?.visible !== true)
      throw new Error("Changing UseTabs closed or converted the open tabs");
    const finalView = String((await client.request(ControlCommand.TestScrollState, []))[1]);
    if (finalView !== initialView) throw new Error(`UseTabs changed the document view: ${initialView} -> ${finalView}`);
    const retained = await client.setFormField(1, 0, "still-unsaved");
    if (retained[0] !== 0 || !String(retained[1]).includes("before='unsaved'"))
      throw new Error(`UseTabs lost the unsaved edit: ${retained[1]}`);
    const newTab = await client.request(ControlCommand.TestCommandVisibility, ["CmdNewTab", "menu"]);
    if (!String(newTab[1]).includes("vis=hide")) throw new Error(`UseTabs=false did not take effect: ${newTab[1]}`);
  } finally {
    await client.resolveUnsavedChanges("discard").catch(() => {});
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  await check("pdfium");
  await check("mupdf");
  const dir = tmpPath("b70-settings-german");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = de\nDefaultDisplayMode = continuous facing\n");
  const { proc, client, frame } = await launchControlled(["-appdata", dir], {
    env: { SUMATRA_DPI_OVERRIDE: "150" },
  });
  try {
    await client.request(ControlCommand.TestFocusState, ["activate"]);
    await pressSettings(client, proc.pid!, frame);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdOptions"]);
    if (!(await waitToolWindow(client, proc.pid!, "advanced-settings")))
      throw new Error("German settings did not open");
    const common = await adv(client, "common");
    if (common.includes("Show the bookmarks sidebar when available")) {
      if (process.env.B70_REQUIRE_TRANSLATIONS) throw new Error("German translation not loaded");
      console.log("Skipping translated settings check: no translations embedded");
    } else {
      for (const line of (await adv(client, "common-width")).trim().split("\n")) {
        const match = /^(\S+) (\d+) (\d+)$/.exec(line);
        if (!match || Number(match[2]) > Number(match[3])) throw new Error(`Clipped German label at 150%: ${line}`);
      }
      const choices = (await adv(client, "choices", 0)).split("\n");
      const values = await adv(client, "common-values");
      if (!choices[5] || choices[5] === "Continuous Facing" || !values.includes(`DefaultDisplayMode=${choices[5]}\n`))
        throw new Error(`Translated selection differs from dropdown: ${values}`);
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
  const customDir = tmpPath("b70-custom-shortcut");
  mkdirSync(customDir, { recursive: true });
  writeFileSync(
    join(customDir, SETTINGS_FILE),
    "UiLanguage = en\nShortcuts [\n [\n  Cmd = CmdOptions\n  Key = Ctrl+F12\n ]\n]\n",
  );
  const custom = await launchControlled(["-appdata", customDir]);
  try {
    const binding = await custom.client.request(ControlCommand.TestShortcutsDialog, ["resolve", "", "ctrl+f12"]);
    if (binding[1] !== "CmdOptions") throw new Error(`Custom settings shortcut resolved to ${binding[1]}`);
    sendCommand(custom.frame, cmdId("CmdToggleKeyboardHelp"));
    const help = await waitToolWindow(custom.client, custom.proc.pid!, "keyboard-help", {
      title: "Keyboard Shortcuts",
    });
    if (!help) throw new Error("Keyboard help did not open");
    const row = await custom.client.request(ControlCommand.TestShortcutsDialog, ["help", "CmdOptions"]);
    if (!String(row[1]).includes("listed=1") || !/F12/i.test(String(row[1])))
      throw new Error(`Settings shortcut is missing from keyboard help: ${row[1]}`);
  } finally {
    await custom.client.quit().catch(() => {});
    await killAndWait(custom.proc);
  }
}

if (import.meta.main) await runStandalone(testit);
