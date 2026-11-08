import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WIN } from "./host.ts";
import { launchControlled } from "./win-automation.ts";
import { runStandalone, tmpPath, USE_NG } from "./util.ts";

export async function testit(): Promise<void> {
  if (!IS_WIN || USE_NG) return;
  const dir = tmpPath("startup-diagnostics-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const rtf = join(dir, "document.rtf");
  writeFileSync(rtf, String.raw`{\rtf1\ansi Hello\par}`);
  let failed = false;
  try {
    const { proc, client } = await launchControlled([rtf], { startupDiagnosticsDir: dir, controlTimeoutMs: 1 });
    client.close();
    proc.kill();
    await proc.exited;
  } catch (error) {
    if (!String(error).includes("failed to connect to Sumatra control pipe")) throw error;
    failed = true;
  }
  if (!failed) throw new Error("control connection unexpectedly succeeded");
  const report = readFileSync(join(dir, "startup-diagnostics.txt"), "utf8");
  if (!report.includes("pid:") || !report.includes("pipe:") || !report.includes("windows:")) {
    throw new Error(`startup diagnostics incomplete: ${report}`);
  }
  if (!existsSync(join(dir, "startup.dmp")) || statSync(join(dir, "startup.dmp")).size === 0)
    throw new Error(`startup dump missing: ${report}`);
  if (!existsSync(join(dir, "stderr.txt"))) throw new Error("startup stderr missing");
}

if (import.meta.main) await runStandalone(testit);
