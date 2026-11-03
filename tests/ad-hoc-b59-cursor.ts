import { ControlCommand } from "./control.ts";
import { runStandalone } from "./util.ts";
import { getCursorPos } from "./winapi.ts";
import { clickAt, findCanvas, killAndWait, launchControlled } from "./win-automation.ts";

export async function testit(): Promise<void> {
  const { proc, client, frame } = await launchControlled([]);
  try {
    const real = getCursorPos();
    const appReal = await client.request(ControlCommand.TestCursorPosition);
    const wanted = { x: real.x + 17, y: real.y + 23 };
    const moved = await client.request(ControlCommand.TestCursorPosition, [wanted.x, wanted.y]);
    if (moved[0] !== wanted.x || moved[1] !== wanted.y) throw new Error(`test cursor: ${moved}`);
    const actual = getCursorPos();
    if (actual.x !== real.x || actual.y !== real.y) throw new Error("real cursor moved");
    const canvas = findCanvas(frame);
    if (!canvas) throw new Error("canvas missing");
    await clickAt(canvas, 100, 100, 0);
    const afterClick = getCursorPos();
    if (afterClick.x !== real.x || afterClick.y !== real.y) throw new Error("clickAt moved real cursor");
    const cleared = await client.request(ControlCommand.TestCursorPosition);
    const after = getCursorPos();
    if (after.x !== real.x || after.y !== real.y) throw new Error("real cursor moved after clear");
    if (cleared[0] !== appReal[0] || cleared[1] !== appReal[1]) {
      throw new Error(`test cursor did not clear: before ${appReal}, after ${cleared}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
