import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { assemblePdf, runStandalone, tmpPath } from "./util.ts";
import { clientToScreen, getCursorPos, packCoords, sendMessage, sleep, WM_MOUSEMOVE } from "./winapi.ts";
import { findCanvas, killAndWait, launchControlled, moveTestCursor } from "./win-automation.ts";

export async function testit(): Promise<void> {
  const pdf = tmpPath("ad-hoc-b71-hover.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R] >>",
      "<< /Type /Annot /Subtype /Highlight /P 3 0 R /Rect [72 560 220 590] /QuadPoints [72 590 220 590 72 560 220 560] /C [1 1 0] >>",
      "<< /Type /Annot /Subtype /Highlight /P 3 0 R /Rect [72 150 220 180] /QuadPoints [72 180 220 180 72 150 220 150] /C [1 1 0] >>",
    ]),
    "latin1",
  );
  const { proc, client, frame } = await launchControlled(["-view", "single page", "-zoom", "fit page", pdf]);
  try {
    await client.waitForRenderIdle();
    const canvas = findCanvas(frame);
    const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1]);
    const real = getCursorPos();
    const origin = clientToScreen(canvas, 0, 0);
    const realX = real.x - origin.x;
    const realY = real.y - origin.y;
    const rects = Array.from(raw.matchAll(/screen=(-?\d+),(-?\d+),(\d+),(\d+)/g));
    const rect = rects.find((r) => realY < +r[2]! - 30 || realY > +r[2]! + +r[4]! + 30);
    if (rects.length !== 2 || !rect) throw new Error(`annotation missing or cursor too close: ${raw}`);
    const x = +rect[1]! + Math.floor(+rect[3]! / 2);
    const y = +rect[2]! + Math.floor(+rect[4]! / 2);
    const target = clientToScreen(canvas, x, y);
    await moveTestCursor(target.x, target.y);
    sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(x, y));
    await sleep(100);
    let state = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1]);
    if (!/state selected=0 hover=1/.test(state)) throw new Error(`hover missing: ${state}`);
    sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(realX, realY));
    await sleep(100);
    state = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1]);
    if (!/state selected=0 hover=1/.test(state)) throw new Error(`physical move cleared hover: ${state}`);
    sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(0, 0));
    state = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1]);
    if (!/state selected=0 hover=1/.test(state)) throw new Error(`conflicting move cleared hover: ${state}`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
