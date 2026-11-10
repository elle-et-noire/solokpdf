import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, EXE, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { clickAt, findCanvas, FRAME_CLASS, sendCommand, sendCommandSync } from "./win-automation.ts";
import {
  findTopWindow,
  findVisibleChildWindow,
  isWindowVisible,
  postMessage,
  sendMessage,
  sendText,
  waitForTopWindow,
  WM_CLOSE,
} from "./winapi.ts";

const kOriginal = "ORIGINAL";
const kEdited = "EDITED";
const kDisk = "DISKWORD";
const kClickButton = 0x0400 + 102; // TDM_CLICK_BUTTON
const kCancel = 2; // IDCANCEL
const kSaveExisting = 101;
const kSetSelection = 0x0186; // LB_SETCURSEL
type AnnotType = "FreeText" | "Square";

function annotFixture(value: string, type: AnnotType): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /DR << /Font << /Helv 5 0 R >> >> >> >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
    `<< /Type /Annot /Subtype /${type} /P 3 0 R /Rect [100 300 500 400] /Contents (${value}) /DA (/Helv 18 Tf 0 g) >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

function fixture(value: string, type: "text" | "choice" = "text"): string {
  const field = type === "text" ? "/FT /Tx" : `/FT /Ch /Opt [(${kOriginal}) (${kEdited}) (${kDisk})]`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
    `<< /Type /Annot /Subtype /Widget ${field} /T (field) /V (${value}) /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(what);
    await Bun.sleep(40);
  }
}

async function state(client: ControlClient): Promise<string> {
  const res = await client.request(ControlCommand.TestMarkupAnnots);
  if (res[0] !== 0) throw new Error(String(res[1]));
  return String(res[1]);
}

async function startInput(client: ControlClient, canvas: number, type: "text" | "choice"): Promise<number> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["widget-cursor", 1, 200, 350]);
  const pt = /pt=(-?\d+),(-?\d+)/.exec(String(res[1]));
  if (!pt) throw new Error(`No field point: ${res[1]}`);
  await clickAt(canvas, +pt[1]!, +pt[2]!, 0, 0, client);
  let editor = 0;
  await until(() => {
    editor = findVisibleChildWindow(canvas, type === "choice" ? "ListBox" : "Edit");
    return editor !== 0;
  }, "No form editor");
  if (type === "text") sendText(editor, kEdited);
  else sendMessage(editor, kSetSelection, 1, 0);
  return editor;
}

async function selectAnnot(client: ControlClient, canvas: number): Promise<void> {
  const rect = /type=\w+[^\n]*screen=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(await state(client));
  if (!rect) throw new Error("No annotation rectangle");
  await until(async () => {
    await clickAt(canvas, +rect[1]! + +rect[3]! / 2, +rect[2]! + +rect[4]! / 2, 0, 0, client);
    return (await state(client)).includes("state selected=1");
  }, "Annotation was not selected");
}

async function startAnnotInput(client: ControlClient, canvas: number, pid: number, type: AnnotType): Promise<number> {
  await selectAnnot(client, canvas);
  const dump = await state(client);
  const chip = /[=;]contents:(-?\d+),(-?\d+),(\d+),(\d+)/.exec(dump);
  const placed = / placed=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(dump);
  const toolbar = findTopWindow(pid, "SumatraAnnotEditToolbar");
  if (!chip || !placed || !toolbar) throw new Error(`No Contents chip: ${dump}`);
  await clickAt(
    toolbar,
    +chip[1]! - +placed[1]! + +chip[3]! / 2,
    +chip[2]! - +placed[2]! + +chip[4]! / 2,
    0,
    0,
    client,
  );
  let editor = 0;
  await until(() => {
    editor = findVisibleChildWindow(type === "FreeText" ? canvas : toolbar, "Edit");
    return editor !== 0;
  }, "No annotation editor");
  sendText(editor, kEdited);
  return editor;
}

type Input = AnnotType | "text" | "choice";
const commands = {
  reload: "CmdReloadDocument",
  close: "CmdClose",
  save: "CmdSaveAnnotations",
  "save-dirty": "CmdSaveAnnotations",
  "save-failed": "CmdSaveAnnotations",
  "save-as": "CmdSaveAs",
  "window-close": "WM_CLOSE",
} as const;
type Action = keyof typeof commands;

async function readValue(client: ControlClient, input: Input, expected: string): Promise<void> {
  const result =
    input === "text" || input === "choice"
      ? await client.setFormField(1, 0, expected)
      : await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", expected]);
  if (result[0] !== 0 || !String(result[1]).includes(`before='${expected}'`))
    throw new Error(`Expected ${expected}: ${result[1]}`);
  if (input === "FreeText" && expected.includes("\n")) {
    const rect = /type=FreeText[^\n]*rect=[^,]+,[^,]+,[^,]+,([\d.]+)/.exec(await state(client));
    const originalHeight = 100;
    if (!rect || +rect[1]! <= originalHeight) throw new Error("Closing lost the expanded FreeText bounds");
  }
}

async function checkPending(engine: string, input: Input, action: Action): Promise<void> {
  const label = `${engine}-${input}-${action}`;
  const dir = tmpPath(`pending-document-input/${label}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nRestoreSession = false\nLazyLoading = false\nReloadModifiedDocuments = false\n",
  );
  const source = join(dir, "source.pdf");
  const other = join(dir, "other.pdf");
  const saved = action === "save-as" ? join(dir, "saved.pdf") : source;
  const form = input === "text" || input === "choice";
  const expected = input === "FreeText" && action === "window-close" ? Array(10).fill(kEdited).join("\n") : kEdited;
  writeFileSync(source, form ? fixture(kOriginal, input) : annotFixture(kOriginal, input), "latin1");
  writeFileSync(other, fixture(kOriginal), "latin1");
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      sendCommandSync(frame, cmdId("CmdPrevTab"));
      await client.waitForRenderIdle();
      if (!form) sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
      const canvas = findCanvas(frame);
      if (action === "save-dirty") {
        if (form) await client.setFormField(1, 0, kDisk);
        else {
          const changed = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", kDisk]);
          if (changed[0] !== 0) throw new Error(`Prior change failed: ${changed[1]}`);
        }
      }
      const editor = form
        ? await startInput(client, canvas, input)
        : await startAnnotInput(client, canvas, proc.pid!, input);
      if (expected !== kEdited) sendText(editor, expected);
      const invoke = () =>
        action === "window-close" ? postMessage(frame, WM_CLOSE, 0, 0) : sendCommand(frame, cmdId(commands[action]));
      const findPrompt = () => {
        const dialog = findTopWindow(proc.pid!, "#32770");
        return dialog && isWindowVisible(dialog) ? dialog : 0;
      };
      try {
        if (action === "save-as") await client.request(ControlCommand.TestSaveFileName, [saved]);
        if (action === "save-failed") chmodSync(source, 0o444);
        invoke();
        if (action === "reload" || action === "close" || action === "window-close") {
          let dialog = 0;
          await until(() => {
            dialog = findPrompt();
            return dialog !== 0;
          }, `${label}: input discarded without a save prompt`);
          if (!dialog) throw new Error(`${label}: input discarded without a save prompt`);
          postMessage(dialog, kClickButton, kCancel, 0);
          await until(() => !isWindowVisible(dialog), "Cancel did not close prompt");
          await readValue(client, input, expected);
          if (!(await state(client)).includes("modified=1")) throw new Error("Cancel lost the pending edit");
          invoke();
          await until(() => {
            dialog = findPrompt();
            return !!dialog;
          }, "Save prompt was not rearmed");
          postMessage(dialog, kClickButton, kSaveExisting, 0);
          await until(() => !isWindowVisible(dialog), "Save did not finish");
        } else {
          await until(() => !isWindowVisible(editor), `${label}: save did not commit pending input`);
          if (action === "save-failed") {
            await client.waitForRenderIdle();
            await readValue(client, input, expected);
            if (!(await state(client)).includes("modified=1")) throw new Error("Failed save lost the edit");
            chmodSync(source, 0o666);
            invoke();
            await until(async () => (await state(client)).includes("modified=0"), "Save retry did not finish");
          }
        }
        if (action !== "window-close") await client.waitForRenderIdle();
      } finally {
        chmodSync(source, 0o666);
        const dialog = findPrompt();
        if (dialog) postMessage(dialog, kClickButton, kCancel, 0);
        if (proc.exitCode === null) await client.resolveUnsavedChanges("discard").catch(() => {});
      }
    },
    ["-appdata", dir, "-zoom", "fit page", source, other],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
  await withControlledSumatra(
    EXE,
    async (client) => {
      try {
        await client.waitForRenderIdle();
        await readValue(client, input, expected);
        if (!(await state(client)).includes("modified=0")) throw new Error(`${label}: reopened file is dirty`);
      } finally {
        await client.resolveUnsavedChanges("discard");
      }
    },
    ["-appdata", dir, saved],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
  console.log(`${label}: pending input saved`);
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP pending-document-input: Windows edit controls only");
    return;
  }
  const failures: string[] = [];
  for (const engine of ["mupdf", "pdfium"]) {
    for (const input of ["FreeText", "Square", "text", "choice"] as const) {
      for (const action of [
        "reload",
        "close",
        "save",
        "save-dirty",
        "save-failed",
        "save-as",
        "window-close",
      ] as const) {
        const label = `${engine}-${input}-${action}`;
        if (process.env.PENDING_INPUT_CASE && process.env.PENDING_INPUT_CASE !== label) continue;
        if (process.env.PENDING_INPUT_ACTION && process.env.PENDING_INPUT_ACTION !== action) continue;
        try {
          await checkPending(engine, input, action);
        } catch (error) {
          failures.push(`${label}: ${error}`);
        }
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
