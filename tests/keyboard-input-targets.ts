import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { ControlCommand, type ControlClient } from "./control";
import { IS_WIN } from "./host";
import { findSidebarTree } from "./sidebar-tree";
import { makeBookmarkedPdf } from "./toc-tree-sent-click";
import { cmdId, pollUntil, runStandalone, tmpPath, USE_NG, writeAppdata } from "./util";
import {
  activateTestFrame,
  clickAt,
  killAndWait,
  launchControlled,
  pressKey,
  sendCommandSync,
  waitForFocusClass,
} from "./win-automation";
import {
  enumWindows,
  findChildWindow,
  getClassName,
  getControlText,
  getFocusedHwnd,
  getMenuItemCount,
  getMenuItemId,
  getMenuItemText,
  getParentWindow,
  getPopupMenuHandle,
  getWindowPid,
  isWindowVisible,
  postMessage,
  sendMessage,
  sendText,
  VK_DOWN,
  VK_ESCAPE,
  VK_HOME,
  VK_RIGHT,
  VK_RETURN,
  WM_KEYDOWN,
  WM_KEYUP,
} from "./winapi";

const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const WM_SYSCHAR = 0x0106;
const ALT_CONTEXT = 1 << 29;
const KEY_RELEASE = 0xc0000001;
const VK_F10 = 0x79;
const VK_G = 0x47;
const VK_K = 0x4b;
const VK_Z = 0x5a;
const VK_THREE = 0x33;
const CB_SHOWDROPDOWN = 0x014f;

function findPopup(pid: number, className: string, accept = (_hwnd: number) => true): number {
  let result = 0;
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) !== pid || getClassName(hwnd) !== className || !isWindowVisible(hwnd)) return true;
    if (!accept(hwnd)) return true;
    result = hwnd;
    return false;
  });
  return result;
}

async function keyState(client: ControlClient): Promise<string> {
  const res = await client.request(ControlCommand.TestVimKeys, ["state"]);
  assert.equal(res[0], 0, String(res[1]));
  return String(res[1]);
}

async function expectState(client: ControlClient, page: number): Promise<void> {
  const state = await keyState(client);
  assert.ok(state.includes(`page=${page} `) && /count=0 prefix=-/.test(state), state);
}

async function ctrlKey(client: ControlClient, hwnd: number, key: number): Promise<void> {
  await client.request(ControlCommand.TestFocusState, ["ctrl-down"]);
  try {
    postMessage(hwnd, WM_KEYDOWN, key, 1);
    await client.request(ControlCommand.TestFocusState, []);
  } finally {
    await client.request(ControlCommand.TestFocusState, ["ctrl-up"]);
  }
  postMessage(hwnd, WM_KEYUP, key, KEY_RELEASE);
  await client.request(ControlCommand.TestFocusState, []);
}

async function menuKeys(pid: number, frame: number, target: number): Promise<void> {
  for (const key of ["Alt+F", "F10"]) {
    if (key === "Alt+F") {
      postMessage(target, WM_SYSCHAR, "f".charCodeAt(0), ALT_CONTEXT | 1);
    } else {
      postMessage(target, WM_SYSKEYDOWN, VK_F10, 1);
      postMessage(target, WM_SYSKEYUP, VK_F10, KEY_RELEASE);
      postMessage(frame, WM_KEYDOWN, VK_DOWN, 1);
    }
    const matchesMenu = (hwnd: number) => {
      const menu = getPopupMenuHandle(hwnd);
      for (let i = 0; i < getMenuItemCount(menu); i++) {
        if (getMenuItemId(menu, i) === cmdId("CmdNewWindow")) return true;
        if (key === "F10" && getMenuItemText(menu, i) === "File") return true;
      }
      return false;
    };
    const popup = await pollUntil(() => findPopup(pid, "#32768", matchesMenu), Boolean, {
      error: `${key} did not open menu from ${getClassName(target)}`,
    });
    postMessage(popup, WM_KEYDOWN, VK_ESCAPE, 1);
    postMessage(frame, WM_KEYDOWN, VK_ESCAPE, 1);
    await pollUntil(
      () => findPopup(pid, "#32768"),
      (hwnd) => !hwnd,
      { error: `${key} menu stayed open` },
    );
  }
}

async function testFindKeys(client: ControlClient, frame: number, pid: number): Promise<void> {
  sendCommandSync(frame, cmdId("CmdFindFirst"));
  const edit = await waitForFocusClass(frame, "Edit");
  const combo = getParentWindow(edit);
  const popup = getParentWindow(combo);
  for (const term of ["Chapter One", "Chapter Two"]) {
    sendText(edit, term);
    await pressKey(edit, VK_RETURN);
  }
  sendCommandSync(frame, cmdId("CmdGoToFirstPage"));
  sendText(edit, "");
  for (const target of [popup, combo]) {
    await pressKey(target, VK_G);
    await expectState(client, 1);
    await pressKey(target, VK_THREE);
    await expectState(client, 1);
  }
  await ctrlKey(client, popup, VK_K);
  await expectState(client, 2);
  for (const target of [popup, combo, edit]) {
    await pressKey(target, VK_HOME);
    await expectState(client, 2);
  }
  sendMessage(combo, CB_SHOWDROPDOWN, 1, 0);
  const history = await pollUntil(() => findPopup(pid, "ComboLBox"), Boolean, {
    error: "find history unavailable",
  });
  await pressKey(history, VK_G);
  await expectState(client, 2);
  await pressKey(history, VK_THREE);
  await expectState(client, 2);
  await pressKey(history, VK_ESCAPE);
  sendMessage(combo, CB_SHOWDROPDOWN, 0, 0);
  sendText(edit, "");
  await pressKey(edit, VK_G);
  await pressKey(edit, VK_THREE);
  assert.equal(getControlText(edit), "g3", "find edit lost text input");
  await expectState(client, 2);
  await menuKeys(pid, frame, edit);
}

async function testModeKeys(client: ControlClient, frame: number): Promise<void> {
  for (const vim of [false, true]) {
    sendCommandSync(frame, cmdId("CmdToggleVimKeys"));
    assert.ok((await keyState(client)).includes(`mode=${vim ? 1 : 0} `));
    sendCommandSync(frame, cmdId("CmdToggleReadingBar"));
    const before = String((await client.request(ControlCommand.TestReadingBar))[1]);
    assert.match(before, /on=1/);
    await pressKey(frame, VK_THREE);
    assert.match(await keyState(client), /count=3 prefix=-/);
    await ctrlKey(client, frame, VK_DOWN);
    const after = String((await client.request(ControlCommand.TestReadingBar))[1]);
    assert.notEqual(/yFrac=(\d+)/.exec(after)?.[1], /yFrac=(\d+)/.exec(before)?.[1], "reading bar did not move");
    await expectState(client, 1);
    await pressKey(frame, VK_ESCAPE);

    sendCommandSync(frame, cmdId("CmdAnnotationHighlightBrush"));
    assert.match(String((await client.request(ControlCommand.TestMarkupAnnots))[1]), /highlighterPlacement active=1/);
    await pressKey(frame, VK_THREE);
    await pressKey(frame, VK_RETURN);
    assert.match(String((await client.request(ControlCommand.TestMarkupAnnots))[1]), /highlighterPlacement active=0/);
    await expectState(client, 1);

    sendCommandSync(frame, cmdId("CmdSelectTextViaKeyboard"));
    const caret = String((await client.request(ControlCommand.TestSelectTextKeyboard))[1]);
    assert.match(caret, /active=1/);
    await pressKey(frame, VK_THREE);
    await pressKey(frame, VK_RIGHT);
    const moved = String((await client.request(ControlCommand.TestSelectTextKeyboard))[1]);
    assert.notEqual(/glyph=(-?\d+)/.exec(moved)?.[1], /glyph=(-?\d+)/.exec(caret)?.[1], "selection caret did not move");
    await expectState(client, 1);
    await pressKey(frame, VK_ESCAPE);
  }
}

export async function testit(): Promise<void> {
  if (!IS_WIN || USE_NG) {
    console.log("SKIP keyboard-input-targets: Win32 input routing");
    return;
  }
  const pdf = tmpPath("keyboard-input-targets.pdf");
  writeFileSync(pdf, makeBookmarkedPdf());
  const appdata = writeAppdata(
    "keyboard-input-targets-settings",
    "UiLanguage = en\nVimKeys = true\nRestoreSession = false\nShowToc = true\nShortcuts [\n [\n  Cmd = CmdGoToNextPage\n  Key = g\n ]\n [\n  Cmd = CmdGoToNextPage\n  Key = Ctrl+K\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    await activateTestFrame(client);
    await testModeKeys(client, frame);

    const toolbar = findChildWindow(frame, "SUMATRA_VIRT_TOOLBAR");
    assert.ok(toolbar, "toolbar unavailable");
    await pressKey(frame, VK_THREE);
    await pressKey(frame, VK_Z);
    assert.match(await keyState(client), /count=3 prefix=z/);
    await client.request(ControlCommand.TestFocusState, ["toolbar"]);
    assert.equal(getFocusedHwnd(frame), toolbar, "toolbar did not receive focus");
    await expectState(client, 1);
    await pressKey(toolbar, VK_THREE);
    await pressKey(toolbar, VK_Z);
    await expectState(client, 1);
    await pressKey(toolbar, VK_G);
    await expectState(client, 2);

    await testFindKeys(client, frame, proc.pid!);
    await client.request(ControlCommand.TestFindUiState, ["toggle-first"]);
    await testFindKeys(client, frame, proc.pid!);
    await activateTestFrame(client);
    const toc = findSidebarTree(frame, true);
    assert.ok(toc, "bookmarks unavailable");
    await clickAt(toc.hwnd, 40, 5);
    assert.equal(getFocusedHwnd(frame), toc.hwnd, "tree did not receive focus");
    await menuKeys(proc.pid!, frame, toc.hwnd);
    console.log("keyboard-input-targets: special modes, toolbar, both find UIs, history and menu keys passed");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
