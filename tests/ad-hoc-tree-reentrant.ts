import { strict as assert } from "node:assert";
import { join } from "node:path";
import { EXE, ROOT, runStandalone, tmpPath } from "./util";
import { killAndWait } from "./win-automation";
import { enumWindows, findChildWindow, getWindowPid, getWindowText, sleep } from "./winapi";

export async function testit(): Promise<void> {
  const exe = tmpPath("tree-reentrant-uia.exe");
  const build = Bun.spawnSync([
    "cl.exe",
    "/nologo",
    "/EHsc",
    join(ROOT, "tests", "ad-hoc-tree-reentrant-uia.cpp"),
    `/Fe${exe}`,
    `/Fo${tmpPath("tree-reentrant-uia.obj")}`,
    "/link",
    "ole32.lib",
    "oleacc.lib",
    "oleaut32.lib",
    "user32.lib",
    "uiautomationcore.lib",
  ]);
  assert.equal(build.exitCode, 0, `client build failed:\n${build.stdout}\n${build.stderr}`);
  for (const [mode, action] of [
    ["uia-expand", 1],
    ["uia-expand", 2],
    ["uia-scroll", 2],
    ["msaa-expand", 1],
    ["msaa-expand", 2],
    ["msaa-scroll", 2],
  ] as const) {
    const selected = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
    if (selected && selected !== `${mode}-${action}`) continue;
    const proc = Bun.spawn([EXE, "-for-testing", "-testapp"], {
      env: { ...process.env, SOLOKPDF_TEST_TREE: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      let tree = 0;
      const deadline = Date.now() + 15000;
      while (!tree && proc.exitCode === null && Date.now() < deadline) {
        enumWindows((hwnd) => {
          if (getWindowPid(hwnd) === proc.pid && getWindowText(hwnd).startsWith("Tree prototype:")) {
            tree = findChildWindow(hwnd, "SumatraTreePrototype");
            return false;
          }
          return true;
        });
        if (!tree) await sleep(50);
      }
      assert.ok(tree, `${mode}: tree unavailable`);
      const result = Bun.spawnSync([exe, String(tree), mode, String(action)], { timeout: 30000 });
      await sleep(200);
      if (proc.exitCode !== null) {
        const error = await new Response(proc.stderr).text();
        assert.fail(`${mode} action ${action}: app exited ${proc.exitCode}:\n${error}`);
      }
      assert.equal(result.exitCode, 0, `${mode} action ${action}:\n${result.stdout}\n${result.stderr}`);
    } finally {
      await killAndWait(proc);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
