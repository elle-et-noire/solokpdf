import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { assemblePdf, cmdId, runStandalone, tmpPath, writeAppdata } from "./util";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation";
import {
  findChildWindow,
  getParentWindow,
  getScrollInfo,
  sendMessage,
  sendText,
  SB_HORZ,
  VK_END,
  WM_KEYDOWN,
} from "./winapi";

const WM_HSCROLL = 0x0114;
const SB_RIGHT = 7;

export async function testit(): Promise<void> {
  const pdf = tmpPath("favorites-filter-scroll.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]),
  );
  const favorites = Array.from(
    { length: 400 },
    (_, i) => `    [\n      Name = Favorite ${i + 1} ${"long title ".repeat(12)}\n      PageNo = ${i + 1}\n    ]`,
  ).join("\n");
  const appdata = writeAppdata(
    "favorites-filter-scroll",
    `ShowFavorites = false\nScrollbars = windows\nFileStates [\n  [\n    FilePath = ${pdf}\n    Favorites [\n${favorites}\n    ]\n  ]\n]\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdFavoriteShowInTab"));
    const tree = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    assert.ok(tree, "favorites tree unavailable");
    const pos = () => Number(sendMessage(tree, 0x8000 + 102, 2, 0));
    sendMessage(tree, WM_KEYDOWN, VK_END, 0);
    assert.ok(pos() > 0, "initial scroll failed");
    sendMessage(tree, WM_HSCROLL, SB_RIGHT, 0);
    assert.ok(getScrollInfo(tree, SB_HORZ).pos > 0, "horizontal scroll failed");
    const filter = findChildWindow(getParentWindow(getParentWindow(tree)), "Edit");
    assert.ok(filter, "favorites filter unavailable");
    sendText(filter, "Favorite 1");
    assert.equal(pos(), 0, "filter did not return to the first result");
    assert.equal(getScrollInfo(tree, SB_HORZ).pos, 0, "filter did not return to the start of the title");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
