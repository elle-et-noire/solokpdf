import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { macControlRequest } from "./mac-control.ts";
import { assemblePdf, cmdId, makeTextPdf, pollUntil, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { clickAt, findCanvas, killAndWait, launchControlled, takeStderr } from "./win-automation.ts";
import {
  findTopWindow,
  findVisibleChildWindow,
  isWindowVisible,
  postMessage,
  sendMessage,
  WM_COMMAND,
} from "./winapi.ts";

const kNo = 7; // IDNO
const kSetSelection = 0x0186; // LB_SETCURSEL

async function check(engine: string, mode: "destroy" | "cancel" | "input"): Promise<void> {
  const close = mode === "destroy";
  const dir = tmpPath(`print-close-reentry/${engine}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "source.pdf");
  const signal = join(dir, "finish");
  const log = join(dir, "app.log");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nShowStartPage = false\nShowToc = false\nRestoreSession = false\n",
  );
  rmSync(signal, { force: true });
  rmSync(`${signal}.done`, { force: true });
  const form = assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Ch /Opt [(ORIGINAL) (EDITED)] /T (field) /V (ORIGINAL) /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
  writeFileSync(pdf, mode === "input" ? Buffer.from(form, "latin1") : makeTextPdf("Print confirmation lifetime"));
  const app = await launchControlled(["-appdata", dir, "-log-to-file", log, pdf], {
    env: { ...process.env, SOLOKPDF_ENGINE: engine },
  });
  try {
    await app.client.waitForRenderIdle();
    if ((await app.client.request(ControlCommand.TestCurrentPdf, ["save-faults"]))[1] !== "supported") {
      console.log("SKIP print-close-reentry: requires Debug");
      return;
    }
    if (mode === "input") {
      const result = await app.client.request(ControlCommand.TestCurrentPdf, ["widget-cursor", 1, 200, 350]);
      const pt = /pt=(-?\d+),(-?\d+)/.exec(String(result[1]));
      if (!pt) throw new Error("No choice field point");
      const canvas = findCanvas(app.frame);
      await clickAt(canvas, +pt[1]!, +pt[2]!, 0, 0, app.client);
      const list = await pollUntil(
        () => findVisibleChildWindow(canvas, "ListBox"),
        (hwnd) => !!hwnd,
        { error: "No choice editor" },
      );
      sendMessage(list!, kSetSelection, 1, 0);
    }
    const asking = app.client.request(ControlCommand.TestCurrentPdf, ["print-close", signal]);
    const dialog = await pollUntil(
      () => findTopWindow(app.proc.pid!, "#32770"),
      (hwnd) => !!hwnd && isWindowVisible(hwnd),
      { error: "No print confirmation" },
    );
    writeFileSync(signal, "finish");
    await pollUntil(
      () => existsSync(`${signal}.done`),
      (done) => done,
      { error: "Test print did not finish" },
    );
    await pollUntil(
      () => macControlRequest(ControlCommand.TestCurrentPdf, ["print-ready"])[1],
      (state) => state === "ready",
      { error: "Test print thread did not exit" },
    );
    if (close) postMessage(app.frame, WM_COMMAND, cmdId("CmdExit"), 0);
    else postMessage(dialog!, WM_COMMAND, kNo, 0);
    const result = await asking;
    const expected = close ? "allowed=0 live=0" : "allowed=0 live=1";
    if (result[0] !== 0 || result[1] !== expected) throw new Error(`${engine}: ${result[1]}, expected ${expected}`);
    if (mode === "input") {
      const value = await app.client.setFormField(1, 0, "EDITED");
      if (!String(value[1]).includes("before='EDITED'")) throw new Error(`Print confirmation lost input: ${value[1]}`);
      await app.client.resolveUnsavedChanges("discard");
    }
    app.client.close();
    if (close) {
      const exit = await Promise.race([app.proc.exited, Bun.sleep(8000).then(() => -1)]);
      const stderr = await takeStderr(app.proc);
      if (exit !== 0 || /AddressSanitizer|runtime error/i.test(stderr)) throw new Error(`Exit ${exit}: ${stderr}`);
      const output = readFileSync(log, "utf8");
      if (output.includes("timed out waiting") || !output.includes("shutdown: shared cleanup complete"))
        throw new Error(`Shutdown did not finish normally: ${stderr}`);
      if (stderr.trim()) console.log(`${engine}: shutdown stderr: ${stderr.trim()}`);
    }
  } finally {
    writeFileSync(signal, "finish");
    app.client.close();
    await killAndWait(app.proc);
  }
  console.log(`${engine} ${mode}: close confirmation validated`);
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  for (const engine of ["mupdf", "pdfium"]) {
    for (const mode of ["destroy", "cancel", "input"] as const) {
      if (process.env.PRINT_INPUT_ONLY && mode !== "input") continue;
      await check(engine, mode);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
