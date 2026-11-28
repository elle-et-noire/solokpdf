import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, waitForHome } from "./control.ts";
import {
  cmdId,
  makeTextPdf,
  pollUntil,
  ROOT,
  runStandalone,
  SETTINGS_FILE,
  tmpPath,
  USE_NG,
  vcvarsPath,
} from "./util.ts";
import {
  activateTestFrame,
  findCanvas,
  findChildByClass,
  killAndWait,
  launchControlled,
  sendCommand,
} from "./win-automation.ts";
import { isWindowVisible, postMessage, sendText, WM_CLOSE } from "./winapi.ts";

function buildClient(dir: string): string {
  const exe = join(dir, "home-uia.exe");
  const cl = `cl /nologo /EHsc /std:c++17 "${join(ROOT, "tests/ad-hoc-home-uia.cpp")}" /Fe"${exe}" /Fo"${join(dir, "home-uia.obj")}" /link ole32.lib oleaut32.lib user32.lib uiautomationcore.lib`;
  const vcvars = !Bun.which("cl") && vcvarsPath();
  const bat = join(dir, "compile.bat");
  writeFileSync(bat, `@echo off\r\n${vcvars ? `call "${vcvars}" x64 >nul && ` : ""}${cl}\r\n`);
  const result = Bun.spawnSync(["cmd.exe", "/d", "/c", bat], { cwd: dir });
  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  return exe;
}

export async function testit(): Promise<void> {
  if (USE_NG || process.platform !== "win32") return;
  if (!Bun.which("cl") && !vcvarsPath()) {
    console.log("Home UIA test requires Visual Studio C++ tools");
    return;
  }
  const dir = mkdtempSync(tmpPath("ad-hoc-home-uia-"));
  const exe = buildClient(dir);
  const folders = ["first-folder", "target-folder"];
  const files = folders.map((folder) => {
    mkdirSync(join(dir, folder));
    const path = join(dir, folder, "same.pdf");
    writeFileSync(path, makeTextPdf(folder));
    return path;
  });
  for (const mode of ["list", "thumbnails"]) {
    writeFileSync(
      join(dir, SETTINGS_FILE),
      `UiLanguage = en\nShowStartPage = true\nRestoreSession = false\nHomePageViewMode = ${mode}\nFileStates [\n` +
        files.map((path) => `[\n FilePath = ${path}\n OpenCount = 5\n]\n`).join("") +
        "]\n",
    );
    const { client, frame, proc } = await launchControlled(["-appdata", dir]);
    try {
      await waitForHome(client, (state) => state.ready && state.entries === 2, "Home has no entries");
      const canvas = findCanvas(frame);
      const edit = findChildByClass(canvas, "Edit");
      assert.ok(edit);
      const probe = Bun.spawn([exe, String(canvas)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      try {
        const lines = probe.stdout.pipeThrough(new TextDecoderStream()).getReader();
        const expect = async (stage: string) => {
          let text = "";
          while (!text.includes("\n")) {
            const result = await lines.read();
            assert.ok(!result.done, `UIA client exited during ${stage} (${mode})`);
            text += result.value;
          }
          assert.equal(text.trim(), stage);
        };
        await expect("ready");
        await activateTestFrame(client);
        sendCommand(frame, cmdId("CmdFindFirst"));
        await waitForHome(client, (state) => state.searchFocus, "Search did not get focus");
        probe.stdin.write("\n");
        probe.stdin.flush();
        await expect("selected");
        assert.ok(
          (await client.homeSelection()).searchFocus,
          "UIA selection stole search focus: " +
            JSON.stringify(await client.request(ControlCommand.TestFocusState, [])),
        );
        sendText(edit, "no-match");
        await waitForHome(client, (state) => !state.entries && state.searchFocus, "Home did not filter");
        probe.stdin.write("\n");
        probe.stdin.flush();
        await expect("filtered");
        sendText(edit, "");
        await waitForHome(client, (state) => state.entries === 2, "Home did not restore");
        probe.stdin.write("\n");
        probe.stdin.flush();
        await expect("invoked");
        await pollUntil(
          async () => String((await client.request(ControlCommand.TestCurrentTab))[1]),
          (tab) => /target-folder[\\/]same\.pdf/.test(tab),
          { error: "UIA opened a different file" },
        );
        probe.stdin.write("\n");
        probe.stdin.flush();
        await expect("switched");
        sendCommand(frame, cmdId("CmdNewWindow"));
        await pollUntil(
          async () => String((await client.request(ControlCommand.TestFindUiState, ["state"]))[1]),
          (state) => state.includes("windows=2"),
          { error: "Second window did not open" },
        );
        postMessage(frame, WM_CLOSE, 0, 0);
        await pollUntil(() => !isWindowVisible(frame), Boolean, { error: "First window did not close" });
        probe.stdin.write("\n");
        probe.stdin.end();
        assert.equal(await probe.exited, 0);
      } finally {
        await killAndWait(probe);
      }
      await client.quit();
      assert.equal(await proc.exited, 0);
    } finally {
      client.close();
      await killAndWait(proc);
    }
    console.log(`Home UIA ${mode}: selection, invocation and stale references passed`);
  }
}

if (import.meta.main) await runStandalone(testit);
