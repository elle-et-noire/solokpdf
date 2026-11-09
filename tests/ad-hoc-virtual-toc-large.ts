import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { sidebarRowText } from "./sidebar-tree";
import { assemblePdf, cmdId, runStandalone, tmpPath, writeAppdata } from "./util";
import { killAndWait, launchControlled, pressEnter, pressKey, sendCommand, waitToolWindow } from "./win-automation";
import {
  findChildWindow,
  getParentWindow,
  sendMessage,
  sendText,
  sleep,
  VK_DOWN,
  VK_END,
  VK_HOME,
  WM_KEYDOWN,
} from "./winapi";

const kCount = 4000;
const kTestState = 0x8000 + 102;

export async function testit(): Promise<void> {
  const pdf = tmpPath("virtual-toc-large.pdf");
  const outlines = Array.from({ length: kCount }, (_, i) => {
    const id = i + 5;
    const prev = i ? ` /Prev ${id - 1} 0 R` : "";
    const next = i + 1 < kCount ? ` /Next ${id + 1} 0 R` : "";
    return `<< /Title (Chapter ${i + 1}) /Parent 4 0 R${prev}${next} /Dest [3 0 R /Fit] >>`;
  });
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      `<< /Type /Outlines /First 5 0 R /Last ${kCount + 4} 0 R /Count ${kCount} >>`,
      ...outlines,
    ]),
  );
  const appdata = writeAppdata(
    "virtual-toc-large-settings",
    "ShowToc = true\nShowFavorites = false\nScrollbars = windows\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    const hwnd = findChildWindow(frame, "SumatraVirtualBookmarksTree");
    assert.ok(hwnd, "virtual bookmarks tree unavailable");
    const state = (field: number) => Number(sendMessage(hwnd, kTestState, field, 0));
    assert.equal(state(0), kCount, "bookmarks not populated");
    sendMessage(hwnd, WM_KEYDOWN, VK_END, 0);
    assert.equal(state(1), kCount - 1, "End did not select the last bookmark");
    assert.ok(state(2) > 65535, "scroll position was truncated");
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
      const deadline = Date.now() + 3000;
      while (state(7) !== expected && Date.now() < deadline) await sleep(30);
      assert.equal(state(7), expected, "scrollbar mode did not change");
      sendMessage(hwnd, WM_KEYDOWN, VK_HOME, 0);
      assert.equal(state(2), 0, `mode ${expected}: Home did not reach the top`);
      sendMessage(hwnd, WM_KEYDOWN, VK_END, 0);
      assert.equal(state(1), kCount - 1, `mode ${expected}: End did not select the last bookmark`);
      assert.ok(state(2) > 65535, `mode ${expected}: scroll position was truncated`);
    }
    const tree = { hwnd, virtual: true };
    assert.equal(sidebarRowText(tree, kCount - 1), `Chapter ${kCount}`);
    const filter = findChildWindow(getParentWindow(getParentWindow(hwnd)), "Edit");
    assert.ok(filter, "bookmarks filter unavailable");
    sendText(filter, `Chapter ${kCount}`);
    assert.equal(state(0), 1, "filter did not find the last bookmark");
    assert.equal(sidebarRowText(tree, 0), `Chapter ${kCount}`);
    sendText(filter, "");
    assert.equal(state(0), kCount, "clearing the filter did not restore bookmarks");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
