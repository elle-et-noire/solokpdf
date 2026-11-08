import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import {
  APP_NAME,
  cmdId,
  loadPng,
  makeTextPdf,
  pngPixel,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
  USE_NG,
} from "./util";
import { findCanvas, killAndWait, launchControlled, sendCommandSync, waitForFocusClass } from "./win-automation";
import { captureWindowToPng, getWindowRect, repaintWindow, sendMessage, sleep, WM_CHAR } from "./winapi";

async function check(query: string): Promise<void> {
  const dir = tmpPath(`selection-search-${query}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "page.pdf");
  writeFileSync(pdf, makeTextPdf("Selected needle Selected"));
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\nSearchUIFloating = false\nDocumentColorsFollowTheme = off\nThemes [\n [\n Name = Selection Test\n TextColor = #000000\n BackgroundColor = #ffffff\n ControlBackgroundColor = #ffffff\n LinkColor = #000000\n SelectionBackgroundColor = #0066cc\n SelectionTextColor = #ff0000\n TextSelectionColor = #800066cc\n SearchMatchColor = #80ff8000\n CurrentSearchMatchColor = #80ffff00\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    sendCommandSync(frame, cmdId("CmdFindFirst"));
    const edit = await waitForFocusClass(frame, "Edit");
    for (const ch of query) sendMessage(edit, WM_CHAR, ch.charCodeAt(0), 0);
    let state = "";
    const until = Date.now() + 10000 * SLOW_BUILD_FACTOR;
    while (Date.now() < until) {
      state = String((await client.request(ControlCommand.TestFindUiState, ["state"]))[1] ?? "");
      const matches = Number(/matches=(\d+)/.exec(state)?.[1] ?? 0);
      if (matches >= (query === "Selected" ? 2 : 1) && /busy=0/.test(state)) break;
      await sleep(50);
    }
    const matches = Number(/matches=(\d+)/.exec(state)?.[1] ?? 0);
    if (matches < (query === "Selected" ? 2 : 1) || !/busy=0/.test(state)) throw new Error(`find not ready: ${state}`);
    await client.seedTextSelection(1, 0, 8);
    const selection = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
    if (!/^expanded=Selected$/m.test(selection)) throw new Error(`unexpected selection ${selection}`);
    const canvas = findCanvas(frame),
      shot = join(dir, "canvas.png");
    const position = String(
      (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
    );
    const match = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(position);
    if (!match) throw new Error(`selection position missing: ${position}`);
    const window = getWindowRect(canvas);
    const left = Number(match[1]) - window.left - 2;
    const top = Number(match[2]) - window.top - 2;
    const right = left + Number(match[3]) + 4;
    const bottom = top + Number(match[4]) + 4;
    repaintWindow(canvas);
    let selected = 0,
      search = 0;
    const deadline = Date.now() + 8000 * SLOW_BUILD_FACTOR;
    while (Date.now() < deadline) {
      if (!captureWindowToPng(canvas, shot)) throw new Error("capture failed");
      const image = loadPng(shot);
      selected = search = 0;
      for (let y = 0; y < image.h; y++)
        for (let x = 0; x < image.w; x++) {
          const [r, g, b] = pngPixel(image, x, y);
          const inside = x >= left && x < right && y >= top && y < bottom;
          if (
            inside &&
            Math.abs(r - 127) <= 3 &&
            (query === "needle"
              ? Math.abs(g - 178) <= 3 && Math.abs(b - 229) <= 3
              : (Math.abs(g - 178) <= 3 || Math.abs(g - 146) <= 3) && Math.abs(b - 165) <= 3)
          )
            selected++;
          if (!inside && r > 240 && g > 150 && b >= 120 && b <= 135) search++;
        }
      if (selected > 10 && search > 10) break;
      await sleep(50);
    }
    if (selected <= 10 || search <= 10) throw new Error(`${query}: selected=${selected} search=${search}`);
    console.log(`${query}: selected=${selected} search=${search}`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") {
    console.log("SKIP selection-search-colors: SolokPDF original app only");
    return;
  }
  await check("needle");
  await check("Selected");
}
if (import.meta.main) await runStandalone(testit);
