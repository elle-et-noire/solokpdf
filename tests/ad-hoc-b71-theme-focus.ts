import { runStandalone } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { ControlCommand } from "./control.ts";

export async function testit(): Promise<void> {
  const { proc, client } = await launchControlled([]);
  try {
    await client.request(ControlCommand.TestFocusState, ["activate"]);
    const before = await client.request(ControlCommand.TestFocusState, []);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdChangeTheme"]);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdChangeTheme"]);
    const after = await client.request(ControlCommand.TestFocusState, []);
    const trace = await client.request(ControlCommand.TestActivationTrace, []);
    if (typeof trace[1] !== "string") throw new Error(`activation trace unavailable: ${trace}`);
    if (after[1] !== before[1]) throw new Error(`focus changed: ${before[1]} -> ${after[1]}`);
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
