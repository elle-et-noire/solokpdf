import { writeFileSync } from "node:fs";
import {
  cmdId,
  dpiRequest,
  makeTopBottomPdf,
  parseDpiFields,
  pollUntil,
  runStandalone,
  tmpPath,
  writeAppdata,
} from "./util.ts";
import { ControlCommand } from "./control.ts";
import { findCanvas, killAndWait, launchControlled, pressKey, sendCommandSync } from "./win-automation.ts";
import { getScrollPos, sendMessage } from "./winapi.ts";

const WM_MOUSEWHEEL = 0x020a;
const WHEEL_DOWN = 0xff880000n;

export async function testit(): Promise<void> {
  const dir = writeAppdata(
    "key-scroll-step-appdata",
    "KeyScrollLineAmount = 100\nScrollLineAmount = 10\nSmoothScroll = false\nRestoreSession = false\n",
  );
  const pdf = tmpPath("key-scroll-step.pdf");
  writeFileSync(pdf, makeTopBottomPdf(20));

  const { proc, client, frame } = await launchControlled(["-appdata", dir, "-zoom", "200", "-view", "continuous", pdf]);
  try {
    await client.waitForRenderIdle();
    const canvas = findCanvas(frame);
    const dpi = parseDpiFields(await dpiRequest(client, "state")).frame;
    const expectedKeyStep = Math.round((100 * dpi) / 96);
    const start = getScrollPos(canvas);
    await pressKey(frame, 0x4a);
    const afterKey = getScrollPos(canvas);
    const keyStep = afterKey - start;

    await pressKey(frame, 0x33);
    await pressKey(frame, 0x4a);
    const afterCount = getScrollPos(canvas);
    const countStep = afterCount - afterKey;

    sendMessage(canvas, WM_MOUSEWHEEL, WHEEL_DOWN, 0n);
    const wheelStep = getScrollPos(canvas) - afterCount;
    if (
      Math.abs(keyStep - expectedKeyStep) > 3 ||
      Math.abs(countStep - 3 * keyStep) > 3 ||
      wheelStep <= 0 ||
      wheelStep >= keyStep
    ) {
      throw new Error(`key step=${keyStep} (want ${expectedKeyStep}), 3j=${countStep}, wheel notch=${wheelStep}`);
    }

    sendCommandSync(frame, cmdId("CmdAdvancedSettings"));
    await pollUntil(
      async () => String((await client.request(ControlCommand.TestAdvSettingsRows, ["names"]))[1] ?? ""),
      (names) => names.includes("KeyScrollLineAmount"),
      { error: "KeyScrollLineAmount missing from Advanced Settings" },
    );
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }

  const fallbackDir = writeAppdata(
    "key-scroll-step-fallback-appdata",
    "KeyScrollLineAmount = 0\nScrollLineAmount = 10\nSmoothScroll = false\nRestoreSession = false\n",
  );
  const fallback = await launchControlled(["-appdata", fallbackDir, "-zoom", "200", "-view", "continuous", pdf]);
  try {
    await fallback.client.waitForRenderIdle();
    const canvas = findCanvas(fallback.frame);
    const dpi = parseDpiFields(await dpiRequest(fallback.client, "state")).frame;
    const start = getScrollPos(canvas);
    await pressKey(fallback.frame, 0x4a);
    const step = getScrollPos(canvas) - start;
    const expected = Math.round((10 * dpi) / 96);
    if (Math.abs(step - expected) > 3) {
      throw new Error(`fallback step=${step}, want ${expected}`);
    }
  } finally {
    await fallback.client.quit().catch(() => {});
    await killAndWait(fallback.proc);
  }
}

if (import.meta.main) await runStandalone(testit);
