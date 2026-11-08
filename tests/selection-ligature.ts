import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import {
  APP_NAME,
  assemblePdf,
  loadPng,
  pngPixel,
  cmdId,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
  USE_NG,
} from "./util";
import { findCanvas, killAndWait, launchControlled, pressVKey, sendCommandSync } from "./win-automation";
import { captureWindowToPng, getWindowRect, repaintWindow, sleep } from "./winapi";
import { getTestClipboardText } from "./test-clipboard";

export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") return;
  await checkLigature(false);
  await checkLigature(true);
}

async function checkLigature(disableAA: boolean): Promise<void> {
  const dir = tmpPath(disableAA ? "selection-ligature-no-aa" : "selection-ligature");
  mkdirSync(dir, { recursive: true });
  const content = "BT /F1 32 Tf 72 700 Td (AX) Tj ET";
  const cmap =
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /SelectionTest def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 3 beginbfchar <20> <0020> <41> <00660069> <58> <0058> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
  const pdf = join(dir, "text.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /fi] >> /ToUnicode 6 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `DisableAntiAlias = ${disableAA}\n` +
      "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\nDocumentColorsFollowTheme = off\nThemes [\n [\n Name = Selection Test\n TextColor = #000000\n BackgroundColor = #ffffff\n SelectionBackgroundColor = #0066cc\n SelectionTextColor = #ff0000\n TextSelectionColor = #800066cc\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame),
      shot = join(dir, "selection.png");
    if (!captureWindowToPng(canvas, shot)) throw Error("baseline capture failed");
    const baseline = loadPng(shot);
    await client.seedTextSelection(1, 0, 2);
    const selection = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
    if (!/^expanded=fi$/m.test(selection)) throw new Error(`unexpected selection ${selection}`);
    repaintWindow(canvas);
    if (disableAA) {
      await sleep(1500);
      if (!captureWindowToPng(canvas, shot)) throw Error("no-AA capture failed");
      const image = loadPng(shot);
      let red = 0,
        changed = 0;
      for (let y = 0; y < image.h; y++)
        for (let x = 0; x < image.w; x++) {
          const a = pngPixel(baseline, x, y),
            b = pngPixel(image, x, y);
          if (b[0] > 180 && b[1] < 80 && b[2] < 80) red++;
          if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed++;
        }
      if (changed < 10) throw Error(`no-AA selection was not shown: red=${red} changed=${changed}`);
      console.log(`no-AA selection overlay: ${changed} changed pixels`);
      return;
    }
    const deadline = Date.now() + 6000 * SLOW_BUILD_FACTOR;
    let red = 0;
    while (Date.now() < deadline) {
      if (!captureWindowToPng(canvas, shot)) throw Error("capture failed");
      const image = loadPng(shot);
      red = 0;
      for (let y = 0; y < image.h; y++)
        for (let x = 0; x < image.w; x++) {
          const [r, g, b] = pngPixel(image, x, y);
          if (Math.abs(r - 127) <= 2 && Math.abs(g - 178) <= 2 && Math.abs(b - 229) <= 2) red++;
        }
      if (red > 10) break;
      await sleep(50);
    }
    if (red <= 10) throw new Error(`selected fi ligature has ${red} overlay pixels`);
    const position = String(
      (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
    );
    const match = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(position);
    if (!match) throw Error(`missing selection bounds: ${position}`);
    const win = getWindowRect(canvas),
      x1 = +match[1]! - win.left + +match[3]!;
    const selectedImage = loadPng(shot);
    for (let y = 0; y < baseline.h; y++)
      for (let x = x1 + 2; x < baseline.w; x++) {
        const a = pngPixel(baseline, x, y),
          b = pngPixel(selectedImage, x, y);
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) throw Error(`unselected glyph changed at ${x},${y}`);
      }
    await client.request(ControlCommand.TestClipboardText, ["enable"]);
    sendCommandSync(frame, cmdId("CmdCopySelection"));
    if ((await getTestClipboardText(client)).trim() !== "fi") throw Error("ligature copy changed");
    pressVKey(frame, 0x1b);
    const clearDeadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
    let remaining = 1;
    while (Date.now() < clearDeadline && remaining) {
      await sleep(50);
      if (!captureWindowToPng(canvas, shot)) throw Error("clear capture failed");
      const cleared = loadPng(shot);
      remaining = 0;
      for (let y = 0; y < baseline.h; y++)
        for (let x = 0; x < baseline.w; x++) {
          const a = pngPixel(baseline, x, y),
            b = pngPixel(cleared, x, y);
          if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) remaining++;
        }
    }
    if (remaining) throw Error(`clear left ${remaining} changed pixels`);
    await client.seedTextSelection(1, 0, 1);
    const partial = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
    if (!/^expanded=f$/m.test(partial)) throw new Error(`unexpected partial selection ${partial}`);
    repaintWindow(canvas);
    await sleep(1500);
    if (!captureWindowToPng(canvas, shot)) throw Error("partial capture failed");
    const image = loadPng(shot);
    red = 0;
    for (let y = 0; y < image.h; y++)
      for (let x = 0; x < image.w; x++) {
        const [r, g, b] = pngPixel(image, x, y);
        if (Math.abs(r - 127) <= 2 && Math.abs(g - 178) <= 2 && Math.abs(b - 229) <= 2) red++;
      }
    if (red <= 10) throw new Error(`partial ligature has only ${red} overlay pixels`);
    let changed = 0;
    for (let y = 0; y < baseline.h; y++)
      for (let x = 0; x < baseline.w; x++) {
        const a = pngPixel(baseline, x, y),
          b = pngPixel(image, x, y);
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed++;
      }
    if (changed < 10) throw Error("partial ligature overlay is missing");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}
if (import.meta.main) await runStandalone(testit);
