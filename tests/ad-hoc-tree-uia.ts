// UI Automation and MSAA for the default sidebar trees. Run with VS tools in PATH.
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTocPdf } from "./issue-6167";
import { ROOT, cmdId, runStandalone, tmpPath, USE_NG, writeAppdata } from "./util";
import { ControlCommand } from "./control";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation";
import { findChildWindow, moveWindow, sendMessage } from "./winapi";

export async function testit(): Promise<void> {
  if (USE_NG) {
    throw new Error("This tests the Windows sidebar trees");
  }
  const exe = tmpPath("ad-hoc-tree-uia-client.exe");
  const build = Bun.spawnSync([
    "cl.exe",
    "/nologo",
    "/EHsc",
    join(ROOT, "tests", "ad-hoc-tree-uia.cpp"),
    `/Fe${exe}`,
    `/Fo${tmpPath("ad-hoc-tree-uia-client.obj")}`,
    "/link",
    "ole32.lib",
    "oleacc.lib",
    "oleaut32.lib",
    "user32.lib",
    "uiautomationcore.lib",
  ]);
  assert.equal(build.exitCode, 0, `UIA client build failed:\n${build.stdout}\n${build.stderr}`);

  const pdf = tmpPath("ad-hoc-tree-uia.pdf");
  writeFileSync(pdf, makeTocPdf(10));
  const appdata = writeAppdata("ad-hoc-tree-uia-settings", "NoHomeTab = true\nShowToc = true\nUiLanguage = en\n");
  const favorites = process.argv.includes("--favorites");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    if (favorites) {
      const result = await client.request(ControlCommand.TestFavoriteNav, ["add", 1]);
      assert.equal(result[0], 0, `adding favorite: ${result}`);
      sendCommandSync(frame, cmdId("CmdFavoriteShowInTab"));
    }
    moveWindow(frame, 0, 0, 900, 250);
    const tree = findChildWindow(frame, favorites ? "SumatraVirtualFavoritesTree" : "SumatraVirtualBookmarksTree");
    assert.ok(tree, "bookmarks tree unavailable");
    const args = [exe, String(tree), favorites ? "favorites" : "bookmarks"];
    if (process.argv.includes("--scroll-item")) {
      args.push("scroll-item");
    }
    const probe = Bun.spawnSync(args, { timeout: 30000 });
    assert.equal(probe.exitCode, 0, `UIA probe failed:\n${probe.stdout}\n${probe.stderr}`);
    assert.equal(Number(sendMessage(tree, 0x8000 + 102, 13, 0)), 1, "updating the tree name failed");
    const changed = Bun.spawnSync([exe, String(tree), "changed"], { timeout: 30000 });
    assert.equal(changed.exitCode, 0, `updated UIA name failed:\n${changed.stdout}\n${changed.stderr}`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
