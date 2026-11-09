import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath } from "./util";
import { clickAt, killAndWait, launchControlled } from "./win-automation";
import { findChildWindow, packCoords, sendMessage, VK_LEFT, WM_KEYDOWN, WM_LBUTTONUP } from "./winapi";

const TEST_STATE = 0x8000 + 102;
const WM_LBUTTONDBLCLK = 0x0203;

export async function testit(): Promise<void> {
  const pdf = tmpPath("tree-double-click.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
      "<< /Title (Parent) /Parent 4 0 R /First 6 0 R /Last 6 0 R /Count -1 /Dest [3 0 R /Fit] >>",
      "<< /Title (Child) /Parent 5 0 R /Dest [3 0 R /Fit] >>",
    ]),
  );
  const appdata = tmpPath("tree-double-click-settings");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), "ShowToc = true\nShowFavorites = false\nScrollbars = windows\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    const tree = findChildWindow(frame, "SumatraVirtualBookmarksTree");
    assert.ok(tree, "tree unavailable");
    const rows = () => Number(sendMessage(tree, TEST_STATE, 0, 0));
    const height = Number(sendMessage(tree, TEST_STATE, 3, 0));
    const reset = () => {
      sendMessage(tree, WM_KEYDOWN, VK_LEFT, 0);
    };
    const testClick = async (x: number) => {
      reset();
      assert.equal(rows(), 1, "tree must begin collapsed");
      const y = Math.floor(height / 2);
      await clickAt(tree, x, y, 0, 0, client);
      const afterClick = rows();
      sendMessage(tree, WM_LBUTTONDBLCLK, 1, packCoords(x, y));
      sendMessage(tree, WM_LBUTTONUP, 0, packCoords(x, y));
      return [afterClick, rows()];
    };
    assert.deepEqual(await testClick(height * 3), [1, 2], "label double-click must expand once");
    assert.deepEqual(await testClick(5), [2, 1], "button double-click must follow the native toggle sequence");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
