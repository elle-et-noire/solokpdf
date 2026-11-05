import { join } from "node:path";
import { EXE, ROOT, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import { IS_MAC } from "./host.ts";
import { killAndWait, waitForExit, waitForFrame } from "./win-automation.ts";
import { getWindowText, isWindowVisible, postMessage, sendCopyDataW, sendMessage, sleep, WM_CLOSE } from "./winapi.ts";

const kOpenDataId = 0x44646557;

async function checkClosedStdout(when: "startup" | "open"): Promise<void> {
  const dir = writeAppdata(`closed-stdout-${when}`, "CheckForUpdates = false\nShowStartPage = false\n");
  const proc = Bun.spawn([EXE, "-for-testing", "-appdata", dir], { stdout: "pipe", stderr: "ignore" });
  try {
    if (when === "startup") await proc.stdout.cancel();
    const frame = await waitForFrame(proc.pid!, 6000);
    if (!frame) throw new Error(`${when}: app did not start`);
    for (let i = 0; i < 60 && !isWindowVisible(frame); i++) await sleep(50);
    if (!isWindowVisible(frame)) throw new Error(`${when}: window did not appear`);
    if (when === "open") {
      await proc.stdout.cancel();
      const pdf = join(ROOT, "ext", "a-zlib", "zlib.3.pdf");
      if (!sendCopyDataW(frame, kOpenDataId, `[Open("${pdf}", 0, 1, 0)]`)) throw new Error("open failed");
      for (let i = 0; i < 100 && !getWindowText(frame).includes("zlib.3.pdf"); i++) await sleep(50);
      if (!getWindowText(frame).includes("zlib.3.pdf")) throw new Error("document did not open");
    }
    sendMessage(frame, 0, 0, 0);
    postMessage(frame, WM_CLOSE, 0, 0);
    if (!(await waitForExit(proc, 6000))) throw new Error(`${when}: app did not close`);
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG || IS_MAC) {
    console.log("SKIP closed-stdout: Windows original app");
    return;
  }
  await checkClosedStdout("startup");
  await checkClosedStdout("open");
}

if (import.meta.main) {
  await runStandalone(testit);
}
