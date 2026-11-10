import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, EXE, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { clickAt, findCanvas, FRAME_CLASS, pressEscape, sendCommand, sendCommandSync } from "./win-automation.ts";
import {
  findTopWindow,
  findVisibleChildWindow,
  getControlText,
  isWindowVisible,
  postMessage,
  sendMessage,
  sendText,
  waitForTopWindow,
} from "./winapi.ts";

const kOriginal = "ORIGINAL";
const kEdited = "EDITED";
const kDisk = "DISKWORD";
const kClickButton = 0x0400 + 102; // TDM_CLICK_BUTTON
const kCancel = 2; // IDCANCEL
const kDiscard = 100;
const kSaveExisting = 101;
const kSetSelection = 0x0186; // LB_SETCURSEL
const kGetSelection = 0x0188; // LB_GETCURSEL
type Mode = "dirty" | "text" | "choice" | "other-text" | "other-choice";

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

async function value(client: ControlClient, expected: string): Promise<void> {
  const res = await client.setFormField(1, 0, expected);
  if (!String(res[1]).includes(`before='${expected}'`)) throw new Error(`Lost ${expected}: ${res[1]}`);
}

async function roundTrip(frame: number, client: ControlClient): Promise<void> {
  sendCommandSync(frame, cmdId("CmdNextTab"));
  sendCommandSync(frame, cmdId("CmdPrevTab"));
  await client.waitForRenderIdle();
}

async function answerReload(frame: number, pid: number, button: number): Promise<void> {
  sendCommand(frame, cmdId("CmdReloadDocument"));
  let dialog = 0;
  await until(() => {
    dialog = findTopWindow(pid, "#32770");
    return dialog !== 0;
  }, "Reload did not ask about unsaved edits");
  postMessage(dialog, kClickButton, button, 0);
  await until(() => !isWindowVisible(dialog), "Unsaved dialog did not close");
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

async function check(engine: string, mode: Mode): Promise<void> {
  const dir = tmpPath(`auto-reload-unsaved/${engine}-${mode}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nReloadModifiedDocuments = true\nRestoreSession = false\nLazyLoading = false\n",
  );
  const source = join(dir, "source.pdf");
  const other = join(dir, "other.pdf");
  const log = join(dir, "app.log");
  const type = mode.includes("choice") ? "choice" : "text";
  const otherWindow = mode.startsWith("other-");
  writeFileSync(source, fixture(kOriginal, type), "latin1");
  writeFileSync(other, fixture(kOriginal), "latin1");

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      sendCommandSync(frame, cmdId("CmdPrevTab"));
      await client.waitForRenderIdle();
      if (otherWindow) {
        const rows = String((await client.request(ControlCommand.TestMigrateTab, [0, -1, 0]))[1]);
        const row = rows.split("\n").find((line) => line.trim().endsWith(other));
        const idx = /tab=(\d+)/.exec(row ?? "");
        if (!idx) throw new Error(`Other tab not found: ${rows}`);
        const moved = await client.request(ControlCommand.TestMigrateTab, [0, +idx[1]!, -1]);
        if (moved[0] !== 0) throw new Error(`Cannot create second window: ${moved[1]}`);
      }
      const canvas = findCanvas(frame);
      let editor = 0;
      if (mode === "dirty") {
        await client.setFormField(1, 0, kEdited);
      } else {
        editor = await startInput(client, canvas, type);
        if (!(await state(client)).includes("modified=0")) throw new Error("Input committed before watcher test");
      }

      const start = readFileSync(log, "utf8").length;
      writeFileSync(otherWindow ? other : source, fixture(kDisk, type), "latin1");
      await until(() => /ReloadDocument:/.test(readFileSync(log, "utf8").slice(start)), "Watcher did not reach reload");
      if (otherWindow) {
        await until(() => /reloaded in/.test(readFileSync(log, "utf8").slice(start)), "Other window did not reload");
      }
      await client.waitForRenderIdle();
      if (mode !== "dirty") {
        if (!isWindowVisible(editor)) throw new Error(`${engine} ${mode}: automatic reload destroyed active input`);
        if (type === "text" && getControlText(editor) !== kEdited) throw new Error("Active text changed");
        if (type === "choice" && Number(sendMessage(editor, kGetSelection, 0, 0)) !== 1)
          throw new Error("Active choice changed");
        await pressEscape(editor);
        if (!otherWindow) {
          await roundTrip(frame, client);
          await value(client, kDisk);
          editor = await startInput(client, canvas, type);
          await answerReload(frame, proc.pid!, kCancel);
          if (isWindowVisible(editor)) throw new Error("Manual reload did not commit input before asking");
          await value(client, kEdited);
          sendCommandSync(frame, cmdId("CmdDiscardChanges"));
          await client.waitForRenderIdle();
          await value(client, kDisk);
        }
      } else {
        if (!(await state(client)).includes("canUndo=1 canRedo=0 modified=1"))
          throw new Error(`${engine}: automatic reload lost dirty edits or Undo`);
        await roundTrip(frame, client);
        await roundTrip(frame, client);
        sendCommandSync(frame, cmdId("CmdUndo"));
        if (!(await state(client)).includes("canUndo=0 canRedo=1 modified=0")) throw new Error("Undo history changed");
        sendCommandSync(frame, cmdId("CmdRedo"));
        await value(client, kEdited);
        await answerReload(frame, proc.pid!, kCancel);
        await value(client, kEdited);
        await answerReload(frame, proc.pid!, kDiscard);
        await client.waitForRenderIdle();
        await value(client, kDisk);
        await client.setFormField(1, 0, kEdited);
        chmodSync(source, 0o444);
        try {
          await answerReload(frame, proc.pid!, kSaveExisting);
          if (!(await state(client)).includes("modified=1")) throw new Error("Failed save discarded edits");
          await value(client, kEdited);
        } finally {
          chmodSync(source, 0o666);
        }
        await answerReload(frame, proc.pid!, kSaveExisting);
        await client.waitForRenderIdle();
        if (!(await state(client)).includes("canUndo=0 canRedo=0 modified=0"))
          throw new Error("Manual save/reload failed");
        await client.setFormField(1, 0, kOriginal);
        sendCommandSync(frame, cmdId("CmdSaveAnnotations"));
        await client.waitForRenderIdle();
        if (!(await state(client)).includes("modified=0")) throw new Error("Intentional post-save reload was blocked");
        await value(client, kOriginal);
      }
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, "-log-to-file", log, "-zoom", "fit page", source, other],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
  console.log(`${engine} ${mode}: preserved edits and pending reload`);
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("auto-reload-unsaved: Windows form controls only");
    return;
  }
  const failures: string[] = [];
  for (const engine of ["mupdf", "pdfium"]) {
    for (const mode of ["dirty", "text", "choice", "other-text", "other-choice"] as const) {
      try {
        await check(engine, mode);
      } catch (error) {
        failures.push(`${engine} ${mode}: ${error}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
