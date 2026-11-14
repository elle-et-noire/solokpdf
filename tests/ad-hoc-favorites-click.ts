import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath } from "./util";
import { clickAt, killAndWait, launchControlled, sendCommandSync } from "./win-automation";
import { findChildWindow, isWindowVisible, sendMessage, sleep } from "./winapi";

// E45: clicking a favorite navigates once, so one Back returns to where the click came from.
const TEST_STATE = 0x8000 + 102;

async function page(client: ControlClient): Promise<string | undefined> {
  const tab = String((await client.request(ControlCommand.TestCurrentTab, []))[1]);
  return /page=(\d+)/.exec(tab)?.[1];
}

export async function testit(): Promise<void> {
  const dir = tmpPath("favorites-click");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "favorites-click.pdf");
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
  writeFileSync(join(appdata, SETTINGS_FILE), "ShowToc = false\nShowFavorites = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    for (const pageNo of [1, 3]) {
      const result = await client.request(ControlCommand.TestFavoriteNav, ["add", pageNo]);
      assert.equal(result[0], 0, `adding favorite ${pageNo}: ${result}`);
    }
    const tree = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    assert.ok(tree, "favorites tree unavailable");
    if (!isWindowVisible(tree)) sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    for (const deadline = Date.now() + 3000; !isWindowVisible(tree) && Date.now() < deadline; ) await sleep(40);
    assert.ok(isWindowVisible(tree), "favorites sidebar did not open");

    const state = (field: number) => Number(sendMessage(tree, TEST_STATE, field, 0));
    const rowDy = state(3);
    if (state(0) === 1) await clickAt(tree, 5, Math.floor(rowDy / 2), 0, 0, client);
    assert.equal(state(0), 3, "file row did not expand");

    sendCommandSync(frame, cmdId("CmdGoToFirstPage"));
    await client.waitForRenderIdle();
    assert.equal(await page(client), "1", "could not start on page 1");
    await clickAt(tree, rowDy * 4, Math.floor(rowDy * 2.5), 0, 0, client);
    await client.waitForRenderIdle();
    assert.equal(await page(client), "3", "favorite click did not navigate");
    sendCommandSync(frame, cmdId("CmdNavigateBack"));
    await client.waitForRenderIdle();
    assert.equal(await page(client), "1", "one Back did not undo the favorite click");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
