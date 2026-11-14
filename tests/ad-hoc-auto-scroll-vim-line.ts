import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlClient, ControlCommand } from "./control.ts";
import { ROOT, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { postMessage, sleep, VK_DOWN, VK_ESCAPE, WM_KEYDOWN, WM_KEYUP } from "./winapi.ts";

// E52: keys typed in the Vim ':' line belong to it, not to Automatically Scroll.
async function bar(client: ControlClient): Promise<{ visible: boolean; speed: number }> {
  const out = String((await client.request(ControlCommand.TestReadingAutoScroll, []))[1] ?? "");
  const m = /OK visible=1 paused=\d+ .*speed=(\d+)/.exec(out);
  return m ? { visible: true, speed: Number(m[1]) } : { visible: false, speed: 0 };
}

async function vimEdit(client: ControlClient): Promise<number> {
  const out = String((await client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
  return Number(/edit=(\d+)/.exec(out)?.[1] ?? 0);
}

export async function testit(): Promise<void> {
  const dir = tmpPath("auto-scroll-vim-line");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "VimKeys = true\nReadingAutoScrollSpeed = 40\nRestoreSession = false\n");
  const pdf = join(ROOT, "ext", "a-zlib", "zlib.3.pdf");
  const { proc, client } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdToggleAutomaticallyScroll"]);
    for (let i = 0; i < 60 && !(await bar(client)).visible; i++) await sleep(100);
    assert.equal((await bar(client)).speed, 40, "auto-scroll did not start at speed 40");

    await client.request(ControlCommand.TestVimKeys, ["key", ":"]);
    const edit = await vimEdit(client);
    assert.ok(edit, "Vim command line did not open");
    postMessage(edit, WM_KEYDOWN, VK_DOWN, 1);
    postMessage(edit, WM_KEYUP, VK_DOWN, 1);
    postMessage(edit, WM_KEYDOWN, VK_ESCAPE, 1);
    postMessage(edit, WM_KEYUP, VK_ESCAPE, 1);
    await sleep(500);
    const after = await bar(client);
    assert.ok(after.visible, "Esc in the command line stopped auto-scroll");
    assert.equal(after.speed, 40, "Down in the command line changed the auto-scroll speed");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
