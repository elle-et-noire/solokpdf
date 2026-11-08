import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import {
  APP_NAME,
  assemblePdf,
  cmdId,
  loadPng,
  pngPixel,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
  USE_NG,
} from "./util";
import {
  findCanvas,
  killAndWait,
  launchControlled,
  moveTestCursor,
  pressVKey,
  sendCommandSync,
} from "./win-automation";
import {
  captureWindowToPng,
  getWindowRect,
  MK_LBUTTON,
  packCoords,
  repaintWindow,
  sendMessage,
  sleep,
  WM_LBUTTONDBLCLK,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi";
import { getTestClipboardText } from "./test-clipboard";

async function check(
  mode: "off" | "smart",
  kerning = false,
  annotation = false,
  builtin = false,
  engine = "pdfium",
): Promise<void> {
  const dir = tmpPath(
    `selection-mouse-colors-${engine}-${mode}${kerning ? "-kerning" : ""}${annotation ? "-annot" : ""}${builtin ? "-builtin" : ""}`,
  );
  mkdirSync(dir, { recursive: true });
  const words = kerning ? "[(Sele) -37 (cted) -40 ( text words)] TJ" : "(Selected text words) Tj";
  const content = `BT /F1 24 Tf 72 700 Td (stale-term) Tj 0 -60 Td ${words} ET`;
  const pdf = join(dir, "page.pdf");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R ${annotation ? "/Annots [6 0 R]" : ""} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  if (annotation) {
    const appearance = "0 1 0 rg 0 0 6 14 re f";
    objects.push("<< /Type /Annot /Subtype /Square /Rect [97 642 103 656] /F 4 /AP << /N 7 0 R >> >>");
    objects.push(
      `<< /Type /XObject /Subtype /Form /BBox [0 0 6 14] /Resources << >> /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
    );
  }
  writeFileSync(pdf, assemblePdf(objects), "latin1");
  const custom = `Themes [\n [\n Name = Selection Test\n TextColor = ${mode === "smart" ? "#ffffff" : "#000000"}\n BackgroundColor = ${mode === "smart" ? "#193247" : "#ffffff"}\n SelectionBackgroundColor = #0066cc\n SelectionTextColor = #ff0000\n TextSelectionColor = #800066cc\n ]\n]\n`;
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `Theme = ${builtin ? "Catppuccin Mocha" : "Selection Test"}\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\nDocumentColorsFollowTheme = ${mode}\n${builtin ? "" : custom}`,
  );
  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-log-to-file", join(dir, "selection.log"), pdf],
    { env: { SOLOKPDF_ENGINE: engine } },
  );
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame),
      shot = join(dir, "canvas.png");
    await client.seedTextSelection(1, 11, 19);
    const pos = String((await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "");
    const m = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(pos);
    if (!m) throw Error(`selection bounds: ${pos}`);
    const wr = getWindowRect(canvas),
      x0 = +m[1]! - wr.left + 1,
      x1 = x0 + +m[3]! - 2,
      y = +m[2]! - wr.top + Math.round(+m[4]! / 2);
    const editorBefore = String((await client.request(ControlCommand.TestCurrentPdf, ["editor"]))[1]);
    if (engine === "pdfium" && editorBefore !== "editor=none")
      throw Error(`unexpected initial editor: ${editorBefore}`);
    pressVKey(frame, 27);
    await sleep(250);
    if (!captureWindowToPng(canvas, shot)) throw Error("baseline capture failed");
    const baseline = loadPng(shot);
    async function drag(fast = false, reverse = false) {
      const start = reverse ? x1 : x0,
        end = reverse ? x0 : x1;
      await moveTestCursor(wr.left + start, wr.top + y, client);
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(start, y));
      for (let step = 1; step <= 6; step++) {
        const x = Math.round(start + ((end - start) * step) / 6);
        await moveTestCursor(wr.left + x, wr.top + y, client);
        sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(x, y));
        if (!fast && step === 3) {
          repaintWindow(canvas);
          if (!captureWindowToPng(canvas, shot)) throw Error("drag capture failed");
          const during = loadPng(shot);
          const overlay = builtin ? [51, 153, 255] : [0, 102, 204];
          const alpha = builtin ? 95 : 128;
          let blended = 0;
          for (let yy = 0; yy < during.h; yy++)
            for (let xx = 0; xx < during.w; xx++) {
              const a = pngPixel(baseline, xx, yy),
                b = pngPixel(during, xx, yy);
              if (
                overlay.every((c, i) => Math.abs(b[i]! - (a[i]! * (255 - alpha) + c * alpha) / 255) <= 2) &&
                a.some((c, i) => Math.abs(c - b[i]!) > 3)
              )
                blended++;
            }
          if (blended < 30) throw Error(`drag overlay missing before mouse-up: ${blended}`);
        }
        if (!fast) await sleep(25);
      }
      if (!fast && !annotation) {
        const mid = Math.round((start + end) / 2);
        await moveTestCursor(wr.left + mid, wr.top + y, client);
        sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(mid, y));
        repaintWindow(canvas);
        const pos = String((await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "");
        const bounds = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(pos);
        if (!bounds) throw Error(`shrunken selection bounds: ${pos}`);
        if (!captureWindowToPng(canvas, shot)) throw Error("shrunken capture failed");
        const image = loadPng(shot);
        const left = +bounds[1]! - wr.left - 4,
          top = +bounds[2]! - wr.top - 4;
        const right = left + +bounds[3]! + 8,
          bottom = top + +bounds[4]! + 8;
        for (let yy = 0; yy < image.h; yy++)
          for (let xx = 0; xx < image.w; xx++) {
            if (xx >= left && xx < right && yy >= top && yy < bottom) continue;
            const a = pngPixel(baseline, xx, yy),
              b = pngPixel(image, xx, yy);
            if (a.some((c, i) => c !== b[i])) throw Error(`drag shrink left stale pixel at ${xx},${yy}`);
          }
        await moveTestCursor(wr.left + end, wr.top + y, client);
        sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(end, y));
      }
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(end, y));
      repaintWindow(canvas);
    }
    async function expectColored(label: string) {
      const selection = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
      if (!/^expanded=Selected$/m.test(selection)) throw Error(`${label}: wrong selection ${selection}`);
      const position = String(
        (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
      );
      const bounds = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(position);
      if (!bounds) throw Error(`${label}: missing bounds ${position}`);
      const left = +bounds[1]! - wr.left - 4,
        top = +bounds[2]! - wr.top - 4;
      const right = left + +bounds[3]! + 8,
        bottom = top + +bounds[4]! + 8;
      const deadline = Date.now() + 6000 * SLOW_BUILD_FACTOR;
      let blended = 0,
        annotationPixels = 0;
      const overlay = builtin ? [51, 153, 255] : [0, 102, 204];
      const alpha = builtin ? 95 : 128;
      while (Date.now() < deadline) {
        if (!captureWindowToPng(canvas, shot)) throw Error("selection capture failed");
        const image = loadPng(shot);
        blended = annotationPixels = 0;
        for (let yy = 0; yy < image.h; yy++)
          for (let xx = 0; xx < image.w; xx++) {
            const before = pngPixel(baseline, xx, yy),
              after = pngPixel(image, xx, yy);
            const inside = xx >= left && xx < right && yy >= top && yy < bottom;
            if (!inside) {
              if (before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2])
                throw Error(`${label}: unselected pixel changed at ${xx},${yy}`);
              continue;
            }
            const matches = overlay.every(
              (c, i) => Math.abs(after[i]! - (before[i]! * (255 - alpha) + c * alpha) / 255) <= 2,
            );
            if (matches && before.some((c, i) => Math.abs(c - after[i]!) > 3)) {
              blended++;
              if (before[0] < 50 && before[1] > 200 && before[2] < 50) annotationPixels++;
            }
          }
        if (blended > 30 && (!annotation || annotationPixels > 10)) return;
        await sleep(50);
      }
      throw Error(`${mode} ${label}: blended=${blended} annotation=${annotationPixels}`);
    }
    await drag();
    const editorAfter = String((await client.request(ControlCommand.TestCurrentPdf, ["editor"]))[1]);
    if (engine === "pdfium" && editorAfter !== "editor=loaded")
      throw Error(`mouse-down did not load editor: ${editorAfter}`);
    await expectColored("drag");
    await client.request(ControlCommand.TestClipboardText, ["enable"]);
    sendCommandSync(frame, cmdId("CmdCopySelection"));
    if ((await getTestClipboardText(client)).trim() !== "Selected") throw Error("copy changed");
    pressVKey(frame, 27);
    await sleep(200);
    await drag(true);
    await expectColored("fast drag");
    pressVKey(frame, 27);
    await sleep(200);
    await drag(false, true);
    await expectColored("reverse drag");
    pressVKey(frame, 27);
    await sleep(200);
    await moveTestCursor(wr.left + Math.round((x0 + x1) / 2), wr.top + y, client);
    sendMessage(canvas, WM_LBUTTONDBLCLK, MK_LBUTTON, packCoords(Math.round((x0 + x1) / 2), y));
    sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(Math.round((x0 + x1) / 2), y));
    repaintWindow(canvas);
    await expectColored("double-click");
    if (annotation) {
      const selectedBeforeEdit = loadPng(shot);
      sendCommandSync(frame, cmdId("CmdCreateAnnotUnderline"));
      await client.waitForRenderIdle();
      await sleep(300);
      if (!captureWindowToPng(canvas, shot)) throw Error("edited annotation capture failed");
      const edited = loadPng(shot);
      await drag();
      await expectColored("after annotation edit");
      const selectedImage = loadPng(shot);
      let added = 0,
        changedSelection = 0;
      for (let yy = 0; yy < edited.h; yy++)
        for (let xx = 0; xx < edited.w; xx++) {
          const before = pngPixel(baseline, xx, yy),
            edit = pngPixel(edited, xx, yy),
            after = pngPixel(selectedImage, xx, yy);
          const selectedBefore = pngPixel(selectedBeforeEdit, xx, yy);
          if (before[0] !== edit[0] || before[1] !== edit[1] || before[2] !== edit[2]) added++;
          if (selectedBefore[0] !== after[0] || selectedBefore[1] !== after[1] || selectedBefore[2] !== after[2])
            changedSelection++;
        }
      if (added < 5 || changedSelection < 5)
        throw Error(`edited annotation not reflected in selection: added=${added} changed=${changedSelection}`);
      return;
    }
    pressVKey(frame, 27);
    const deadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
    let different = 1;
    while (Date.now() < deadline && different) {
      await sleep(50);
      captureWindowToPng(canvas, shot);
      const image = loadPng(shot);
      different = 0;
      for (let yy = 0; yy < image.h; yy++)
        for (let xx = 0; xx < image.w; xx++) {
          const a = pngPixel(baseline, xx, yy),
            b = pngPixel(image, xx, yy);
          if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) different++;
        }
    }
    if (different) throw Error(`Escape left ${different} changed pixels`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}
export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") return;
  await check("off");
  await check("off", false, false, false, "mupdf");
  await check("smart");
  await check("smart", true);
  await check("off", false, true);
  await check("smart", false, false, true);
}
if (import.meta.main) await runStandalone(testit);
