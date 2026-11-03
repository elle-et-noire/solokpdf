import { existsSync, readFileSync, rmSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { sleep } from "./winapi.ts";

export async function testit(): Promise<void> {
  const logPath = tmpPath("b69-shell-launch.log");
  rmSync(logPath, { force: true });
  const { proc, client } = await launchControlled(["-log-to-file", logPath]);
  try {
    const res = await client.request(ControlCommand.TestInvokeCommand, ["CmdShowLog"]);
    if (res[0] !== 0) throw new Error(`CmdShowLog failed: ${res[1]}`);
    for (let i = 0; i < 40; i++) {
      const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      if (log.includes("Blocked shell launch during testing")) return;
      await sleep(50);
    }
    throw new Error("CmdShowLog reached the shell launch path");
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
