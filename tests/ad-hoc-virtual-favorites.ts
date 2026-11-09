import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath } from "./util";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation";
import {
  findChildWindow,
  captureWindowToPng,
  captureWindowPixels,
  getParentWindow,
  getWindowRect,
  isWindowVisible,
  sendMessage,
  sendText,
  sleep,
  VK_END,
  VK_RETURN,
  WM_KEYDOWN,
} from "./winapi";

const TEST_STATE = 0x8000 + 102;

export async function testit(): Promise<void> {
  const dir = tmpPath("virtual-favorites");
  mkdirSync(dir, { recursive: true });
  const fileName = "日本語 אבג (2026).pdf";
  const pdf = join(dir, fileName);
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]),
  );
  const appdata = join(dir, "appdata");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), "ShowToc = false\nShowFavorites = false\nUseTabs = true\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf], {
    env: { SOLOKPDF_VIRTUAL_FAVORITES: "1" },
  });
  try {
    await client.waitForRenderIdle();
    for (const page of [1, 3]) {
      const result = await client.request(ControlCommand.TestFavoriteNav, ["add", page]);
      assert.equal(result[0], 0, `adding favorite ${page}: ${result}`);
    }
    const sidebarTree = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    const canvas = findChildWindow(frame, "SUMATRA_PDF_CANVAS");
    assert.ok(sidebarTree && canvas, "favorites sidebar or document canvas unavailable");
    if (!isWindowVisible(sidebarTree)) sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    const sidebarDeadline = Date.now() + 3000;
    let sidebarRect = getWindowRect(sidebarTree);
    // Showing the panel schedules its layout on the UI queue.
    while (
      (!isWindowVisible(sidebarTree) ||
        sidebarRect.right <= sidebarRect.left ||
        sidebarRect.bottom <= sidebarRect.top) &&
      Date.now() < sidebarDeadline
    ) {
      await sleep(40);
      sidebarRect = getWindowRect(sidebarTree);
    }
    assert.ok(isWindowVisible(sidebarTree), "favorites sidebar did not open");
    assert.ok(
      sidebarRect.right > sidebarRect.left && sidebarRect.bottom > sidebarRect.top,
      "favorites layout timed out",
    );
    assert.equal(sidebarRect.bottom, getWindowRect(canvas).bottom, "favorites and document bottom edges differ");
    sendCommandSync(frame, cmdId("CmdFavoriteShowInTab"));
    const tree = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    assert.ok(tree, "virtual favorites tree unavailable");
    const state = (field: number) => Number(sendMessage(tree, TEST_STATE, field, 0));
    assert.equal(state(0), 3, "favorites tab did not expand the file");
    assert.equal(state(5), 1, "file name was not measured in bold");
    sendMessage(tree, WM_KEYDOWN, VK_END, 0);
    assert.equal(state(1), 2, "keyboard selection did not reach the last favorite");
    assert.ok((await client.layout()).items.favoritesTab?.visible, "keyboard selection navigated away");
    sendMessage(tree, WM_KEYDOWN, VK_RETURN, 0);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if ((await client.chapterInfo()).page === 3) break;
      } catch {}
      await sleep(50);
    }
    assert.equal((await client.chapterInfo()).page, 3, "Enter did not open the selected favorite");
    sendCommandSync(frame, cmdId("CmdFavoriteShowInTab"));
    const panel = getParentWindow(getParentWindow(tree));
    const filter = findChildWindow(panel, "Edit");
    assert.ok(filter, "favorites filter unavailable");
    sendText(filter, fileName);
    assert.equal(state(0), 2, "file-name filter did not retain both favorites");
    assert.equal(state(11), Buffer.byteLength(fileName), "file-name span was not measured in bold");
    assert.equal(state(12), 1, "mixed-direction text did not use a single layout");
    assert.ok(captureWindowToPng(tree, join(dir, "favorites.png")), "capturing filtered favorites failed");
    const pixels = captureWindowPixels(tree);
    assert.ok(pixels, "capturing filtered favorite pixels failed");
    const bg = pixels.data.slice(0, 3);
    let ink = 0;
    const rowHeight = state(3);
    for (let y = 0; y < rowHeight; y++) {
      for (let x = rowHeight; x < Math.min(pixels.w, 250); x++) {
        const p = (y * pixels.w + x) * 4;
        if (pixels.data[p] !== bg[0] || pixels.data[p + 1] !== bg[1] || pixels.data[p + 2] !== bg[2]) ink++;
      }
    }
    assert.ok(ink > 20, "filtered favorite text was not painted");
    sendText(filter, "missing favorite");
    assert.equal(state(0), 0, "empty favorites filter did not clear rows");
    sendText(filter, "");
    assert.equal(state(0), 3, "clearing favorites filter did not restore the tree");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
