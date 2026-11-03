import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { cmdId, makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { sendCopyDataW, sendMessage, WM_COMMAND } from "./winapi.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("b65-last-tab.pdf");
  writeFileSync(pdf, makeTextPdf("last tab state"));

  const { proc, client, frame } = await launchControlled([pdf]);
  try {
    await client.waitForRenderIdle();
    const changed = await client.request(ControlCommand.TestPageAdjust, [40, 60]);
    if (changed[0] !== 0) throw new Error(`set page adjustment: ${changed[1]}`);

    sendMessage(frame, WM_COMMAND, cmdId("CmdClose"), 0);
    if (!sendCopyDataW(frame, 0x44646557, `[Open("${pdf}", 0, 1, 0)]`)) {
      throw new Error("reopen failed");
    }
    await client.waitForRenderIdle();

    const state = await client.request(ControlCommand.TestPageAdjust, []);
    if (state[0] !== 0 || !String(state[1]).includes("brightness=40 contrast=60 fs=40,60")) {
      throw new Error(`last tab lost page adjustment: ${state[1]}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
