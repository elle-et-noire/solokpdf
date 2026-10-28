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
  writeFileSync(settings, "UiLanguage = en\nReuseInstance = false\nShowStartPage = false\nSmoothScroll = false\n");

  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-zoom", "200", "-view", "continuous", pdf],
    { saveSettings: true },
  );
  const request = async (action: string, command = "", key = "", arg = "") => {
    const res = await client.request(ControlCommand.TestShortcutsDialog, [action, command, key, arg]);
    if (res[0] !== 0) throw new Error(`${action}: ${res[1]}`);
    return String(res[1]);
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
    const saved = readFileSync(settings, "utf8");
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
    const withArg = readFileSync(settings, "utf8");
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
}

if (import.meta.main) await runStandalone(testit);
