import { ControlCommand } from "./control.ts";
import { runStandalone } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

export async function testit(): Promise<void> {
  const { proc, client } = await launchControlled([]);
  try {
    await client.request(ControlCommand.TestFocusState, ["activate"]);
    const trace = await client.request(ControlCommand.TestActivationTrace, []);
    if (typeof trace[1] !== "string" || !trace[1].includes("SOLOK_PDF_FRAME") || !trace[1].includes("+0x")) {
      throw new Error(`activation trace missing frame or stack: ${trace}`);
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
