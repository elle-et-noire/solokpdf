// E144: a focus move the app makes on its own behalf, not on the user's input, takes the
// focus only from a window its mover owns (HwndMoveFocus). One that finds it elsewhere
// leaves it there:
//
//   find bar hidden by its owner           another app has the focus -> it keeps it
//   contents edit, Advanced Settings edit  another app takes the focus -> no refocus;
//                                          the on-screen keyboard does -> refocused
//   free text box, Advanced Settings edit, a click on another window's caption ends
//   Navigate Files path edit               the edit there -> that window keeps the focus
//
// The owned popups layer: a restored popup hidden by its owner before the frame is active
// doesn't get the focus back, so its owner gets the loss it was held from: the find box's
// caret goes. A click on the canvas activating the frame refocuses the contents edit, then
// takes the focus from it: committed, as for a click away.
//
// `away` activates a window standing for another app; `click-frame` / `click-last`
// activate a frame as a click on its caption does, with no SetFocus() after.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e144-focus-restores.ts --no-build

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import {
  activateFrame,
  annotToolbarDump,
  EDIT_CLASS,
  focusState,
  hideByOwner,
  makeE110Pdf,
  minimizeFrame,
  openContentsEdit,
  shownFindBar,
  shownTop,
  waitGone,
  waitShown,
  withOtherWindow,
} from "./ad-hoc-e98-anchored-popups.ts";
import { cmdId, pollUntil, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  enumWindows,
  getControlText,
  getWindowPid,
  getWindowText,
  packCoords,
  postMessage,
  sendMessage,
  sendText,
  setProcessDpiAware,
  WM_CLOSE,
  WM_COMMAND,
} from "./winapi.ts";
import { clickCanvasAway, findCanvas, killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";

const WAIT_MS = 3000;
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

async function step(what: string, f: () => Promise<void>): Promise<void> {
  try {
    await f();
    console.log(`  ok: ${what}`);
  } catch (e) {
    failures.push(`${what}: ${(e as Error).message}`);
    console.log(`  FAILED: ${what}: ${(e as Error).message}`);
  }
}

// the posted reactions ran
async function settled(client: ControlClient): Promise<string> {
  await client.request(ControlCommand.Ping, []);
  return await focusState(client, "detail");
}

// another app has the focus after `what`
function checkAway(res: string, what: string): void {
  check(/^focus=(none|away) active=away /.test(res), `${what}: the focus left the other app: ${res}`);
}

function topWindow(pid: number, title: string): number {
  let found = 0;
  enumWindows((h) => {
    if (getWindowPid(h) === pid && getWindowText(h) === title) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

async function advSettings(client: ControlClient, action: string): Promise<string> {
  return await pollUntil(
    async () => {
      const res = await client.request(ControlCommand.TestAdvSettingsRows, [action]);
      return res[0] === 2 ? "" : String(res[1] ?? "");
    },
    (r) => r !== "",
    { timeoutMs: WAIT_MS, error: `Advanced Settings: ${action}` },
  );
}

async function navFiles(client: ControlClient, action: string): Promise<string> {
  return await pollUntil(
    async () => {
      const res = await client.request(ControlCommand.TestNavFiles, [action, -1]);
      return res[0] === 2 ? "" : String(res[1] ?? "");
    },
    (r) => r !== "",
    { timeoutMs: WAIT_MS, error: `Navigate Files: ${action}` },
  );
}

async function inPlaceActive(client: ControlClient): Promise<boolean> {
  const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
  return /freeTextEdit active=1/.test(raw);
}

async function editing(client: ControlClient): Promise<boolean> {
  return / editing=1\b/.test(await annotToolbarDump(client));
}

export async function testit(): Promise<void> {
  failures.length = 0;
  setProcessDpiAware();
  const dir = tmpPath("ad-hoc-e144");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makeE110Pdf(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  const pid = proc.pid!;
  const findBar = () => shownFindBar(pid, frame);
  const toolbar = () => shownTop(pid, EDIT_CLASS);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    check(canvas !== 0, "canvas not found");
    await activateFrame(client);

    // the find bar open, its box focused
    const openFind = async () => {
      if (!findBar()) sendCommandSync(frame, cmdId("CmdFindFirst"));
      await waitShown(findBar, "find bar");
      const res = await focusState(client, "find-edit");
      check(res.startsWith("focus=owned "), `the find box has no focus: ${res}`);
    };

    await step("find bar: hidden by its owner with the focus in another app", async () => {
      await openFind();
      await focusState(client, "away");
      await hideByOwner(client, "find");
      checkAway(await settled(client), "hidden");
      await activateFrame(client);
    });

    // the restore's hold dropped for a popup hidden meanwhile delivers its loss
    for (const focus of ["", "frame", "away"]) {
      await step(`find bar: hidden by its owner before the frame is active, focus ${focus || "kept"}`, async () => {
        await openFind();
        try {
          await minimizeFrame(client, "os-first", focus);
          await waitGone(findBar, "find bar with the frame minimized");
        } finally {
          await minimizeFrame(client, "restore");
        }
        await hideByOwner(client, "find");
        await activateFrame(client);
        const res = await settled(client);
        check(!/ caret=owned /.test(res), `the hidden find box kept its caret: ${res}`);
      });
    }

    sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
    const openEdit = async (text: string) => {
      if (toolbar()) await hideByOwner(client, "annotation");
      await waitGone(toolbar, "annotation toolbar");
      const edit = await openContentsEdit(client, canvas, toolbar);
      sendText(edit, text);
      const res = await focusState(client);
      check(res.startsWith("focus=annot-toolbar "), `the contents edit has no focus: ${res}`);
      return edit;
    };

    await step("contents edit: another app takes the focus", async () => {
      await openEdit("away");
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
      check(await editing(client), "the contents edit closed");
      await activateFrame(client);
    });

    await step("contents edit: the on-screen keyboard takes the focus", async () => {
      await openEdit("keyboard");
      await focusState(client, "none");
      await pollUntil(
        () => focusState(client),
        (r) => r.startsWith("focus=annot-toolbar "),
        { timeoutMs: WAIT_MS, error: (r) => `the contents edit did not get the focus back: ${r}` },
      );
      check(await editing(client), "the contents edit closed");
    });

    await step("contents edit: a click on the canvas activates the restored frame", async () => {
      const text = "clicked away";
      await openEdit(text);
      try {
        await minimizeFrame(client, "os-first", "away");
        await waitGone(toolbar, "annotation toolbar with the frame minimized");
      } finally {
        await minimizeFrame(client, "restore");
      }
      checkAway(await settled(client), "restored");
      await focusState(client, "activate");
      await clickCanvasAway(canvas);
      await pollUntil(
        () => editing(client),
        (e) => !e,
        { timeoutMs: WAIT_MS, error: "the contents edit is still open after the click" },
      );
      const res = await settled(client);
      check(/^focus=(frame|canvas) active=frame /.test(res), `the click did not keep the focus: ${res}`);
      const edit = await openContentsEdit(client, canvas, toolbar);
      const kept = getControlText(edit);
      check(kept === text, `committed "${kept}", want "${text}"`);
    });
    if (toolbar()) await hideByOwner(client, "annotation");

    await step("free text box: a click on another window's caption", async () => {
      await withOtherWindow(client, frame, "CmdNewWindow", async () => {
        sendMessage(frame, WM_COMMAND, cmdId("CmdCreateAnnotFreeText"), packCoords(120, 250));
        await pollUntil(
          () => inPlaceActive(client),
          (a) => a,
          { timeoutMs: WAIT_MS, error: "the free text box did not open" },
        );
        await focusState(client, "click-last");
        const res = await settled(client);
        check(/^focus=other-window active=other-window /.test(res), `the focus left the other window: ${res}`);
        check(!(await inPlaceActive(client)), "the free text box is still open");
      });
    });
    sendCommandSync(frame, cmdId("CmdToggleEditPDF"));

    await step("Advanced Settings edit: a click on the frame's caption", async () => {
      sendCommandSync(frame, cmdId("CmdAdvancedSettings"));
      check((await advSettings(client, "edit")).includes("editing=1"), "the value edit did not open");
      await focusState(client, "click-frame");
      const res = await settled(client);
      check(/^focus=(frame|canvas) active=frame /.test(res), `the focus left the frame: ${res}`);
      check((await advSettings(client, "state")).includes("editing=0"), "the value edit is still open");
    });

    await step("Advanced Settings edit: another app takes the focus", async () => {
      check((await advSettings(client, "edit")).includes("editing=1"), "the value edit did not open");
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
      check((await advSettings(client, "state")).includes("editing=1"), "the value edit closed");
    });
    await advSettings(client, "cancel");
    await activateFrame(client);

    await step("Navigate Files path edit: a click on the frame's caption", async () => {
      await client.request(ControlCommand.TestInvokeCommand, ["CmdNavigateFilesInFolder"]);
      check((await navFiles(client, "edit-path")).includes("editing=1"), "the path edit did not open");
      await focusState(client, "click-frame");
      const res = await settled(client);
      check(/^focus=(frame|canvas) active=frame /.test(res), `the focus left the frame: ${res}`);
      check((await navFiles(client, "path-state")).includes("editing=0"), "the path edit is still open");
    });
    const nav = topWindow(pid, "Navigate Files in Folder");
    if (nav) postMessage(nav, WM_CLOSE, 0, 0);
  } finally {
    client.close();
    await killAndWait(proc);
  }
  check(failures.length === 0, failures.join("\n"));
  console.log("e144-focus-restores: OK");
}

if (import.meta.main) await runStandalone(testit);
