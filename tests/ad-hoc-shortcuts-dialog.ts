import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, runStandalone, tmpPath } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, pressKey, sendCommandSync } from "./win-automation.ts";
import { getScrollPos, postMessage, sleep, VK_F20, WM_KEYDOWN } from "./winapi.ts";
import { ControlCommand } from "./control.ts";

function makePdf(): string {
  const pages = Array.from({ length: 8 }, (_, i) => `${3 + i} 0 R`);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pages.length} >>`,
    ...pages.map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ]);
}

export async function testit(): Promise<void> {
  const dir = tmpPath("shortcuts-dialog");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "pages.pdf");
  const settings = join(dir, "SolokPDF-settings.txt");
  writeFileSync(pdf, makePdf(), "latin1");
  writeFileSync(
    settings,
    "UiLanguage = en\nReuseInstance = false\nShowStartPage = false\nSmoothScroll = false\nScrollbars = windows\n",
  );

  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-zoom", "200", "-view", "continuous", pdf],
    { saveSettings: true },
  );
  const request = async (action: string, command = "", key = "", arg = "") => {
    const res = await client.request(ControlCommand.TestShortcutsDialog, [action, command, key, arg]);
    if (res[0] !== 0) throw new Error(`${action}: ${res[1]}`);
    return String(res[1]);
  };
  // OK schedules the save on the UI queue
  const savedSettings = async (expect: RegExp) => {
    let text = readFileSync(settings, "utf8");
    for (let i = 0; i < 100 && !expect.test(text); i++) {
      await sleep(20);
      text = readFileSync(settings, "utf8");
    }
    return text;
  };
  const waitClosed = async () => {
    for (let i = 0; i < 50; i++) {
      const res = await client.request(ControlCommand.TestShortcutsDialog, ["state"]);
      if (res[1] === "no dialog") return;
      await sleep(20);
    }
    throw new Error("shortcuts dialog did not close");
  };
  try {
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdCustomizeShortcuts"));
    const state = await request("state");
    const geom = /^commands=\d+ bindings=\d+ client=(\d+) list=(\d+),(\d+) ok=(\d+),(\d+)$/.exec(state);
    if (!geom || Number(geom[4]) + Number(geom[5]) > Number(geom[1])) {
      throw new Error(`dialog controls extend below window: ${state}`);
    }
    await request("add", "CmdScrollDownHalfPage", "ctrl-d");
    await request("save");
    const saved = await savedSettings(/Key\s*=\s*ctrl-d/i);
    if (!/Cmd\s*=\s*CmdScrollDownHalfPage/.test(saved) || !/Key\s*=\s*ctrl-d/i.test(saved)) {
      throw new Error(`shortcut missing from ${settings}`);
    }
    const canvas = findCanvas(frame);
    const before = getScrollPos(canvas);
    const resolved = await request("press", "", "ctrl-d");
    if (resolved !== "CmdScrollDownHalfPage" || getScrollPos(canvas) <= before) {
      throw new Error(`Ctrl+D did not scroll: command=${resolved}, before=${before}, after=${getScrollPos(canvas)}`);
    }

    await waitClosed();
    sendCommandSync(frame, cmdId("CmdCustomizeShortcuts"));
    await request("state");
    await request("add", "CmdScrollUp", "f20");
    await request("cancel");
    if (/Key\s*=\s*f20/i.test(readFileSync(settings, "utf8"))) {
      throw new Error("Cancel saved the draft binding");
    }

    await waitClosed();
    sendCommandSync(frame, cmdId("CmdCustomizeShortcuts"));
    await request("state");
    await request("reset", "CmdProperties");
    await request("save");
    if ((await request("resolve", "", "ctrl-d")) !== "CmdProperties") {
      throw new Error("Reset did not restore Ctrl+D to CmdProperties");
    }

    await waitClosed();
    sendCommandSync(frame, cmdId("CmdCustomizeShortcuts"));
    await request("state");
    const dialog = Number(await request("begin", "CmdScrollDown", "", "4"));
    if (!dialog || !postMessage(dialog, WM_KEYDOWN, VK_F20, 0)) {
      throw new Error("could not send F20 to the key capture");
    }
    let captured = false;
    for (let i = 0; i < 50; i++) {
      if ((await request("has", "CmdScrollDown", "f20")) === "1") {
        captured = true;
        break;
      }
      await sleep(20);
    }
    if (!captured) throw new Error("Add key did not capture F20");
    await request("save");
    const withArg = await savedSettings(/Key\s*=\s*f20/i);
    if (!/Cmd\s*=\s*CmdScrollDown 4/.test(withArg) || !/Key\s*=\s*f20/i.test(withArg)) {
      throw new Error("command argument was not saved");
    }
    const scrollStart = getScrollPos(canvas);
    await pressKey(frame, 0x4a);
    const oneLine = getScrollPos(canvas) - scrollStart;
    if ((await request("press", "", "f20")) !== "CmdScrollDown") {
      throw new Error("F20 did not resolve to CmdScrollDown");
    }
    const fourLines = getScrollPos(canvas) - scrollStart - oneLine;
    if (oneLine <= 0 || fourLines < 3 * oneLine) {
      throw new Error(`CmdScrollDown 4 moved ${fourLines} after a one-line move of ${oneLine}`);
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
  await checkUnsavedOk(dir, pdf);
  await checkNamedShortcut(dir, pdf);
}

// E49: reassigning or removing a named toolbar shortcut's key keeps its name and button
async function checkNamedShortcut(dir: string, pdf: string): Promise<void> {
  const namedBlock = (text: string) => /\[\s*Cmd\s*=\s*CmdScrollDown\s*([^\]]*)\]/.exec(text)?.[1] ?? "";
  for (const action of ["reassign", "remove"]) {
    const appdata = join(dir, `named-${action}`);
    mkdirSync(appdata, { recursive: true });
    const settings = join(appdata, "SolokPDF-settings.txt");
    writeFileSync(
      settings,
      "UiLanguage = en\nShortcuts [\n  [\n    Cmd = CmdScrollDown\n    Key = f22\n    Name = Named scroll\n    ToolbarText = NamedScroll\n  ]\n]\n",
    );
    const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf], { saveSettings: true });
    try {
      await client.waitForRenderIdle();
      sendCommandSync(frame, cmdId("CmdCustomizeShortcuts"));
      await client.request(ControlCommand.TestShortcutsDialog, ["state"]);
      const args = action === "remove" ? ["remove", "CmdScrollDown", "f22"] : ["add", "CmdScrollUp", "f22"];
      const res = await client.request(ControlCommand.TestShortcutsDialog, args);
      if (res[0] !== 0) throw new Error(`${action}: ${res[1]}`);
      await client.request(ControlCommand.TestShortcutsDialog, ["save"]);
      let text = readFileSync(settings, "utf8");
      for (let i = 0; i < 100 && /Key\s*=\s*f22/i.test(namedBlock(text)); i++) {
        await sleep(20);
        text = readFileSync(settings, "utf8");
      }
      if (/Key\s*=\s*f22/i.test(namedBlock(text))) throw new Error(`${action} left f22 on the shortcut:\n${text}`);
      if (!/ToolbarText\s*=\s*NamedScroll/.test(text) || !/Name\s*=\s*Named scroll/.test(text))
        throw new Error(`${action} dropped the shortcut's name or toolbar text:\n${text}`);
    } finally {
      await client.quit().catch(() => {});
      await killAndWait(proc);
    }
  }
}

// E48: OK applies the draft in memory; -for-testing never writes the settings file
async function checkUnsavedOk(dir: string, pdf: string): Promise<void> {
  const appdata = join(dir, "unsaved");
  mkdirSync(appdata, { recursive: true });
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdCustomizeShortcuts"));
    await client.request(ControlCommand.TestShortcutsDialog, ["state"]);
    await client.request(ControlCommand.TestShortcutsDialog, ["add", "CmdScrollDownHalfPage", "f21"]);
    await client.request(ControlCommand.TestShortcutsDialog, ["save"]);
    const res = await client.request(ControlCommand.TestShortcutsDialog, ["resolve", "", "f21"]);
    if (res[1] !== "CmdScrollDownHalfPage") throw new Error(`OK without a saved file lost the binding: ${res[1]}`);
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
