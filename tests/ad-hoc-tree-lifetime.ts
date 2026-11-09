import { strict as assert } from "node:assert";
import { EXE, runStandalone } from "./util";
import { killAndWait } from "./win-automation";
import {
  enumWindows,
  findChildWindow,
  getClientRect,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  moveWindow,
  packCoords,
  sendMessage,
  sleep,
  VK_HOME,
  WM_KEYDOWN,
  WM_LBUTTONDOWN,
} from "./winapi";

const TEST_STATE = 0x8000 + 101;
const WM_VSCROLL = 0x0115;
const EVENT_OBJECT_NAMECHANGE = 0x800c;

export async function testit(): Promise<void> {
  for (const input of [
    "mouse",
    "keyboard",
    "font",
    "paint",
    "event-location",
    "event-state",
    "event-scroll",
    "event-expand",
    "event-mode",
    "event-name",
  ]) {
    const proc = Bun.spawn([EXE, "-for-testing", "-testapp"], {
      env: { ...process.env, SOLOKPDF_TEST_TREE: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      let frame = 0;
      let tree = 0;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) break;
        enumWindows((hwnd) => {
          if (getWindowPid(hwnd) === proc.pid && getWindowText(hwnd).startsWith("Tree prototype:")) {
            frame = hwnd;
            return false;
          }
          return true;
        });
        if (frame) tree = findChildWindow(frame, "SumatraTreePrototype");
        if (tree && getClientRect(tree).bottom > 0) break;
        await sleep(50);
      }
      if (proc.exitCode !== null) {
        const error = await new Response(proc.stderr).text();
        assert.fail(`${input}: app exited ${proc.exitCode} before tree opened:\n${error}`);
      }
      assert.ok(tree, `${input}: tree unavailable`);
      if (input.startsWith("event-")) {
        if (input !== "event-scroll" && input !== "event-mode" && input !== "event-name") {
          moveWindow(frame, 0, 0, 300, 110);
          sendMessage(tree, TEST_STATE, 24, 0);
          if (input !== "event-expand") sendMessage(tree, TEST_STATE, 22, 10);
        }
        const event =
          input === "event-name"
            ? EVENT_OBJECT_NAMECHANGE
            : input === "event-state" || input === "event-expand"
              ? 0x800a
              : 0x800b;
        assert.equal(Number(sendMessage(tree, TEST_STATE, 32, event | 0x10000)), 1, `${input}: hook failed`);
        if (input === "event-name") sendMessage(tree, TEST_STATE, 35, 0);
        else if (input === "event-scroll")
          sendMessage(tree, WM_VSCROLL, 7, 0); // SB_BOTTOM
        else if (input === "event-mode") sendMessage(tree, WM_KEYDOWN, "2".charCodeAt(0), 0);
        else if (input === "event-expand") sendMessage(tree, TEST_STATE, 22, 10);
        else sendMessage(tree, TEST_STATE, 18, 12);
      } else if (input === "font") {
        sendMessage(tree, TEST_STATE, 25, 2);
        sendMessage(tree, TEST_STATE, 26, 0);
      } else if (input === "paint") {
        sendMessage(tree, TEST_STATE, 27, 2);
      } else {
        sendMessage(tree, TEST_STATE, 20, 3);
        if (input === "mouse") sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(5, 5));
        else sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
      }
      await sleep(500);
      if (proc.exitCode !== null) {
        const error = await new Response(proc.stderr).text();
        assert.fail(`${input}: app exited after tree deletion:\n${error}`);
      }
      assert.equal(isWindowVisible(frame), false, `${input}: tree window was not deleted`);
    } finally {
      await killAndWait(proc);
    }
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
