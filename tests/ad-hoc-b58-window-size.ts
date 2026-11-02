import { writeFileSync } from "node:fs";
import { cmdId, makeTextPdf, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import { sleep } from "./winapi.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";

const WINDOW_POS = "640x600@40x40";

export async function testit(): Promise<void> {
  const pdf = tmpPath("b58-window-size.pdf");
  writeFileSync(pdf, makeTextPdf("narrow tabs"));
  const appdata = writeAppdata("b58-window-size", "NoHomeTab = false\nRestoreSession = false\n");
  const { proc, client, frame } = await launchControlled(["-window-pos", WINDOW_POS, "-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    const tabs = async () => (await client.virtTree()).filter((v) => v.kind === "tabCtrl");
    const before = await tabs();
    if (before.length !== 2) throw new Error(`B58: expected two initial tabs, got ${before.length}`);
    const docDx = before[1]!.rect.dx;

    sendCommandSync(frame, cmdId("CmdNewTab"));
    let after = await tabs();
    const deadline = Date.now() + 5000;
    while (after.length !== 3 && Date.now() < deadline) {
      await sleep(50);
      after = await tabs();
    }
    if (after.length !== 3) throw new Error(`B58: expected three tabs, got ${after.length}`);
    if (after[0]!.rect.dx >= after[1]!.rect.dx)
      throw new Error(`B58: pinned Home ${after[0]!.rect.dx} is not narrower than document ${after[1]!.rect.dx}`);
    if (after[1]!.rect.dx !== after[2]!.rect.dx) throw new Error("B58: document and new Home widths differ");
    if (after[1]!.rect.dx >= docDx) throw new Error("B58: document tab did not shrink when new Home opened");
    const plus = (await client.virtTree()).find((v) => v.kind === "tabsPlus");
    if (!plus || plus.rect.x !== after[2]!.rect.x + after[2]!.rect.dx)
      throw new Error("B58: + does not follow the last tab");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
