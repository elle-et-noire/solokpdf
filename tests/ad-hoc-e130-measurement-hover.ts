import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { assemblePdf, cmdId, pollUntil, runStandalone, tmpPath } from "./util.ts";
import {
  findCanvas,
  killAndWait,
  launchControlled,
  moveTestCursor,
  waitForExit,
  waitToolWindow,
  sendCommandSync,
} from "./win-automation.ts";
import { clientToScreen, getWindowRect, packCoords, sendMessage, setWindowPos, WM_MOUSEMOVE } from "./winapi.ts";

const HOLD_MS = 800;
const MAX_UI_MS = 400;
const SNAP_LENGTH = 150;

async function check(engine: "pdfium" | "mupdf"): Promise<void> {
  const pdf = tmpPath(`ad-hoc-e130-${engine}.pdf`);
  const stream = "0.95 g 20 40 340 230 re f 0 G 1 w 200 220 m 280 100 l S";
  const other = stream.replace("200 220", "210 220");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 6 0 R >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      `<< /Length ${other.length} >>\nstream\n${other}\nendstream`,
    ]),
  );
  const { proc, client, frame } = await launchControlled(["-view", "single page", "-zoom", "100", pdf], {
    env: { ...process.env, SOLOKPDF_ENGINE: engine } as Record<string, string>,
  });
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    const request = async (cmd: ControlCommand, ...args: (string | number)[]) => {
      const [status, result] = await client.request(cmd, args);
      if (status !== 0) throw new Error(`${args[0]}: ${result}`);
      return String(result);
    };
    const measure = (...args: (string | number)[]) => request(ControlCommand.TestMeasurement, ...args);
    const command = (name: string) => sendCommandSync(frame, cmdId(name));
    const openMeasure = async () => {
      command("CmdMeasure");
      const toolbar = await waitToolWindow(client, proc.pid, "measurement");
      if (!toolbar) throw new Error("measurement toolbar did not open");
      const frameRect = getWindowRect(frame);
      const toolRect = getWindowRect(toolbar);
      const width = toolRect.right - toolRect.left;
      if (!setWindowPos(toolbar, frameRect.left - width, toolRect.top, width, toolRect.bottom - toolRect.top)) {
        throw new Error("failed to move the measurement toolbar off the canvas");
      }
    };
    const setCursorAt = async (docX: number, docY: number, pageNo = 1) => {
      const raw = await request(ControlCommand.TestCurrentPdf, "widget-cursor", pageNo, docX, docY);
      const pos = /pt=(-?\d+),(-?\d+)/.exec(raw);
      if (!pos) throw new Error("failed to locate the measurement endpoint on canvas");
      const x = Number(pos[1]);
      const y = Number(pos[2]);
      const screen = clientToScreen(canvas, x, y);
      await moveTestCursor(screen.x, screen.y, client);
      return packCoords(x, y);
    };
    const lengthOf = (state: string) => Number(/\blength=([^ ]+)/.exec(state)?.[1]);
    const begin = async (pageNo = 1) => {
      await measure("snap", 0);
      await measure("click", pageNo, 50, 80);
      await measure("snap", 1);
    };
    const lock = engine === "pdfium" ? "hold-pdfium-lock" : "hold-editor-lock";
    await openMeasure();
    await begin();
    let coords = await setCursorAt(205, 80);
    await request(ControlCommand.TestCurrentPdf, lock, HOLD_MS);
    const start = performance.now();
    sendMessage(canvas, WM_MOUSEMOVE, 0, coords);
    let maxMs = performance.now() - start;
    if (maxMs > MAX_UI_MS) throw new Error(`mouse move took ${maxMs.toFixed(1)} ms with the engine lock held`);
    const provisional = await measure("state");
    if (!(Math.abs(lengthOf(provisional) - 155) < 1)) throw new Error(`missing unsnapped preview: ${provisional}`);

    let length = 0;
    await pollUntil(
      async () => {
        const t = performance.now();
        const state = await measure("state");
        maxMs = Math.max(maxMs, performance.now() - t);
        length = lengthOf(state);
        if (maxMs > MAX_UI_MS) throw new Error(`UI took ${maxMs.toFixed(1)} ms during hover retry`);
        return length;
      },
      (value) => Math.abs(value - SNAP_LENGTH) < 1,
      { timeoutMs: 5000, error: () => `did not snap without new input (length=${length})` },
    );
    console.log(
      `${engine}: snapped in ${(performance.now() - start).toFixed(1)} ms, max UI wait ${maxMs.toFixed(1)} ms`,
    );
    if (engine === "pdfium" && (await request(ControlCommand.TestCurrentPdf, "editor")) !== "editor=none") {
      throw new Error("snapping loaded the MuPDF editor");
    }

    command("CmdRotateRight");
    command("CmdToggleTrimEmptyMargins");
    command("CmdZoomFitPage");
    const rect = getWindowRect(frame);
    if (!setWindowPos(frame, rect.left + 25, rect.top + 10, rect.right - rect.left - 85, rect.bottom - rect.top - 55)) {
      throw new Error("could not resize the measurement viewport");
    }
    await client.waitForRenderIdle();
    await measure("snap", 0);
    coords = await setCursorAt(177, 161);
    sendMessage(canvas, WM_MOUSEMOVE, 0, coords);
    const preview = lengthOf(await measure("state"));
    const clicked = lengthOf(await measure("click", 1, 177, 161));
    if (preview <= 0 || !(Math.abs(preview - clicked) < 0.01)) {
      throw new Error(`preview ${preview} and click ${clicked} differ after rotation, trim and resize`);
    }

    command("CmdZoomActualSize");
    await client.waitForRenderIdle();
    command("CmdMeasure");
    await openMeasure();
    await begin();
    coords = await setCursorAt(205, 80);
    await request(ControlCommand.TestCurrentPdf, lock, HOLD_MS);
    sendMessage(canvas, WM_MOUSEMOVE, 0, coords);
    command("CmdGoToNextPage");
    await measure("clear");
    await begin(2);
    coords = await setCursorAt(207, 80, 2);
    sendMessage(canvas, WM_MOUSEMOVE, 0, coords);
    await pollUntil(
      async () => lengthOf(await measure("state")),
      (value) => Math.abs(value - 160) < 1,
      { timeoutMs: 5000, error: (value) => `preview used the wrong page or failed to snap: ${value}` },
    );

    command("CmdMeasure");
    await openMeasure();
    await begin(2);
    coords = await setCursorAt(205, 80, 2);
    await request(ControlCommand.TestCurrentPdf, lock, HOLD_MS);
    sendMessage(canvas, WM_MOUSEMOVE, 0, coords);
    await request(ControlCommand.TestInvokeCommand, "CmdExit");
    if (!(await waitForExit(proc)) || proc.exitCode !== 0) throw new Error("failed to close during pending collection");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  const failures: string[] = [];
  for (const engine of ["pdfium", "mupdf"] as const) {
    try {
      await check(engine);
    } catch (e) {
      failures.push(`${engine}: ${(e as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
