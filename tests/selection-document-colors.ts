import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import {
  cmdId,
  APP_NAME,
  assemblePdf,
  loadPng,
  makeTextPdf,
  pngPixel,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
  USE_NG,
} from "./util.ts";
import { findCanvas, killAndWait, launchControlled, pressVKey, sendCommandSync } from "./win-automation.ts";
import { captureWindowToPng, getWindowRect, postChar, repaintWindow, sleep } from "./winapi.ts";
import { getTestClipboardText } from "./test-clipboard.ts";

const VK_ESCAPE = 0x1b;
const VK_RIGHT = 0x27;
const SELECTED = "Selected";

async function check(kind: "ordinary" | "single" | "multiple" | "tagged", smart = false): Promise<void> {
  const dir = tmpPath(`selection-document-colors-${kind}${smart ? "-smart" : ""}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "text.pdf");
  if (kind === "ordinary") {
    writeFileSync(pdf, makeTextPdf("Selected text remains legible"));
  } else {
    const words =
      kind === "multiple"
        ? "(Sele) Tj (ctedX) Tj"
        : kind === "tagged"
          ? "/Span << /MCID 1 >> BDC (SelectedX) Tj EMC"
          : "(SelectedX) Tj";
    const content = `BT /F1 18 Tf 1.4 Tc 72 700 Td ${words} ET`;
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    writeFileSync(pdf, assemblePdf(objects), "latin1");
  }
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\n" +
      `DocumentColorsFollowTheme = ${smart ? "smart" : "off"}\nThemes [\n [\n Name = Selection Test\n TextColor = ${smart ? "#ffffff" : "#000000"}\n` +
      ` BackgroundColor = ${smart ? "#193247" : "#ffffff"}\n ControlBackgroundColor = ${smart ? "#193247" : "#ffffff"}\n LinkColor = ${smart ? "#ffffff" : "#000000"}\n` +
      " SelectionBackgroundColor = #0066cc\n SelectionTextColor = #ff0000\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled([
    "-appdata",
    dir,
    "-log-to-file",
    join(dir, "selection.log"),
    pdf,
  ]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const shot = join(dir, "canvas.png");
    if (!captureWindowToPng(canvas, shot)) throw new Error("cannot capture initial canvas");
    const before = loadPng(shot);
    if (kind === "ordinary") {
      sendCommandSync(frame, cmdId("CmdSelectTextViaKeyboard"));
      let ready = false;
      const activeDeadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
      while (Date.now() < activeDeadline) {
        const state = String((await client.request(ControlCommand.TestSelectTextKeyboard, []))[1] ?? "");
        if ((ready = /active=1/.test(state))) break;
        await sleep(25);
      }
      if (!ready) throw new Error("keyboard selection did not start");
      await postChar(frame, "v");
      ready = false;
      const visualDeadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
      while (Date.now() < visualDeadline) {
        const state = String((await client.request(ControlCommand.TestSelectTextKeyboard, []))[1] ?? "");
        if ((ready = /visual=1/.test(state))) break;
        await sleep(25);
      }
      if (!ready) throw new Error("visual selection did not start");
      for (let i = 0; i < SELECTED.length; i++) pressVKey(frame, VK_RIGHT);
    } else {
      await client.seedTextSelection(1, 0, SELECTED.length);
      repaintWindow(canvas);
    }
    let selection = "";
    let deadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
    while (Date.now() < deadline) {
      selection = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
      if (/^expanded=Selected$/m.test(selection)) break;
      await sleep(25);
    }
    if (!/^expanded=Selected$/m.test(selection)) throw new Error(`selection missing: ${selection}`);
    let red = 0;
    let blue = 0;
    let selectedImage = before;
    deadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
    while (Date.now() < deadline) {
      if (!captureWindowToPng(canvas, shot)) throw new Error("cannot capture canvas");
      const image = loadPng(shot);
      selectedImage = image;
      red = 0;
      blue = 0;
      for (let y = 0; y < image.h; y++) {
        for (let x = 0; x < image.w; x++) {
          const [r, g, b] = pngPixel(image, x, y);
          if (r! > 180 && g! < 80 && b! < 80) red++;
          if (r! < 15 && g! >= 90 && g! <= 115 && b! >= 195 && b! <= 215) blue++;
        }
      }
      if (red > 10) break;
      await sleep(50);
    }
    if (red <= 10) throw new Error(`selected text has ${red} red pixels`);
    if (blue <= 10) throw new Error(`selection background has ${blue} blue pixels`);
    const position = String(
      (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
    );
    const match = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(position);
    if (!match) throw new Error(`selection position missing: ${position}`);
    const windowRect = getWindowRect(canvas);
    const caretMargin = kind === "ordinary" ? 12 : 1;
    const x0 = +match[1]! - windowRect.left - caretMargin;
    const y0 = +match[2]! - windowRect.top - caretMargin;
    const x1 = x0 + +match[3]! + 2 * caretMargin;
    const y1 = y0 + +match[4]! + 2 * caretMargin;
    let changed = 0;
    let minX = before.w,
      minY = before.h,
      maxX = 0,
      maxY = 0;
    for (let y = 0; y < before.h; y++) {
      for (let x = 0; x < before.w; x++) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
        const a = pngPixel(before, x, y),
          b = pngPixel(selectedImage, x, y);
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
          changed++;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (changed)
      throw new Error(
        `${changed} pixels changed outside the selection: ${minX},${minY}..${maxX},${maxY}; selected ${x0},${y0}..${x1},${y1}`,
      );
    await client.request(ControlCommand.TestClipboardText, ["enable"]);
    sendCommandSync(frame, cmdId("CmdCopySelection"));
    const copied = (await getTestClipboardText(client)).trim();
    if (copied !== SELECTED.trim()) throw new Error(`copied '${copied}', want '${SELECTED.trim()}'`);
    pressVKey(frame, VK_ESCAPE);
    pressVKey(frame, VK_ESCAPE);
    const clearDeadline = Date.now() + 4000 * SLOW_BUILD_FACTOR;
    while (Date.now() < clearDeadline) {
      captureWindowToPng(canvas, shot);
      const image = loadPng(shot);
      let remaining = 0;
      for (let y = Math.max(0, y0); y < Math.min(image.h, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(image.w, x1); x++) {
          const [r, g, b] = pngPixel(image, x, y);
          if (kind === "ordinary") {
            if (r! > 180 && g! < 80 && b! < 80) remaining++;
          } else {
            const original = pngPixel(before, x, y);
            if (r !== original[0] || g !== original[1] || b !== original[2]) remaining++;
          }
        }
      }
      if (!remaining) return;
      await sleep(25);
    }
    throw new Error("selection pixels did not return to baseline after Escape");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") {
    console.log("SKIP selection-document-colors: SolokPDF only");
    return;
  }
  const cases: [string, () => Promise<void>][] = [
    ["partial-many", () => checkManyLines(true)],
    ["viewport", checkViewport],
    ["ordinary", () => check("ordinary")],
    ["smart-dark", () => check("ordinary", true)],
    ["single", () => check("single")],
    ["multiple", () => check("multiple")],
    ["tagged", () => check("tagged")],
    ["unsafe-effects", checkActualText],
    ["many", () => checkManyLines(false)],
    ["partial-many-spaced", () => checkManyLines(true, true)],
  ];
  for (const [name, run] of cases) {
    console.log(`selection-document-colors: ${name} start`);
    await run();
    console.log(`selection-document-colors: ${name} passed`);
  }
}

async function checkViewport(): Promise<void> {
  const dir = tmpPath("selection-document-colors-viewport");
  mkdirSync(dir, { recursive: true });
  const text = "M".repeat(120);
  const content = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  const pdf = join(dir, "text.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2400 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\n" +
      "DocumentColorsFollowTheme = off\nThemes [\n [\n Name = Selection Test\n TextColor = #000000\n" +
      " BackgroundColor = #ffffff\n ControlBackgroundColor = #ffffff\n LinkColor = #000000\n" +
      " SelectionBackgroundColor = #0066cc\n SelectionTextColor = #ff0000\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, "-zoom", "200", pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    await client.seedTextSelection(1, 0, 100);
    const canvas = findCanvas(frame),
      shot = join(dir, "canvas.png");
    const position = String(
      (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
    );
    const m = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(position);
    if (!m || +m[1]! + +m[3]! <= getWindowRect(canvas).right) {
      throw new Error(`selection does not reach viewport edge: ${position}`);
    }
    repaintWindow(canvas);
    const deadline = Date.now() + 6000 * SLOW_BUILD_FACTOR;
    while (Date.now() < deadline) {
      if (!captureWindowToPng(canvas, shot)) throw new Error("cannot capture viewport");
      const image = loadPng(shot);
      let red = 0;
      for (let y = 0; y < image.h; y++)
        for (let x = 0; x < image.w; x++) {
          const [r, g, b] = pngPixel(image, x, y);
          if (r > 180 && g < 80 && b < 80) red++;
        }
      if (red > 10) return;
      await sleep(50);
    }
    throw new Error("viewport-clipped selection did not turn red");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

async function checkActualText(): Promise<void> {
  for (const kind of ["direct", "nested", "resource", "multiply", "softmask"]) {
    const dir = tmpPath(`selection-actual-text-${kind}`);
    mkdirSync(dir, { recursive: true });
    const effect = kind === "multiply" || kind === "softmask";
    const mark = kind === "resource" ? "/Span /P BDC" : "/Span << /ActualText (SelectedX) >> BDC";
    const opening = kind === "nested" ? `/P << /MCID 1 >> BDC ${mark}` : mark;
    const closing = kind === "nested" ? "EMC EMC" : "EMC";
    const content = effect
      ? "q /G1 gs BT /F1 18 Tf 1.4 Tc 72 700 Td (SelectedX) Tj ET Q"
      : `BT /F1 18 Tf 1.4 Tc 72 700 Td ${opening} (SelectedX) Tj ${closing} ET`;
    const resources =
      kind === "resource"
        ? "/Properties << /P << /ActualText (SelectedX) >> >>"
        : kind === "multiply"
          ? "/ExtGState << /G1 << /Type /ExtGState /BM /Multiply >> >>"
          : kind === "softmask"
            ? "/ExtGState << /G1 << /Type /ExtGState /SMask << /S /Alpha /G 6 0 R >> >> >>"
            : "";
    const pdf = join(dir, "text.pdf");
    const mask = "1 g 0 0 612 792 re f";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> ${resources} >> /Contents 5 0 R >>`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    if (kind === "softmask")
      objects.push(
        `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >> /Length ${mask.length} >>\nstream\n${mask}\nendstream`,
      );
    writeFileSync(pdf, assemblePdf(objects), "latin1");
    writeFileSync(
      join(dir, SETTINGS_FILE),
      "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\n" +
        "DocumentColorsFollowTheme = off\nThemes [\n [\n Name = Selection Test\n TextColor = #000000\n" +
        " BackgroundColor = #ffffff\n ControlBackgroundColor = #ffffff\n LinkColor = #000000\n" +
        " SelectionBackgroundColor = #0066cc\n SelectionTextColor = #ff0000\n ]\n]\n",
    );
    const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
    try {
      await client.waitForRenderIdle();
      await client.setNotificationsEnabled(false);
      const canvas = findCanvas(frame),
        shot = join(dir, "canvas.png");
      if (!captureWindowToPng(canvas, shot)) throw new Error("cannot capture canvas");
      const before = loadPng(shot);
      await client.seedTextSelection(1, 0, SELECTED.length);
      repaintWindow(canvas);
      await client.waitForRenderIdle();
      repaintWindow(canvas);
      if (!captureWindowToPng(canvas, shot)) throw new Error("cannot capture selection");
      const after = loadPng(shot);
      let red = 0,
        blue = 0,
        changed = 0;
      for (let y = 0; y < after.h; y++)
        for (let x = 0; x < after.w; x++) {
          const a = pngPixel(before, x, y),
            b = pngPixel(after, x, y);
          if (b[0] > 180 && b[1] < 80 && b[2] < 80) red++;
          if (b[0] < 15 && b[1] >= 90 && b[1] <= 115 && b[2] >= 195 && b[2] <= 215) blue++;
          if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed++;
        }
      if (red || blue || !changed)
        throw new Error(`${kind}: expected overlay fallback, red=${red} blue=${blue} changed=${changed}`);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}

async function checkManyLines(partial: boolean, spaced = false): Promise<void> {
  const dir = tmpPath(
    spaced
      ? "selection-document-colors-partial-spaced"
      : partial
        ? "selection-document-colors-partial-many"
        : "selection-document-colors-many",
  );
  mkdirSync(dir, { recursive: true });
  const content =
    `BT /F1 18 Tf ${spaced ? "1.4 Tc " : ""}72 700 Td ` +
    Array.from({ length: 10 }, (_, i) => `(Line ${i} selected) Tj 0 -24 Td`).join(" ") +
    " (X) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const pdf = join(dir, "lines.pdf");
  writeFileSync(pdf, assemblePdf(objects), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\n" +
      "DocumentColorsFollowTheme = off\nThemes [\n [\n Name = Selection Test\n TextColor = #000000\n" +
      " BackgroundColor = #ffffff\n ControlBackgroundColor = #ffffff\n LinkColor = #000000\n" +
      " SelectionBackgroundColor = #0066cc\n SelectionTextColor = #ff0000\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled([
    "-appdata",
    dir,
    "-log-to-file",
    join(dir, "selection.log"),
    pdf,
  ]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame),
      shot = join(dir, "canvas.png");
    if (!captureWindowToPng(canvas, shot)) throw new Error("cannot capture baseline");
    const before = loadPng(shot);
    const selected = partial ? await client.seedTextSelection(1, 5, 133) : await client.seedTextSelection(1);
    let expectedText = "";
    if (partial) {
      const raw = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
      const value = raw.slice(raw.indexOf("expanded=") + 9, raw.indexOf("\nnrects="));
      const separator = process.env.SOLOKPDF_ENGINE === "mupdf" ? " " : "\n";
      expectedText = Array.from({ length: 10 }, (_, i) => `Line ${i} selected`)
        .join(separator)
        .slice(5, 133);
      if (value !== expectedText) throw new Error(`unexpected partial selection '${value}'`);
    }
    const expected = partial ? 6 : 9;
    if (selected.parts < expected)
      throw new Error(`expected at least ${expected} selection rows, got ${selected.parts}`);
    repaintWindow(canvas);
    const deadline = Date.now() + 6000 * SLOW_BUILD_FACTOR;
    let bands = 0;
    while (Date.now() < deadline) {
      if (!captureWindowToPng(canvas, shot)) throw new Error("cannot capture canvas");
      const image = loadPng(shot);
      bands = 0;
      let lastRed = -100;
      let overlay = 0;
      for (let y = 0; y < image.h; y++) {
        let rowRed = false;
        for (let x = 0; x < image.w; x++) {
          const [r, g, b] = pngPixel(image, x, y);
          if (partial && r === g && g === b && r > 100 && r < 250) {
            const prior = pngPixel(before, x, y);
            if (prior[0] !== r || prior[1] !== g || prior[2] !== b) overlay++;
          }
          if (r > 180 && g < 80 && b < 80) {
            rowRed = true;
            break;
          }
        }
        if (rowRed) {
          if (y - lastRed > 4) bands++;
          lastRed = y;
        }
      }
      if (bands >= expected || (partial && !spaced && overlay > 20)) {
        if (partial && bands < expected) console.log("selection-document-colors: partial-many overlay fallback");
        if (partial) {
          const raw = String(
            (await client.request(ControlCommand.TestSelectionVars, ["${selectionPosition}"]))[1] ?? "",
          );
          const m = /^expanded=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(raw);
          if (!m) throw new Error(`selection position missing: ${raw}`);
          const win = getWindowRect(canvas);
          const x = +m[1]! - win.left,
            y = +m[2]! - win.top,
            width = +m[3]!,
            height = +m[4]!;
          const rows = [
            { x0: x, x1: x + 20, y0: y, y1: y + 12 },
            { x0: x + 50, x1: x + width, y0: y + height - 12, y1: y + height },
          ];
          for (const rect of rows) {
            for (let py = Math.max(0, rect.y0); py < Math.min(image.h, rect.y1); py++) {
              for (let px = Math.max(0, rect.x0); px < Math.min(image.w, rect.x1); px++) {
                const a = pngPixel(before, px, py),
                  b = pngPixel(image, px, py);
                if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2])
                  throw new Error(`partial selection changed unselected text at ${px},${py}`);
              }
            }
          }
          await client.request(ControlCommand.TestClipboardText, ["enable"]);
          sendCommandSync(frame, cmdId("CmdCopySelection"));
          const copied = (await getTestClipboardText(client)).replaceAll("\r\n", "\n").trim();
          if (copied !== expectedText.trim()) throw new Error(`partial copy mismatch: '${copied}'`);
        }
        return;
      }
      await sleep(50);
    }
    throw new Error(`only ${bands} selected text bands turned red`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
