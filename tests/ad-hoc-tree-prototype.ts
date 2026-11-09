import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXE, ROOT, runStandalone, tmpPath } from "./util";
import { killAndWait } from "./win-automation";
import {
  captureWindowPixels,
  enumWindows,
  findChildWindow,
  getClientRect,
  getWindowPid,
  getWindowRect,
  getWindowText,
  isWindowVisible,
  moveWindow,
  packCoords,
  sendMessage,
  sleep,
  WM_KEYDOWN,
  WM_CHAR,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
  VK_HOME,
  VK_END,
  VK_LEFT,
  VK_RIGHT,
} from "./winapi";

const TEST_STATE = 0x8000 + 101;
const WM_HSCROLL = 0x0114;
const WM_VSCROLL = 0x0115;
const WM_MOUSEWHEEL = 0x020a;
const WM_MOUSEHWHEEL = 0x020e;
const SB_TOP = 6;
const SB_BOTTOM = 7;
const VK_ADD = 0x6b;
const VK_SUBTRACT = 0x6d;
const VK_MULTIPLY = 0x6a;
const VK_DIVIDE = 0x6f;
const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;

export async function testit(): Promise<void> {
  const proc = Bun.spawn([EXE, "-for-testing", "-testapp"], {
    env: { ...process.env, SOLOKPDF_TEST_TREE: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let frame = 0;
    const deadline = Date.now() + 10000;
    while (!frame && Date.now() < deadline) {
      enumWindows((hwnd) => {
        if (
          getWindowPid(hwnd) === proc.pid &&
          isWindowVisible(hwnd) &&
          getWindowText(hwnd).startsWith("Tree prototype:")
        ) {
          frame = hwnd;
          return false;
        }
        return true;
      });
      if (!frame) await sleep(50);
    }
    assert.ok(frame, "tree prototype did not open");
    let tree = 0;
    while (!tree && Date.now() < deadline) {
      tree = findChildWindow(frame, "SumatraTreePrototype");
      if (!tree) await sleep(50);
    }
    assert.ok(tree, "tree host unavailable");
    const state = (field: number) => Number(sendMessage(tree, TEST_STATE, field, 0));
    let initial = getClientRect(tree);
    while (initial.bottom === initial.top && Date.now() < deadline) {
      await sleep(50);
      initial = getClientRect(tree);
    }
    assert.equal(state(14), initial.bottom - initial.top, "initial viewport differs from host size");
    moveWindow(frame, 0, 0, 300, 250);
    assert.equal(state(5), 4000);
    assert.ok(state(4) > 65535, `vertical range too small: ${state(4)}`);
    assert.ok(state(3) > 0, "horizontal range missing");
    assert.ok(state(12) >= state(13), "horizontal extent does not include the longest item");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 23, 0)), 0, "direct host deletion failed");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 23, 1)), 0, "disposed host received a nested message");

    for (let mode = 0; mode < 4; mode++) {
      sendMessage(tree, WM_KEYDOWN, "1".charCodeAt(0) + mode, 0);
      assert.equal(state(0), mode);
      sendMessage(tree, WM_VSCROLL, SB_BOTTOM, 0);
      assert.equal(state(2), state(4), `mode ${mode}: vertical end`);
      sendMessage(tree, WM_HSCROLL, SB_BOTTOM, 0);
      assert.equal(state(1), state(3), `mode ${mode}: horizontal end`);
      sendMessage(tree, WM_VSCROLL, SB_TOP, 0);
      sendMessage(tree, WM_HSCROLL, SB_TOP, 0);
      assert.equal(state(2), 0);
      assert.equal(state(1), 0);
      sendMessage(tree, WM_MOUSEWHEEL, 0xff880000, 0);
      assert.ok(state(2) > 0, `mode ${mode}: wheel`);
      sendMessage(tree, WM_VSCROLL, SB_TOP, 0);
    }

    sendMessage(tree, WM_HSCROLL, SB_TOP, 0);
    sendMessage(tree, WM_MOUSEHWHEEL, 0x00780000, 0);
    assert.ok(state(1) > 0, "horizontal mouse wheel did not scroll");
    sendMessage(tree, WM_HSCROLL, SB_TOP, 0);

    sendMessage(tree, WM_KEYDOWN, "2".charCodeAt(0), 0);
    const movingOverlay = state(8);
    assert.ok(movingOverlay, "horizontal overlay unavailable");
    moveWindow(movingOverlay, 0, 0, 40, 40);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 32, 0x20000 | 0x800b)), 1, "installing mode-change hook failed");
    sendMessage(tree, WM_VSCROLL, SB_BOTTOM, 0);
    assert.equal(state(33), 1, "mode-change hook did not run");
    assert.equal(state(0), 3, "notification did not switch to hidden bars");
    sendMessage(tree, WM_KEYDOWN, "2".charCodeAt(0), 0);
    sendMessage(tree, WM_VSCROLL, SB_TOP, 0);
    const overlay = state(6);
    assert.ok(overlay, "overlay scrollbar missing");
    const bar = getClientRect(overlay);
    const width = bar.right - bar.left;
    const height = bar.bottom - bar.top;
    const x = Math.floor(width / 2);
    const top = width + 4;
    sendMessage(overlay, WM_LBUTTONDOWN, 0, packCoords(x, top));
    sendMessage(overlay, WM_MOUSEMOVE, 1, packCoords(x, height - top));
    sendMessage(overlay, WM_LBUTTONUP, 0, packCoords(x, height - top));
    assert.ok(state(2) > 65535, `overlay drag truncated: ${state(2)}`);
    const before = getWindowRect(overlay);
    moveWindow(frame, 100, 100, 300, 250);
    const after = getWindowRect(overlay);
    assert.equal(after.left - before.left, 100, "overlay did not follow window horizontally");
    assert.equal(after.top - before.top, 100, "overlay did not follow window vertically");
    sendMessage(tree, WM_VSCROLL, SB_TOP, 0);

    const collapsedWidth = state(12);
    sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(5, 5));
    assert.equal(state(5), 4002, "expand first row");
    assert.equal(state(16), 2, "mouse selection reason");
    assert.equal(state(17), 1, "mouse selection event count");
    assert.ok(state(12) > collapsedWidth, "expansion did not include the wider child");
    sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(5, 5));
    assert.equal(state(5), 4000, "collapse first row");
    assert.equal(state(17), 1, "reselecting the row emitted another selection event");
    assert.equal(state(12), collapsedWidth, "collapsed child still affects horizontal extent");
    sendMessage(tree, WM_KEYDOWN, "R".charCodeAt(0), 0);
    const rtlBar = getWindowRect(state(6));
    const rtlHost = getWindowRect(tree);
    assert.equal(rtlBar.left, rtlHost.left, "RTL vertical overlay is not at the left edge");
    sendMessage(tree, WM_HSCROLL, SB_TOP, 0);
    assert.equal(state(1), state(3), "RTL horizontal direction did not reverse");
    sendMessage(tree, WM_HSCROLL, SB_BOTTOM, 0);
    assert.equal(state(1), 0);
    const horizontal = state(8);
    const hbar = getClientRect(horizontal);
    const hwidth = hbar.right - hbar.left;
    const hheight = hbar.bottom - hbar.top;
    const hY = Math.floor(hheight / 2);
    sendMessage(horizontal, WM_LBUTTONDOWN, 0, packCoords(hwidth - hheight - 4, hY));
    sendMessage(horizontal, WM_MOUSEMOVE, 1, packCoords(hheight + 4, hY));
    sendMessage(horizontal, WM_LBUTTONUP, 0, packCoords(hheight + 4, hY));
    assert.ok(state(1) > 0, "RTL horizontal thumb drag did not move");
    sendMessage(tree, WM_HSCROLL, SB_BOTTOM, 0);
    sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(5, 5));
    assert.equal(state(5), 4002, "RTL expand hit test");
    sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(5, 5));
    assert.equal(state(5), 4000, "RTL collapse hit test");
    sendMessage(tree, WM_KEYDOWN, "R".charCodeAt(0), 0);
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    assert.equal(state(9), 10, "Home selects first row");
    sendMessage(tree, WM_MOUSEWHEEL, 0xff880000, 0);
    assert.ok(state(2) > 0);
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    assert.equal(state(2), 0, "Home did not reveal the already selected first row");
    sendMessage(tree, WM_KEYDOWN, VK_ADD, 0);
    sendMessage(tree, WM_KEYDOWN, VK_ADD, 0);
    assert.equal(state(9), 10, "keypad plus must not select a child");
    sendMessage(tree, WM_KEYDOWN, VK_RIGHT, 0);
    assert.equal(state(9), 11, "Right selects first child");
    assert.equal(state(16), 1, "keyboard selection reason");
    sendMessage(tree, WM_KEYDOWN, VK_SUBTRACT, 0);
    assert.equal(state(9), 11, "keypad minus must not select a parent");
    sendMessage(tree, WM_KEYDOWN, VK_LEFT, 0);
    sendMessage(tree, WM_KEYDOWN, VK_SUBTRACT, 0);
    sendMessage(tree, WM_KEYDOWN, VK_RIGHT, 0);
    assert.equal(state(5), 4002, "Right expands selected row");
    sendMessage(tree, WM_KEYDOWN, VK_RIGHT, 0);
    assert.equal(state(9), 11, "Right selects first child");
    sendMessage(tree, WM_KEYDOWN, VK_LEFT, 0);
    assert.equal(state(9), 10, "Left selects parent");
    sendMessage(tree, WM_KEYDOWN, VK_LEFT, 0);
    assert.equal(state(5), 4000, "Left collapses selected row");
    sendMessage(tree, WM_KEYDOWN, VK_END, 0);
    assert.ok(state(2) > 65535, "End did not reveal the last row");
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    assert.equal(state(2), 0, "Home did not reveal the first row");
    sendMessage(tree, WM_KEYDOWN, VK_NEXT, 0);
    assert.ok(state(9) > 10 && state(2) > 0, "Page Down did not move selection");
    sendMessage(tree, WM_KEYDOWN, VK_PRIOR, 0);
    assert.equal(state(9), 10, "Page Up did not return to first row");
    sendMessage(tree, WM_KEYDOWN, VK_MULTIPLY, 0);
    assert.equal(state(5), 4002, "keypad multiply did not expand subtree");
    sendMessage(tree, WM_CHAR, "*".charCodeAt(0), 0);
    sendMessage(tree, WM_CHAR, "I".charCodeAt(0), 0);
    assert.equal(state(9), 11, "translated keypad character polluted type-ahead");
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    sendMessage(tree, WM_KEYDOWN, VK_DIVIDE, 0);
    assert.equal(state(5), 4000, "keypad divide did not collapse subtree");
    sendMessage(tree, WM_CHAR, "I".charCodeAt(0), 0);
    sendMessage(tree, WM_CHAR, "I".charCodeAt(0), 0);
    assert.equal(state(9), 16, "repeated character did not cycle through matches");
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    for (const ch of "Item 13") sendMessage(tree, WM_CHAR, ch.charCodeAt(0), 0);
    assert.equal(state(9), 13, "type-ahead did not select the matching item");
    sendMessage(tree, TEST_STATE, 24, 0);
    assert.equal(state(5), 3, "small tree setup");
    moveWindow(frame, 0, 0, 300, 110);
    for (let mode = 0; mode < 4; mode++) {
      sendMessage(tree, WM_KEYDOWN, "1".charCodeAt(0) + mode, 0);
      sendMessage(tree, TEST_STATE, 22, 10);
      assert.equal(state(5), 1, `mode ${mode}: root was not collapsed`);
      assert.equal(state(4), 0, `mode ${mode}: collapsed tree should fit`);
      assert.equal(Number(sendMessage(tree, TEST_STATE, 18, 12)), 1, `mode ${mode}: selection failed`);
      assert.ok(state(2) + state(14) >= 3 * state(11), `mode ${mode}: selected child is offscreen`);
    }
    for (const event of [0x800b, 0x800a]) {
      // EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_STATECHANGE
      sendMessage(tree, TEST_STATE, 24, 0);
      sendMessage(tree, TEST_STATE, 22, 10);
      assert.equal(Number(sendMessage(tree, TEST_STATE, 32, event)), 1, "installing WinEvent hook failed");
      assert.equal(Number(sendMessage(tree, TEST_STATE, 18, 12)), 0, "selection survived a model reset");
      assert.equal(state(33), 1, "WinEvent hook did not run");
    }
    sendMessage(tree, TEST_STATE, 24, 0);
    moveWindow(frame, 0, 0, 300, 250);
    sendMessage(tree, WM_KEYDOWN, "2".charCodeAt(0), 0);
    sendMessage(tree, TEST_STATE, 27, 0);
    assert.equal(state(5), 1, "style callback did not collapse the tree");
    sendMessage(tree, TEST_STATE, 25, 1);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 26, 0)), 0, "outdated font measurement was not cancelled");
    sendMessage(tree, TEST_STATE, 28, 0);
    assert.equal(state(5), 4000, "tree model was not restored");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 18, 13)), 1, "programmatic selection failed");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 19, 11)), 1, "hidden item could not be revealed");
    assert.equal(state(5), 4002, "revealing a hidden item did not expand its parent");
    sendMessage(tree, TEST_STATE, 18, 11);
    const changesBeforeCollapse = state(17);
    sendMessage(tree, TEST_STATE, 22, 10);
    assert.equal(state(9), 10, "collapsing a parent did not select it");
    assert.equal(state(17), changesBeforeCollapse + 1, "collapse did not notify selection change");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 18, 0)), 1, "clearing selection failed");
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    sendMessage(tree, WM_KEYDOWN, VK_SUBTRACT, 0);
    sendMessage(tree, TEST_STATE, 18, 0);
    sendMessage(tree, TEST_STATE, 20, 1);
    sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(5, 5));
    assert.equal(state(5), 4000, "click expanded an item after selection rebuilt the model");
    sendMessage(tree, TEST_STATE, 10, 100);
    const row100 = state(11);
    const width100 = state(12);
    sendMessage(tree, TEST_STATE, 10, 150);
    assert.ok(state(11) > row100, "DPI change did not update row height");
    assert.ok(state(12) > width100, "DPI change did not update text width");
    sendMessage(tree, TEST_STATE, 10, 0);

    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    assert.equal(state(9), 10, "focus test did not select the first row");
    assert.equal(state(2), 0, "focus test did not reveal the first row");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 29, 0)), 1, "focus setup failed");
    const unfocusedOutline = captureWindowPixels(tree);
    assert.ok(unfocusedOutline, "focus baseline capture failed");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 29, 1)), 1, "focus outline setup failed");
    const borderDiff = () => {
      const current = captureWindowPixels(tree);
      assert.ok(current, "focus outline capture failed");
      let changed = 0;
      for (let x = 50; x < Math.min(200, current.w); x++) {
        const p = x * 4;
        if (
          current.data[p] !== unfocusedOutline.data[p] ||
          current.data[p + 1] !== unfocusedOutline.data[p + 1] ||
          current.data[p + 2] !== unfocusedOutline.data[p + 2]
        )
          changed++;
      }
      return changed;
    };
    let changed = borderDiff();
    const focusDeadline = Date.now() + 1000;
    while (changed <= 5 && Date.now() < focusDeadline) {
      await sleep(50);
      changed = borderDiff();
    }
    assert.ok(changed > 5, "focused selection has no visible outline");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 29, 2)), 1, "focus transfer failed");
    let afterBlur = borderDiff();
    const blurDeadline = Date.now() + 1000;
    while (afterBlur !== 0 && Date.now() < blurDeadline) {
      await sleep(50);
      afterBlur = borderDiff();
    }
    assert.equal(afterBlur, 0, "focus outline remained after focus moved away");
    sendMessage(tree, TEST_STATE, 29, 0);

    if (process.argv.includes("--uia")) {
      const exe = tmpPath("ad-hoc-tree-prototype-uia.exe");
      const build = Bun.spawnSync([
        "cl.exe",
        "/nologo",
        "/EHsc",
        join(ROOT, "tests", "ad-hoc-tree-prototype-uia.cpp"),
        `/Fe${exe}`,
        `/Fo${tmpPath("ad-hoc-tree-prototype-uia.obj")}`,
        "/link",
        "ole32.lib",
        "oleacc.lib",
        "oleaut32.lib",
        "user32.lib",
        "uiautomationcore.lib",
      ]);
      assert.equal(build.exitCode, 0, `UIA client build failed:\n${build.stdout}\n${build.stderr}`);
      sendMessage(tree, WM_VSCROLL, SB_BOTTOM, 0);
      const action = process.argv.includes("--delete-in-scroll-event")
        ? "4"
        : process.argv.includes("--delete-in-uia")
          ? "3"
          : "2";
      const probe = Bun.spawnSync([exe, String(tree), action], { timeout: 30000 });
      assert.equal(probe.exitCode, 0, `UIA probe failed:\n${probe.stdout}\n${probe.stderr}`);
      await sleep(100);
      assert.equal(proc.exitCode, null, "application exited while destroying the tree during selection");
    }
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
