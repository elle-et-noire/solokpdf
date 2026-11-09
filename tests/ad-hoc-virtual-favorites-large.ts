import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { sidebarRowText, sidebarSelectionInView } from "./sidebar-tree";
import { assemblePdf, cmdId, runStandalone, tmpPath, writeAppdata } from "./util";
import {
  killAndWait,
  launchControlled,
  pressEnter,
  pressKey,
  sendCommand,
  sendCommandSync,
  waitToolWindow,
} from "./win-automation";
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

const kCount = 2000;
const kTestState = 0x8000 + 102;

export async function testit(): Promise<void> {
  const pdf = tmpPath("virtual-favorites-large.pdf");
  const kids = Array.from({ length: kCount }, (_, i) => `${i + 3} 0 R`).join(" ");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Count ${kCount} /Kids [${kids}] >>`,
      ...Array.from({ length: kCount }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
    ]),
  );
  const favorites = Array.from(
    { length: kCount },
    (_, i) => `    [\n      Name = Favorite ${i + 1}\n      PageNo = ${i + 1}\n    ]`,
  ).join("\n");
  const appdata = writeAppdata(
    "virtual-favorites-large-settings",
    `ShowFavorites = false\nScrollbars = windows\nFileStates [\n  [\n    FilePath = ${pdf}\n    Favorites [\n${favorites}\n    ]\n  ]\n]\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf], {
    env: { SOLOKPDF_VIRTUAL_FAVORITES: "1" },
  });
  try {
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdFavoriteShowInTab"));
    const hwnd = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    assert.ok(hwnd, "virtual favorites tree unavailable");
    const state = (field: number) => Number(sendMessage(hwnd, kTestState, field, 0));
    const tree = { hwnd, virtual: true };
    assert.equal(state(0), kCount + 1, "favorites not populated");
    sendMessage(hwnd, WM_KEYDOWN, VK_END, 0);
    assert.equal(state(1), kCount, "End did not select the last favorite");
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
      assert.equal(state(1), kCount, `mode ${expected}: End did not select the last favorite`);
      assert.ok(sidebarSelectionInView(tree, BigInt(kCount + 1)), `mode ${expected}: last favorite was not revealed`);
    }
    assert.ok(sidebarRowText(tree, kCount).includes(`Favorite ${kCount}`));
    const filter = findChildWindow(getParentWindow(getParentWindow(hwnd)), "Edit");
    assert.ok(filter, "favorites filter unavailable");
    sendText(filter, `Favorite ${kCount}`);
    assert.equal(state(0), 1, "filter did not find the last favorite");
    assert.ok(sidebarRowText(tree, 0).includes(`Favorite ${kCount}`));
    sendText(filter, "");
    assert.equal(state(0), kCount + 1, "clearing the filter did not restore favorites");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
