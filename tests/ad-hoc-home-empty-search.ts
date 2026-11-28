import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForHome, type ControlClient } from "./control.ts";
import { cmdId, makeTextPdf, pollUntil, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import {
  findCanvas,
  findChildByClass,
  FRAME_CLASS,
  killAndWait,
  launchControlled,
  sendCommand,
} from "./win-automation.ts";
import {
  captureWindowToPng,
  enumWindows,
  getClassName,
  getWindowPid,
  sendMessage,
  sendText,
  VK_ESCAPE,
  WM_KEYDOWN,
} from "./winapi.ts";

const message = "No matching files";

async function hasMessage(client: ControlClient, canvas: number): Promise<boolean> {
  return (await client.virtTree(getClassName(canvas))).some((row) => row.hwnd === canvas && row.text === message);
}

function capture(frame: number, mode: string, state: string): void {
  const output = process.env.SOLOKPDF_E158_CAPTURES;
  if (output) assert.ok(captureWindowToPng(frame, join(output, `${mode}-${state}.png`), 0));
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  for (const mode of ["list", "thumbnails"]) {
    const dir = mkdtempSync(tmpPath("home-empty-search-"));
    const settings = `UiLanguage = en\nRestoreSession = false\nShowTips = true\nHomePageViewMode = ${mode}\n`;
    writeFileSync(join(dir, SETTINGS_FILE), settings);
    const launch = () => launchControlled(["-appdata", dir, "-window-pos", "820x640@100x100"]);
    const empty = await launch();
    try {
      await waitForHome(empty.client, (s) => s.ready && s.entries === 0, "Empty Home not ready");
      const canvas = findCanvas(empty.frame);
      assert.equal(await hasMessage(empty.client, canvas), false);
      capture(empty.frame, mode, "first-launch");
      const edit = findChildByClass(canvas, "Edit");
      assert.ok(edit);
      sendText(edit, "Alpha");
      assert.equal(await hasMessage(empty.client, canvas), false);
    } finally {
      empty.client.close();
      await killAndWait(empty.proc);
    }

    const paths = ["Alpha", "Beta"].map((name) => {
      const path = join(dir, name + ".pdf");
      writeFileSync(path, makeTextPdf(name));
      return path;
    });
    writeFileSync(
      join(dir, SETTINGS_FILE),
      settings + "FileStates [\n" + paths.map((path) => `[\n FilePath = ${path}\n OpenCount = 5\n]\n`).join("") + "]\n",
    );
    const { client, frame, proc } = await launch();
    try {
      const full = await waitForHome(client, (s) => s.entries === 2, "Full Home not ready");
      assert.equal(full.listView, mode === "list");
      assert.ok(full.tipRect[3] > 0);
      sendCommand(frame, cmdId("CmdNewWindow"));
      const second = await pollUntil(
        () => {
          let other = 0;
          enumWindows((h) => {
            if (h !== frame && getWindowPid(h) === proc.pid && getClassName(h) === FRAME_CLASS) other = h;
            return !other;
          });
          return other;
        },
        Boolean,
        { error: "Second Home window did not open" },
      );
      const secondCanvas = findCanvas(second);
      assert.ok(secondCanvas);
      await pollUntil(
        () => client.homeSelection(undefined, 1),
        (s) => s.ready && s.entries === 2,
        {
          error: "Second Home window not ready",
        },
      );
      const canvas = findCanvas(frame);
      const edit = findChildByClass(canvas, "Edit");
      const otherEdit = findChildByClass(secondCanvas, "Edit");
      assert.ok(edit && otherEdit);
      sendText(otherEdit, "Beta");
      const other = await pollUntil(
        () => client.homeSelection(undefined, 1),
        (s) => s.ready && s.entries === 1,
        {
          error: "Second Home window did not filter",
        },
      );
      sendText(edit, "Alpha");
      const one = await waitForHome(client, (s) => s.entries === 1, "Alpha did not match");
      assert.equal(one.path, paths[0]);
      assert.deepEqual(one.search, full.search);
      assert.equal(await hasMessage(client, canvas), false);
      capture(frame, mode, "one-match");
      sendText(edit, "No report by that name");
      const none = await waitForHome(client, (s) => s.entries === 0, "Search did not empty the Home list");
      assert.deepEqual(none.tipRect, [0, 0, 0, 0]);
      assert.deepEqual(none.search, full.search);
      assert.ok(none.open[2] > 0);
      assert.ok(await hasMessage(client, canvas));
      assert.equal(await hasMessage(client, secondCanvas), false);
      capture(frame, mode, "no-match");
      sendMessage(edit, WM_KEYDOWN, VK_ESCAPE, 0);
      const restored = await waitForHome(client, (s) => s.entries === 2, "Esc did not restore Home");
      assert.ok(restored.tipRect[3] > 0);
      assert.equal(await hasMessage(client, canvas), false);
      capture(frame, mode, "restored");
      const unchanged = await client.homeSelection(undefined, 1);
      assert.deepEqual([unchanged.path, unchanged.sel, unchanged.entries], [other.path, other.sel, other.entries]);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
