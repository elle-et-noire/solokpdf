import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pollUntil, skipTest, tmpPath } from "./util.ts";
import { waitForProcessExit } from "./winapi.ts";

const timeoutMs = 3500;
const sleepMs = 30_000;

function command(mode: string, dir: string, dummyPid?: number): string[] {
  return [process.execPath, import.meta.path, "--worker", mode, dir, String(dummyPid ?? 0)];
}

async function worker(mode: string, dir: string, dummyPid: number): Promise<number> {
  if (mode === "dummy" || mode === "grandchild" || mode === "orphan") {
    writeFileSync(join(dir, mode), String(process.pid));
    await Bun.sleep(sleepMs);
    return 0;
  }
  if (mode === "child" || mode === "timeout") {
    writeFileSync(join(dir, mode), String(process.pid));
    const child = Bun.spawn(command(mode === "timeout" ? "child" : "grandchild", dir));
    await child.exited;
    return 0;
  }
  if (mode === "leak") {
    Bun.spawn(command("orphan", dir), { detached: true, stdio: ["ignore", "ignore", "ignore"] }).unref();
    await pollUntil(() => existsSync(join(dir, "orphan")), Boolean);
    return 0;
  }

  const { runCiWorker } = await import("./run-github-ci.ts");
  return runCiWorker([
    mode,
    () => {
      if (mode === "skip") return skipTest("optional fixture unavailable");
      if (mode === "fail") throw new Error("intentional test failure");
      if (mode === "next") {
        for (const member of ["timeout", "child", "grandchild", "orphan"]) {
          const pid = Number(readFileSync(join(dir, member), "utf8"));
          assert.ok(waitForProcessExit(pid, 0), `${member} ${pid} survived job cleanup`);
        }
        assert.ok(!waitForProcessExit(dummyPid, 0), "same-name process outside the job was terminated");
        appendFileSync(join(dir, "next"), "once\n");
        return skipTest("optional check unavailable", "part");
      }
    },
  ]);
}

export async function testit(): Promise<void> {
  const { runCiJobs } = await import("./run-github-ci.ts");
  const dir = mkdtempSync(tmpPath("github-ci-runner-"));
  const dummy = Bun.spawn(command("dummy", dir));
  try {
    const jobs = ["timeout", "leak", "next", "pass", "skip", "fail"].map((name) => ({
      name,
      command: command(name, dir, dummy.pid),
    }));
    assert.deepEqual(await runCiJobs(jobs, timeoutMs), {
      passed: 1,
      partial: 1,
      skipped: 1,
      failures: ["timeout", "leak", "fail"],
    });
    assert.equal(readFileSync(join(dir, "next"), "utf8"), "once\n");
    assert.equal(readFileSync(join(dir, "dummy"), "utf8"), String(dummy.pid));
    assert.ok(!waitForProcessExit(dummy.pid, 0));
    console.log("github-ci-runner: isolated timeout and leak cleanup, distinct test outcomes");
  } finally {
    dummy.kill();
    await dummy.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--worker") {
    const [, , , mode, dir, dummyPid] = process.argv;
    process.exit(await worker(mode!, dir!, Number(dummyPid)));
  }
  await testit();
}
