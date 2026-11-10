import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, EXE, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { FRAME_CLASS } from "./win-automation.ts";
import {
  enumChildWindows,
  enumWindows,
  getClassName,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  postMessage,
  waitForTopWindow,
  WM_CLOSE,
} from "./winapi.ts";

const kEdited = "RETAINED";
const kClickButton = 0x0400 + 102; // TDM_CLICK_BUTTON
const kCancel = 2; // IDCANCEL
const kDiscard = 100;
const kSaveNew = 102;
type Input = "small" | "handle" | "attachment" | "mapped";

function findDialog(pid: number): number {
  let found = 0;
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) === pid && getClassName(hwnd) === "#32770" && isWindowVisible(hwnd)) {
      found = hwnd;
      return false;
    }
    return true;
  });
  return found;
}

function hasButton(dialog: number, text: string): boolean {
  let found = false;
  enumChildWindows(dialog, (child) => {
    if (getWindowText(child) === text) found = true;
    return !found;
  });
  return found;
}

function fixture(input: Input): string {
  return assemblePdf(
    [
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
      "<< /Type /Annot /Subtype /Widget /FT /Tx /T (field) /V (ORIGINAL) /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ],
    { header: input === "handle" || input === "mapped" ? `%PDF-1.4\n%${"x".repeat(33 * 1024 * 1024)}\n` : undefined },
  );
}

function outerPdf(inner: string): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /FileAttachment /P 3 0 R /Rect [100 100 200 200] /FS 5 0 R >>",
    "<< /Type /Filespec /F (inner.pdf) /EF << /F 6 0 R >> >>",
    `<< /Type /EmbeddedFile /Length ${inner.length} >>\nstream\n${inner}\nendstream`,
  ]);
}

async function until(check: () => boolean | Promise<boolean>, error: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(error);
    await Bun.sleep(40);
  }
}

async function dirty(client: ControlClient): Promise<void> {
  const result = await client.request(ControlCommand.TestMarkupAnnots);
  if (!String(result[1]).includes("modified=1")) throw new Error(`Lost dirty state: ${result[1]}`);
  const value = await client.setFormField(1, 0, kEdited);
  if (!String(value[1]).includes(`before='${kEdited}'`)) throw new Error(`Lost edit: ${value[1]}`);
}

async function check(engine: string, input: Input, action: "rename" | "delete"): Promise<void> {
  const name = `${engine}-${input}-${action}`;
  const dir = tmpPath(`missing-source-unsaved/${name}`);
  rmSync(dir, { recursive: true, force: true });
  const sourceDir = join(dir, "input");
  mkdirSync(dir, { recursive: true });
  if (input === "mapped") {
    const target = join(dir, "target");
    mkdirSync(target);
    symlinkSync(target, sourceDir, "junction");
  } else mkdirSync(sourceDir);
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nReloadModifiedDocuments = false\nRestoreSession = false\n");
  const source = join(sourceDir, "source.pdf");
  const saved = join(dir, "saved.pdf");
  const pdf = fixture(input);
  writeFileSync(source, input === "attachment" ? outerPdf(pdf) : pdf, "latin1");

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      await client.waitForRenderIdle();
      if (input === "attachment") {
        const opened = await client.request(ControlCommand.TestMarkupAnnots, ["open-embedded", 0, 0]);
        if (opened[0] !== 0) throw new Error(`Attachment: ${opened[1]}`);
        await client.waitForRenderIdle();
      }
      if (input === "mapped") renameSync(sourceDir, join(dir, "moved"));
      await client.setFormField(1, 0, kEdited);
      await dirty(client);
      if (input !== "mapped") {
        if (action === "rename") renameSync(source, join(sourceDir, "moved.pdf"));
        else unlinkSync(source);
      }
      if (existsSync(source)) throw new Error("Source still exists");

      async function prompt(): Promise<number> {
        postMessage(frame, WM_CLOSE, 0, 0);
        let dialog = 0;
        await until(() => {
          if (proc.exitCode !== null) throw new Error("Close discarded unsaved edits without asking");
          dialog = findDialog(proc.pid!);
          return dialog !== 0;
        }, "Missing unsaved prompt");
        return dialog;
      }

      let dialog = await prompt();
      if (hasButton(dialog, "&Save to existing PDF")) throw new Error("Offered missing source overwrite");
      const saveNew = hasButton(dialog, "Save to &new PDF");
      if (!!saveNew !== (input !== "mapped")) throw new Error(`Unsafe/missing SaveNew: ${input}`);
      postMessage(dialog, kClickButton, kCancel, 0);
      await until(() => !isWindowVisible(dialog), "Cancel did not dismiss prompt");
      await dirty(client);

      if (input === "mapped") {
        for (const args of [["save"], ["save-as", saved]]) {
          const result = await client.request(ControlCommand.ResolveUnsavedChanges, args);
          if (result[0] === 0 || existsSync(saved)) throw new Error(`Mapped save was allowed: ${result[1]}`);
          await dirty(client);
        }
        const moved = join(dir, "moved");
        renameSync(moved, sourceDir);
        dialog = await prompt();
        if (!hasButton(dialog, "&Save to existing PDF") || !hasButton(dialog, "Save to &new PDF"))
          throw new Error("Restored source did not enable saving");
        postMessage(dialog, kClickButton, kCancel, 0);
        await until(() => !isWindowVisible(dialog), "Restored source Cancel failed");
        renameSync(sourceDir, moved);
        dialog = await prompt();
        postMessage(dialog, kClickButton, kDiscard, 0);
      } else {
        dialog = await prompt();
        postMessage(dialog, kClickButton, kSaveNew, 0);
        let fileDialog = 0;
        await until(() => {
          fileDialog = findDialog(proc.pid!);
          const title = fileDialog ? getWindowText(fileDialog) : "";
          return title.length > 0 && title !== "Unsaved changes";
        }, "SaveNew did not open a file dialog");
        postMessage(fileDialog, WM_CLOSE, 0, 0);
        await until(() => !isWindowVisible(fileDialog), "Save file dialog did not cancel");
        await dirty(client);
        await client.request(ControlCommand.TestSaveFileName, [join(dir, "missing", "failed.pdf")]);
        dialog = await prompt();
        postMessage(dialog, kClickButton, kSaveNew, 0);
        await until(() => !isWindowVisible(dialog), "Failed save did not return");
        await dirty(client);
        if (existsSync(saved)) throw new Error("Failed save created output");
        await client.request(ControlCommand.TestSaveFileName, [saved]);
        dialog = await prompt();
        postMessage(dialog, kClickButton, kSaveNew, 0);
      }
      await until(() => proc.exitCode !== null, "Close did not complete");
      if (proc.exitCode !== 0) throw new Error(`Exit: ${proc.exitCode}`);
    },
    ["-appdata", dir, "-log-to-file", join(dir, "app.log"), source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );

  if (input !== "mapped") {
    await withControlledSumatra(
      EXE,
      async (client) => {
        await client.waitForRenderIdle();
        const state = await client.request(ControlCommand.TestMarkupAnnots);
        if (!String(state[1]).includes("modified=0")) throw new Error("Saved file reopened dirty");
        const result = await client.setFormField(1, 0, kEdited);
        if (!String(result[1]).includes(`before='${kEdited}'`)) throw new Error(`Saved edit missing: ${result[1]}`);
      },
      ["-appdata", dir, saved],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
  }
  console.log(`${name}: prompt, Cancel, ${input === "mapped" ? "Discard" : "save failure, retry and reopen"}`);
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const errors: string[] = [];
  for (const engine of ["mupdf", "pdfium"]) {
    const inputs: Input[] = ["small", "attachment", engine === "pdfium" ? "handle" : "mapped"];
    for (const input of inputs) {
      for (const action of input === "mapped" ? (["rename"] as const) : (["rename", "delete"] as const)) {
        try {
          await check(engine, input, action);
        } catch (error) {
          errors.push(`${engine} ${input} ${action}: ${error}`);
        }
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
