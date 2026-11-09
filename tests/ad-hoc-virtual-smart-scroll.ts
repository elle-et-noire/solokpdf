import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { makeTocPdf } from "./issue-6167";
import { cmdId, runStandalone, tmpPath, writeAppdata } from "./util";
import {
  activateTestFrame,
  killAndWait,
  launchControlled,
  moveTestCursor,
  pressKey,
  sendCommand,
  waitToolWindow,
} from "./win-automation";
import {
  clientToScreen,
  findChildWindow,
  getClientRect,
  getClassName,
  getWindowRect,
  moveWindow,
  sendMessage,
  sleep,
  VK_ESCAPE,
  VK_END,
  WM_KEYDOWN,
} from "./winapi";

const TEST_STATE = 0x8000 + 102;
const SMART_INVISIBLE = 1;
const SMART_THIN = 2;
const SMART_THICK = 3;

export async function testit(): Promise<void> {
  const pdf = tmpPath("virtual-smart-scroll.pdf");
  writeFileSync(pdf, makeTocPdf(6));
  const appdata = writeAppdata("virtual-smart-scroll-settings", "ShowToc = true\nScrollbars = smart\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf], {
    env: { SOLOKPDF_VIRTUAL_TOC: "1" },
  });
  try {
    await client.waitForRenderIdle();
    moveWindow(frame, 0, 0, 900, 200);
    await activateTestFrame(client);
    const tree = findChildWindow(frame, "SumatraVirtualBookmarksTree");
    assert.ok(tree, "virtual bookmarks tree unavailable");
    const state = () => Number(sendMessage(tree, TEST_STATE, 16, 0));
    const rect = getClientRect(tree);
    assert.ok(rect.bottom > 30 && rect.right > 50, "tree viewport is too small");
    const expectState = async (expected: number, message: string) => {
      const deadline = Date.now() + 3000;
      while (state() !== expected && Date.now() < deadline) await sleep(50);
      const bar = Number(sendMessage(tree, TEST_STATE, 17, 0));
      const foreground = Number(sendMessage(tree, TEST_STATE, 19, 0));
      assert.equal(
        state(),
        expected,
        `${message}; tree=${JSON.stringify(getWindowRect(tree))}, bar=${JSON.stringify(getWindowRect(bar))}, cursor=${JSON.stringify(point)}, flags=${sendMessage(tree, TEST_STATE, 18, 0)}, frame=${frame}, foreground=${foreground} (${getClassName(foreground)})`,
      );
    };
    let point = clientToScreen(tree, -30, -30);
    await moveTestCursor(point.x, point.y, client);
    await expectState(SMART_INVISIBLE, "scrollbar did not hide before hovering");
    point = clientToScreen(tree, 20, 20);
    await moveTestCursor(point.x, point.y, client);
    await expectState(SMART_THIN, "moving over the tree did not reveal a thin scrollbar");
    point = clientToScreen(tree, rect.right - 2, 20);
    await moveTestCursor(point.x, point.y, client);
    await expectState(SMART_THICK, "moving over the scrollbar did not reveal the thick scrollbar");
    sendCommand(frame, cmdId("CmdChangeScrollbar"));
    const dialog = await waitToolWindow(client, proc.pid!, "changescrollbar", { exclude: frame });
    assert.ok(dialog, "scrollbar settings dialog unavailable");
    await expectState(SMART_INVISIBLE, "scrollbar stayed visible while another window was active");
    await pressKey(dialog, VK_ESCAPE);
    await activateTestFrame(client);
    point = clientToScreen(tree, 20, 20);
    await moveTestCursor(point.x, point.y, client);
    await expectState(SMART_THIN, "scrollbar did not return after the dialog closed");
    point = clientToScreen(tree, rect.right - 2, 20);
    await moveTestCursor(point.x, point.y, client);
    await expectState(SMART_THICK, "scrollbar did not return to thick on hover");
    point = clientToScreen(tree, -30, -30);
    await moveTestCursor(point.x, point.y, client);
    await expectState(SMART_INVISIBLE, "leaving the tree did not hide the scrollbar");
    sendMessage(tree, WM_KEYDOWN, VK_END, 0);
    const rows = Number(sendMessage(tree, TEST_STATE, 0, 0));
    const rowHeight = Number(sendMessage(tree, TEST_STATE, 3, 0));
    const scroll = Number(sendMessage(tree, TEST_STATE, 2, 0));
    const dpi = Number(sendMessage(tree, TEST_STATE, 10, 0));
    const viewport = getClientRect(tree);
    assert.ok(scroll > 0, "test outline did not scroll");
    assert.equal(
      rows * rowHeight - scroll + Math.round((4 * dpi) / 96),
      viewport.bottom - viewport.top,
      "keyboard selection did not retain the bottom padding",
    );
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
