import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath } from "./util";
import {
  killAndWait,
  launchControlled,
  moveTestCursor,
  pressEnter,
  pressKey,
  sendCommand,
  waitToolWindow,
} from "./win-automation";
import {
  clientToScreen,
  findChildWindow,
  getParentWindow,
  getScrollInfo,
  getWindowRect,
  packCoords,
  sendMessage,
  sendText,
  SB_HORZ,
  sleep,
  VK_END,
  VK_DOWN,
  VK_HOME,
  VK_LEFT,
  VK_RIGHT,
  WM_KEYDOWN,
  WM_LBUTTONDOWN,
  WM_MOUSELEAVE,
  WM_MOUSEMOVE,
} from "./winapi";

const TEST_STATE = 0x8000 + 102;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_HSCROLL = 0x0114;
const SB_LEFT = 6;

export async function testit(): Promise<void> {
  const pdf = tmpPath("virtual-toc.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Outlines /First 7 0 R /Last 9 0 R /Count 3 >>",
      "<< /Title (First) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>",
      "<< /Title (Second) /Parent 6 0 R /Prev 7 0 R /Next 9 0 R /First 10 0 R /Last 10 0 R /Count -1 /Dest [4 0 R /Fit] >>",
      "<< /Title (Third) /Parent 6 0 R /Prev 8 0 R /F 2 /C [1 0 0] /Dest [5 0 R /Fit] >>",
      "<< /Title (Nested) /Parent 8 0 R /Dest [5 0 R /Fit] >>",
    ]),
  );
  const appdata = tmpPath("virtual-toc-settings");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), "ShowToc = true\nShowFavorites = false\nScrollbars = windows\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    let tree = 0;
    const deadline = Date.now() + 10000;
    while (!tree && Date.now() < deadline) {
      tree = findChildWindow(frame, "SumatraVirtualBookmarksTree");
      if (!tree) await sleep(50);
    }
    assert.ok(tree, "virtual TOC host unavailable");
    const canvas = findChildWindow(frame, "SUMATRA_PDF_CANVAS");
    assert.ok(canvas, "document canvas unavailable");
    assert.equal(getWindowRect(tree).bottom, getWindowRect(canvas).bottom, "tree and document bottom edges differ");
    const state = (field: number, value = 0) => Number(sendMessage(tree, TEST_STATE, field, value));
    assert.equal(state(0), 3, "TOC rows");
    assert.equal(state(1), 0, "initial selection");
    assert.equal(state(5, 2), 1, "bold bookmark font was not measured");
    assert.equal(state(6, 2), 0x0000ff, "bookmark text color was not applied");
    const dpi = state(10);
    const height = state(3);
    sendMessage(tree, TEST_STATE, 9, Math.round((dpi * 3) / 2));
    assert.ok(state(3) > height, "DPI update did not change row height");
    sendMessage(tree, TEST_STATE, 9, dpi);
    assert.equal(state(3), height, "restoring DPI did not restore row height");
    const waitPage = async (page: number) => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        if ((await client.chapterInfo()).page === page) return;
        await sleep(50);
      }
      assert.fail(`page ${page} was not reached`);
    };
    sendMessage(tree, WM_KEYDOWN, VK_END, 0);
    await waitPage(3);
    assert.equal(state(1), 2, "End selection");
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    await waitPage(1);
    assert.equal(state(1), 0, "Home selection");
    sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(60, state(3) + Math.floor(state(3) / 2)));
    await waitPage(2);
    assert.equal(state(1), 1, "mouse selection");
    sendMessage(tree, WM_LBUTTONDOWN, 0, packCoords(5, state(3) + Math.floor(state(3) / 2)));
    assert.equal(state(0), 4, "mouse expansion");
    sendMessage(tree, WM_KEYDOWN, VK_RIGHT, 0);
    await waitPage(3);
    assert.equal(state(1), 2, "keyboard selection of child");
    sendMessage(tree, WM_KEYDOWN, VK_LEFT, 0);
    await waitPage(2);
    sendMessage(tree, WM_KEYDOWN, VK_LEFT, 0);
    assert.equal(state(0), 3, "keyboard collapse");
    sendMessage(tree, WM_LBUTTONDBLCLK, 0, packCoords(60, state(3) + Math.floor(state(3) / 2)));
    assert.equal(state(0), 4, "double-click expansion");
    const panel = getParentWindow(getParentWindow(tree));
    const filter = findChildWindow(panel, "Edit");
    assert.ok(filter, "TOC filter unavailable");
    sendText(filter, "Nested");
    assert.equal(state(0), 1, "filter did not replace the model");
    sendText(filter, "missing bookmark");
    assert.equal(state(0), 0, "empty filter result did not clear the model");
    sendText(filter, "");
    assert.equal(state(0), 3, "clearing the filter did not restore the model");
    assert.equal(state(7), 0, "initial scrollbar mode");
    for (const [key, expected] of [
      [VK_DOWN, 2],
      [VK_DOWN, 1],
      [VK_DOWN, 3],
      [VK_HOME, 0],
    ]) {
      sendCommand(frame, cmdId("CmdChangeScrollbar"));
      const dialog = await waitToolWindow(client, proc.pid!, "changescrollbar", { exclude: frame });
      assert.ok(dialog, "scrollbar dialog unavailable");
      await pressKey(dialog, key!, 50);
      await pressEnter(dialog);
      const modeDeadline = Date.now() + 3000;
      while (state(7) !== expected && Date.now() < modeDeadline) await sleep(30);
      assert.equal(state(7), expected, "scrollbar setting change did not reach the tree");
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }

  const rtlPdf = tmpPath("virtual-toc-rtl.pdf");
  writeFileSync(
    rtlPdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
      `<< /Title <FEFF${"05D005D105D2".repeat(80)}> /Parent 4 0 R /Dest [3 0 R /Fit] >>`,
    ]),
  );
  const rtl = await launchControlled(["-appdata", appdata, rtlPdf]);
  try {
    await rtl.client.waitForRenderIdle();
    const tree = findChildWindow(rtl.frame, "SumatraVirtualBookmarksTree");
    assert.ok(tree, "RTL virtual TOC host unavailable");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 4, 0)), 1, "document RTL did not reach the virtual tree");
    sendMessage(tree, WM_HSCROLL, SB_LEFT, 0);
    assert.ok(getScrollInfo(tree, SB_HORZ).pos > 0, "RTL horizontal scroll did not move");
    const filter = findChildWindow(getParentWindow(getParentWindow(tree)), "Edit");
    assert.ok(filter, "RTL bookmarks filter unavailable");
    sendText(filter, "אבג");
    assert.equal(Number(sendMessage(tree, TEST_STATE, 0, 0)), 1, "RTL filter did not retain the bookmark");
    assert.equal(getScrollInfo(tree, SB_HORZ).pos, 0, "RTL filter did not return to the beginning of the title");
  } finally {
    rtl.client.close();
    await killAndWait(rtl.proc);
  }

  const tipPdf = tmpPath("virtual-toc-tip.pdf");
  writeFileSync(
    tipPdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
      "<< /Title (External) /Parent 4 0 R /A << /S /URI /URI (https://example.org/) >> >>",
    ]),
  );
  const tip = await launchControlled(["-appdata", appdata, tipPdf]);
  try {
    await tip.client.waitForRenderIdle();
    const tree = findChildWindow(tip.frame, "SumatraVirtualBookmarksTree");
    assert.ok(tree, "tooltip tree unavailable");
    const screen = clientToScreen(tree, 50, 5);
    await moveTestCursor(screen.x, screen.y, tip.client);
    sendMessage(tree, WM_MOUSEMOVE, 0, packCoords(50, 5));
    await moveTestCursor(screen.x + 10000, screen.y, tip.client);
    await sleep(1200);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 8, 0)), 0, "tooltip appeared after the cursor left");
    await moveTestCursor(screen.x, screen.y, tip.client);
    sendMessage(tree, WM_MOUSEMOVE, 0, packCoords(50, 5));
    const until = Date.now() + 4000;
    while (Number(sendMessage(tree, TEST_STATE, 8, 0)) !== 1 && Date.now() < until) await sleep(50);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 8, 0)), 1, "link tooltip did not appear");
    const dpi = Number(sendMessage(tree, TEST_STATE, 10, 0));
    sendMessage(tree, TEST_STATE, 9, Math.round((dpi * 3) / 2));
    assert.equal(Number(sendMessage(tree, TEST_STATE, 8, 0)), 0, "tooltip did not close on DPI change");
    sendMessage(tree, WM_MOUSEMOVE, 0, packCoords(50, 5));
    const afterDpi = Date.now() + 4000;
    while (Number(sendMessage(tree, TEST_STATE, 8, 0)) !== 1 && Date.now() < afterDpi) await sleep(50);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 8, 0)), 1, "tooltip did not reopen after DPI change");
    sendMessage(tree, WM_KEYDOWN, VK_HOME, 0);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 8, 0)), 0, "tooltip did not close on keyboard input");
    sendMessage(tree, WM_MOUSEMOVE, 0, packCoords(50, 5));
    const reopen = Date.now() + 4000;
    while (Number(sendMessage(tree, TEST_STATE, 8, 0)) !== 1 && Date.now() < reopen) await sleep(50);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 8, 0)), 1, "tooltip did not reopen");
    sendMessage(tree, WM_MOUSELEAVE, 0, 0);
    assert.equal(Number(sendMessage(tree, TEST_STATE, 8, 0)), 0, "tooltip did not close on leave");
  } finally {
    tip.client.close();
    await killAndWait(tip.proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
