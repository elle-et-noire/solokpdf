import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { cmdId, runStandalone, tmpPath } from "./util.ts";
import { sleep } from "./winapi.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";

export async function testit(): Promise<void> {
  const dir = tmpPath("no-update-check");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = true\nRestoreSession = false\n",
  );
  const logPath = join(dir, "update.log");

  const { proc, client, frame } = await launchControlled(["-appdata", dir, "-log-to-file", logPath]);
  try {
    for (const surface of ["menu", "palette"]) {
      const res = await client.request(ControlCommand.TestCommandVisibility, ["CmdCheckUpdate", surface]);
      const detail = String(res[1] ?? "");
      if (res[0] !== 0 || !/vis=hide/.test(detail)) {
        throw new Error(`Check for Updates visible in ${surface}: ${detail}`);
      }
    }

    sendCommandSync(frame, cmdId("CmdCheckUpdate"));
    await sleep(3_000);
    const log = readFileSync(logPath, "utf8");
    if (/StartAsyncUpdateCheck:|UpdateCheckAsync: response from/.test(log)) {
      throw new Error(`update request started:\n${log}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
