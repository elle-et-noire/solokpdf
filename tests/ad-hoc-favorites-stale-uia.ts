import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import { assemblePdf, cmdId, ROOT, runStandalone, tmpPath, writeAppdata } from "./util";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation";
import { findChildWindow, getParentWindow, isWindowVisible, sendMessage, sendText } from "./winapi";

export async function testit(): Promise<void> {
  const exe = tmpPath("favorites-stale-uia.exe");
  const build = Bun.spawnSync([
    "cl.exe",
    "/nologo",
    "/EHsc",
    join(ROOT, "tests", "ad-hoc-favorites-stale-uia.cpp"),
    `/Fe${exe}`,
    `/Fo${tmpPath("favorites-stale-uia.obj")}`,
    "/link",
    "ole32.lib",
    "oleacc.lib",
    "oleaut32.lib",
    "user32.lib",
    "uiautomationcore.lib",
  ]);
  assert.equal(build.exitCode, 0, `client build failed:\n${build.stdout}\n${build.stderr}`);
  const pdf = tmpPath("favorites-stale-uia.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]),
  );
  const appdata = writeAppdata("favorites-stale-uia-settings", "ShowToc = false\nShowFavorites = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  let probe: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.waitForRenderIdle();
    for (const page of [1, 2]) {
      const result = await client.request(ControlCommand.TestFavoriteNav, ["add", page]);
      assert.equal(result[0], 0, `adding favorite ${page}: ${result}`);
    }
    const tree = findChildWindow(frame, "SumatraVirtualFavoritesTree");
    assert.ok(tree, "favorites tree unavailable");
    if (!isWindowVisible(tree)) sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    const filter = findChildWindow(getParentWindow(getParentWindow(tree)), "Edit");
    assert.ok(filter, "favorites filter unavailable");
    probe = Bun.spawn([exe, String(tree)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("UIA client timed out")), 10000);
    });
    const reader = probe.stdout.getReader();
    const decoder = new TextDecoder();
    let line = "";
    while (!line.includes("\n")) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      line += decoder.decode(part.value, { stream: true });
    }
    assert.equal(line.trim(), "READY", "UIA client did not start");
    sendText(filter, "Page 1");
    assert.equal(Number(sendMessage(tree, 0x8000 + 102, 0, 0)), 1, "favorites filter did not replace the model");
    probe.stdin.write("continue\n");
    probe.stdin.end();
    const exit = await Promise.race([probe.exited, timeout]);
    clearTimeout(timer);
    const error = await new Response(probe.stderr).text();
    assert.equal(exit, 0, `stale accessibility provider: ${error}`);
  } finally {
    clearTimeout(timer);
    if (probe && probe.exitCode === null) probe.kill();
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
