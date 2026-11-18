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
// E146: the rest of the deferred moves: Advanced Settings' drop-down closed by the loss,
// a Change Theme preview, a tab shown, a web page navigating, the command palette
// closed. The contents and Advanced Settings edits get the focus another app took back
// once their window is active again, as after a minimize.
//
// E149: the click that reactivates a window decides the focus: a held refocus runs as the
// activation ends, before the click, not after it. Holds of the app's deactivation outlast
// another of its windows' activation. A document loaded with no focus focuses its frame,
// as does a Markdown page navigated to.
//
// E147: a click on the page box keeps its focus and caret; a CHM page navigated to
// focuses the frame as a Markdown one does.
//
// `away` activates a window standing for another app; `click-frame` / `click-last` /
// `click-hwnd` activate a window as a click on its caption does, with no SetFocus() after;
// `activating-click`, as a click in it does: activation, the click, then posted messages.
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
import { makeChmPages } from "./chm-fixture.ts";
import { cmdId, pollUntil, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  enumWindows,
  sendCopyDataW,
  VK_DOWN,
  VK_ESCAPE,
  WM_KEYDOWN,
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
  clientToScreen,
  findChildWindow,
  findVisibleChildWindow,
  getClientRect,
} from "./winapi.ts";
import {
  findCanvas,
  killAndWait,
  launchControlled,
  moveTestCursor,
  sendCommand,
  sendCommandSync,
  waitForPalette,
} from "./win-automation.ts";

const WAIT_MS = 3000;
const TOOLBAR_CLASS = "SUMATRA_VIRT_TOOLBAR";
// WM_COPYDATA id of a DDE command
const DDE_COPYDATA = 0x44646557;
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

// activated as a click on its caption does
async function clickTop(client: ControlClient, hwnd: number): Promise<void> {
  await client.request(ControlCommand.TestFocusState, ["click-hwnd", hwnd]);
}

async function themeColors(client: ControlClient): Promise<string> {
  const dump = String((await client.request(ControlCommand.TestThemeWindows, [""]))[1] ?? "");
  return dump.split("\n")[0] ?? "";
}

async function currentTab(client: ControlClient): Promise<string> {
  return String((await client.request(ControlCommand.TestCurrentTab, []))[1] ?? "");
}

// opened in a new tab of `frame` as another app asks for it, without the focus
async function openInTab(client: ControlClient, frame: number, path: string, page: number): Promise<void> {
  sendCopyDataW(frame, DDE_COPYDATA, `[Open("${path}", 0, 0, 0)]`);
  await pollUntil(
    () => currentTab(client),
    (r) => r.startsWith(`path=${path} page=${page}`),
    { timeoutMs: WAIT_MS, error: (r) => `${path} not loaded: ${r}` },
  );
}

// a click at (x, y) in hwnd, whose window isn't active, in the order Windows takes it
async function activatingClick(client: ControlClient, hwnd: number, x: number, y: number): Promise<void> {
  const at = clientToScreen(hwnd, x, y);
  await moveTestCursor(at.x, at.y, client);
  await client.request(ControlCommand.TestFocusState, ["activating-click", hwnd, packCoords(x, y)]);
}

// a click on the canvas away from the page's annotations
async function activatingCanvasClick(client: ControlClient, canvas: number): Promise<void> {
  const rc = getClientRect(canvas);
  await activatingClick(client, canvas, Math.max(1, rc.right - 40), Math.max(1, rc.bottom - 40));
}

async function paletteOpen(client: ControlClient): Promise<boolean> {
  return (await client.request(ControlCommand.TestCommandPalette, []))[0] === 0;
}

export async function testit(): Promise<void> {
  failures.length = 0;
  setProcessDpiAware();
  const dir = tmpPath("ad-hoc-e144");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makeE110Pdf(), "latin1");
  const pdf2 = join(dir, "doc2.pdf");
  writeFileSync(pdf2, makeE110Pdf(), "latin1");
  const pdf3 = join(dir, "doc3.pdf");
  writeFileSync(pdf3, makeE110Pdf(), "latin1");
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

    // E149: the click's focus stays; the find box doesn't get it back after the click
    await step("find bar: a click on the canvas activates the restored frame", async () => {
      await openFind();
      try {
        await minimizeFrame(client, "os-first", "away");
        await waitGone(findBar, "find bar with the frame minimized");
      } finally {
        await minimizeFrame(client, "restore");
      }
      checkAway(await settled(client), "restored");
      await activatingCanvasClick(client, canvas);
      const res = await settled(client);
      check(/^focus=(frame|canvas) active=frame /.test(res), `the click did not keep the focus: ${res}`);
      check(!/ caret=owned /.test(res), `the find box kept its caret: ${res}`);
    });
    if (findBar()) await hideByOwner(client, "find");

    // E147: an edit the click focuses itself, which shows its caret
    await step("find bar: a click on the page box activates the restored frame", async () => {
      await openFind();
      try {
        await minimizeFrame(client, "os-first", "away");
        await waitGone(findBar, "find bar with the frame minimized");
      } finally {
        await minimizeFrame(client, "restore");
      }
      checkAway(await settled(client), "restored");
      const pageBox = findVisibleChildWindow(findChildWindow(frame, TOOLBAR_CLASS), "Edit");
      check(pageBox !== 0, "no page box");
      await activatingClick(client, pageBox, 4, Math.floor(getClientRect(pageBox).bottom / 2));
      const res = await settled(client);
      check(/^focus=page-box active=frame caret=focus /.test(res), `the click did not keep the focus: ${res}`);
    });
    if (findBar()) await hideByOwner(client, "find");

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

    await step("contents edit: another app takes the focus, back with the frame", async () => {
      await openEdit("away");
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
      check(await editing(client), "the contents edit closed");
      await activateFrame(client);
      await pollUntil(
        () => settled(client),
        (r) => r.startsWith("focus=annot-toolbar "),
        { timeoutMs: WAIT_MS, error: (r) => `the contents edit did not get the focus back: ${r}` },
      );
      check(await editing(client), "the contents edit closed on the way back");
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

    // the click took the focus from the contents edit: committed, as for a click away
    const clickCommits = async (text: string) => {
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
    };

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
      await activatingCanvasClick(client, canvas);
      await clickCommits(text);
    });

    // E149: the frame activated by a click on the canvas after another app took the focus
    await step("contents edit: a click on the canvas reactivates the frame", async () => {
      const text = "reactivated";
      await openEdit(text);
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
      await activatingCanvasClick(client, canvas);
      await clickCommits(text);
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

    const advWnd = topWindow(pid, "Advanced Settings");
    await step("Advanced Settings edit: another app takes the focus, back with the dialog", async () => {
      check((await advSettings(client, "edit")).includes("editing=1"), "the value edit did not open");
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
      check((await advSettings(client, "state")).includes("editing=1"), "the value edit closed");
      await clickTop(client, advWnd);
      await pollUntil(
        () => settled(client),
        (r) => r.startsWith("focus=other-edit "),
        { timeoutMs: WAIT_MS, error: (r) => `the value edit did not get the focus back: ${r}` },
      );
      check((await advSettings(client, "state")).includes("editing=1"), "the value edit closed on the way back");
    });

    // E149: the main window activated on the way back keeps the hold
    await step("Advanced Settings edit: another app takes the focus, back through the frame", async () => {
      check((await advSettings(client, "edit")).includes("editing=1"), "the value edit did not open");
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
      await activateFrame(client);
      await clickTop(client, advWnd);
      await pollUntil(
        () => settled(client),
        (r) => r.startsWith("focus=other-edit "),
        { timeoutMs: WAIT_MS, error: (r) => `the value edit did not get the focus back: ${r}` },
      );
      check((await advSettings(client, "state")).includes("editing=1"), "the value edit closed on the way back");
    });

    // E149: a click on the edited row's name, in the list, a virtual control: the dialog
    // window takes the focus after the refocus, the edit stays open
    await step("Advanced Settings edit: a click on the list reactivates the dialog", async () => {
      check((await advSettings(client, "edit")).includes("editing=1"), "the value edit did not open");
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
      const geom = await advSettings(client, "geom");
      const row = /\beditRow=(\d+)/.exec(geom)?.[1];
      const r = new RegExp(`row=${row} rect=(-?\\d+),(-?\\d+),(\\d+),(\\d+)`).exec(geom);
      check(r !== null, `the edited row is not shown: ${geom}`);
      await activatingClick(client, advWnd, Number(r![1]) + 4, Number(r![2]) + Math.floor(Number(r![4]) / 2));
      const res = await settled(client);
      check(/^focus=other active=other /.test(res), `the click did not keep the focus: ${res}`);
      check((await advSettings(client, "state")).includes("editing=1"), "the value edit closed");
    });

    // the loss closes the list; the posted close and the combo's end leave the focus there
    await step("Advanced Settings drop-down: another app takes the focus", async () => {
      await clickTop(client, advWnd);
      const res = await client.request(ControlCommand.TestAdvSettingsRows, ["open-choice", 0]);
      check(res[0] === 0, `the drop-down did not open: ${res[1]}`);
      await focusState(client, "away");
      checkAway(await settled(client), "after the loss");
    });
    await advSettings(client, "cancel");
    await activateFrame(client);

    await step("Change Theme: a preview after another app took the focus", async () => {
      sendCommandSync(frame, cmdId("CmdChangeTheme"));
      const dlg = topWindow(pid, "Change Theme");
      check(dlg !== 0, "the Change Theme dialog did not open");
      try {
        const colors = await themeColors(client);
        postMessage(dlg, WM_KEYDOWN, VK_DOWN, 0);
        await focusState(client, "away");
        await pollUntil(
          () => themeColors(client),
          (c) => c !== colors,
          { timeoutMs: WAIT_MS, error: "the next theme was not previewed" },
        );
        checkAway(await settled(client), "after the preview");
      } finally {
        postMessage(dlg, WM_CLOSE, 0, 0);
        await waitGone(() => topWindow(pid, "Change Theme"), "Change Theme dialog");
      }
    });
    await activateFrame(client);

    await step("command palette: closed after another app took the focus", async () => {
      sendCommand(frame, cmdId("CmdCommandPalette"));
      const { edit } = await waitForPalette(client, frame);
      check(edit !== 0, "the palette did not open");
      await focusState(client, "away");
      postMessage(edit, WM_KEYDOWN, VK_ESCAPE, 0);
      await pollUntil(
        () => paletteOpen(client),
        (o) => !o,
        { timeoutMs: WAIT_MS, error: "the palette did not close" },
      );
      checkAway(await settled(client), "closed");
    });
    await activateFrame(client);

    await step("command palette: closed with the focus, the frame gets it", async () => {
      sendCommand(frame, cmdId("CmdCommandPalette"));
      const { edit } = await waitForPalette(client, frame);
      check(edit !== 0, "the palette did not open");
      const opened = await focusState(client);
      check(opened.startsWith("focus=palette "), `the palette has no focus: ${opened}`);
      postMessage(edit, WM_KEYDOWN, VK_ESCAPE, 0);
      await pollUntil(
        () => paletteOpen(client),
        (o) => !o,
        { timeoutMs: WAIT_MS, error: "the palette did not close" },
      );
      const res = await settled(client);
      check(/^focus=frame active=frame /.test(res), `the frame did not get the focus: ${res}`);
    });

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
    await activateFrame(client);

    await step("document loaded: another app has the focus", async () => {
      await focusState(client, "away");
      await openInTab(client, frame, pdf2, 1);
      checkAway(await settled(client), "loaded");
    });
    await activateFrame(client);

    // E149: a document another app asks for, the frame active with no focus
    await step("document loaded: the frame active, no focus", async () => {
      await focusState(client, "none");
      await openInTab(client, frame, pdf3, 1);
      const res = await settled(client);
      check(/^focus=(frame|canvas) active=frame /.test(res), `the frame did not get the focus: ${res}`);
    });

    // a tab shown for the app (the palette's close, an async load) and a web page's
    // navigation (CHM, Markdown): the frame without a focus takes it (startup, script
    // dropping it), another app's stays
    const deferred = [
      { what: "tab shown", run: (i: number) => client.request(ControlCommand.TestSelectTab, [i % 2]) },
      { what: "web page navigating", run: () => focusState(client, "page-navigating") },
    ];
    for (const d of deferred) {
      await step(`${d.what}: the frame active, no focus`, async () => {
        await focusState(client, "none");
        await d.run(0);
        const res = await settled(client);
        check(/^focus=(frame|canvas) active=frame /.test(res), `the frame did not get the focus: ${res}`);
      });

      await step(`${d.what}: another app has the focus`, async () => {
        await focusState(client, "away");
        await d.run(1);
        checkAway(await settled(client), d.what);
      });
      await activateFrame(client);
    }

    // E149: a Markdown document's real navigation, E147: a CHM document's. The page counts
    // as current at once; its url served by the app shows the web view navigated
    // (OnBeforeNavigate ran)
    const mdDir = join(dir, "md");
    mkdirSync(mdDir, { recursive: true });
    for (const name of ["a", "b", "c"]) writeFileSync(join(mdDir, `${name}.md`), `# ${name}\n`);
    const chm = join(dir, "pages.chm");
    writeFileSync(chm, makeChmPages("E147", ["a", "b", "c"]));
    const webDocs = [
      { kind: "Markdown", path: join(mdDir, "a.md"), ext: "(md|html)" },
      { kind: "CHM", path: chm, ext: "html" },
    ];
    for (const doc of webDocs) {
      const navigated = async (name: string) => {
        const page = new RegExp(`(^|/)${name}\\.${doc.ext}$`, "m");
        await pollUntil(
          async () => String((await client.request(ControlCommand.TestMarkdownServed, []))[1] ?? ""),
          (r) => page.test(r),
          { timeoutMs: WAIT_MS * 5, error: (r) => `${doc.kind} page ${name} not shown: ${r}` },
        );
      };
      await openInTab(client, frame, doc.path, 1);
      await navigated("a");
      await activateFrame(client);
      await step(`${doc.kind} page navigated: another app has the focus`, async () => {
        await focusState(client, "away");
        sendCommand(frame, cmdId("CmdGoToNextPage"));
        await navigated("b");
        checkAway(await settled(client), "navigated");
      });
      await activateFrame(client);
      await step(`${doc.kind} page navigated: the frame active, no focus`, async () => {
        await focusState(client, "none");
        sendCommand(frame, cmdId("CmdGoToNextPage"));
        await navigated("c");
        const res = await settled(client);
        check(/^focus=(frame|canvas) active=frame /.test(res), `the frame did not get the focus: ${res}`);
      });
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
  check(failures.length === 0, failures.join("\n"));
  console.log("e144-focus-restores: OK");
}

if (import.meta.main) await runStandalone(testit);
