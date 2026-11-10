import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, ControlCommand } from "./control.ts";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import {
  clientToScreen,
  getClientRect,
  MK_LBUTTON,
  packCoords,
  sendMessage,
  sleep,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import { findCanvas, killAndWait, launchControlled, moveTestCursor, sendCommandSync } from "./win-automation.ts";

function fixture(): string {
  const first = "BT /F1 24 Tf 72 700 Td (SECRETONE KEEPONE) Tj ET";
  const second = "BT /F1 24 Tf 72 700 Td (SECRETTWO KEEPTWO) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 7 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    "<< /Type /Annot /Subtype /Redact /P 3 0 R /Rect [66 690 230 725] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R /Annots [9 0 R 10 0 R] >>",
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
    "<< /Type /Annot /Subtype /Redact /P 7 0 R /Rect [66 690 230 725] >>",
    "<< /Type /Annot /Subtype /FreeText /P 7 0 R /Rect [100 690 180 720] /Contents (OVERLAP) /DA (/Helv 10 Tf 0 g) >>",
  ]);
}

async function state(client: ControlClient): Promise<string> {
  const res = await client.request(ControlCommand.TestMarkupAnnots, []);
  if (res[0] !== 0) throw new Error(`state: ${res[1]}`);
  return String(res[1] ?? "");
}

async function page(client: ControlClient, n: number): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["clone-page", n]);
  if (res[0] !== 0) throw new Error(`page ${n}: ${res[1]}`);
  return String(res[1] ?? "");
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("redact-partial");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nRestoreSession = false\nCheckForUpdates = false\n");
  const pdf = join(dir, "redact.pdf");
  writeFileSync(pdf, fixture(), "latin1");
  for (const engine of ["mupdf", "pdfium"]) {
    for (const mode of process.env.REDACT_CASE
      ? [process.env.REDACT_CASE]
      : ["2", "a", "l", "p", "u", "v", "r", "*", "b"]) {
      const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
        env: { SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_REDACT_FAIL: mode },
      });
      try {
        await client.waitForRenderIdle();
        if ((await client.request(ControlCommand.TestCurrentPdf, ["redact-faults"]))[1] !== "supported") {
          console.log("SKIP redact-partial: Debug fault injection unavailable");
          return;
        }
        let raw = await state(client);
        if (!/annotations=3\b/.test(raw)) throw new Error(`${engine}: expected three annotations\n${raw}`);
        sendCommandSync(frame, cmdId("CmdApplyRedactions"));
        raw = await state(client);
        if (mode === "v") {
          const text = String((await client.request(ControlCommand.TestCurrentPdf, ["editor-text", 2]))[1] ?? "");
          if (!text.includes("SECRETTWO"))
            throw new Error(`${engine}: page unreadable during annotation failure: ${text}`);
          await client.request(ControlCommand.TestCurrentPdf, ["redact-resume"]);
          await client.request(ControlCommand.TestCurrentPdf, ["text-page", 2]);
          raw = await state(client);
        }
        if (mode === "*" || mode === "b") {
          if (
            !/annotations=3\b/.test(raw) ||
            !/canUndo=0 canRedo=0 modified=0/.test(raw) ||
            !/actionNotification=.*[Ff]ailed/.test(raw)
          )
            throw new Error(`${engine} ${mode}: all failed state\n${raw}`);
          if (mode === "*" && !/actionNotification=.*failed.*1, 2/i.test(raw))
            throw new Error(`${engine}: failed page numbers missing\n${raw}`);
          if (!(await page(client, 1)).includes("SECRETONE") || !(await page(client, 2)).includes("SECRETTWO"))
            throw new Error(`${engine} ${mode}: text changed`);
          continue;
        }
        if (
          !/annotations=2\b/.test(raw) ||
          !/type=Redact\b/.test(raw) ||
          !/type=FreeText\b/.test(raw) ||
          !/freeTextContents=OVERLAP/.test(raw)
        )
          throw new Error(`${engine} ${mode}: failed page annotations not preserved\n${raw}`);
        if (!/modified=1/.test(raw) || !/canUndo=1/.test(raw)) throw new Error(`${engine}: dirty/undo\n${raw}`);
        if (!/actionNotification=.*partially applied.*[Ff]ailed.*2/.test(raw))
          throw new Error(`${engine}: partial result not reported\n${raw}`);
        const p1 = await page(client, 1);
        const p2 = await page(client, 2);
        if (p1.includes("SECRETONE") || !p2.includes("SECRETTWO"))
          throw new Error(`${engine}: wrong applied text\n${p1}\n${p2}`);
        if (mode === "r") {
          sendCommandSync(frame, cmdId("CmdApplyRedactions"));
          const retried = await state(client);
          if (!/annotations=0\b/.test(retried) || (await page(client, 2)).includes("SECRETTWO"))
            throw new Error(`${engine}: retry did not apply the remaining mark\n${retried}`);
          sendCommandSync(frame, cmdId("CmdUndo"));
          const afterRetryUndo = await state(client);
          if (!/annotations=2\b/.test(afterRetryUndo) || !(await page(client, 2)).includes("SECRETTWO"))
            throw new Error(`${engine}: retry undo did not restore the remaining mark\n${afterRetryUndo}`);
        }
        sendCommandSync(frame, cmdId("CmdUndo"));
        raw = await state(client);
        if (!/annotations=3\b/.test(raw) || !/modified=0/.test(raw) || !(await page(client, 1)).includes("SECRETONE"))
          throw new Error(`${engine}: undo failed\n${raw}`);
        sendCommandSync(frame, cmdId("CmdRedo"));
        const saved = join(dir, `saved-${engine}-${mode}.pdf`);
        await client.resolveUnsavedChanges("save-as", saved);
        const reopened = await launchControlled(["-appdata", dir, saved], { env: { SOLOKPDF_ENGINE: engine } });
        try {
          await reopened.client.waitForRenderIdle();
          await reopened.client.request(ControlCommand.TestCurrentPdf, ["editor-text", 2]);
          const savedState = await state(reopened.client);
          if (
            !/annotations=2\b/.test(savedState) ||
            !/freeTextContents=OVERLAP/.test(savedState) ||
            (await page(reopened.client, 1)).includes("SECRETONE") ||
            !(await page(reopened.client, 2)).includes("SECRETTWO")
          )
            throw new Error(`${engine} ${mode}: saved document differs\n${savedState}`);
        } finally {
          reopened.client.close();
          await killAndWait(reopened.proc);
        }
      } finally {
        client.close();
        await killAndWait(proc);
      }
    }
    const marked = await launchControlled(["-appdata", dir, "-view", "single page", pdf], {
      env: { SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_REDACT_FAIL: "2" },
    });
    try {
      await marked.client.waitForRenderIdle();
      sendCommandSync(marked.frame, cmdId("CmdGoToNextPage"));
      await marked.client.waitForRenderIdle();
      sendCommandSync(marked.frame, cmdId("CmdCreateAnnotRedact"));
      const canvas = findCanvas(marked.frame);
      const rect = getClientRect(canvas);
      const x = Math.floor(rect.right / 2);
      const y = Math.floor(rect.bottom / 2);
      const screen = clientToScreen(canvas, x, y);
      await moveTestCursor(screen.x, screen.y);
      sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(x, y));
      sendMessage(canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(x, y));
      await sleep(50);
      sendMessage(canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(x + 80, y + 50));
      sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(x + 80, y + 50));
      let raw = await state(marked.client);
      if (!/annotations=4\b/.test(raw) || !/userRedact=1/.test(raw))
        throw new Error(`${engine}: user mark was not created\n${raw}`);
      sendCommandSync(marked.frame, cmdId("CmdApplyRedactions"));
      raw = await state(marked.client);
      if (!/annotations=3\b/.test(raw) || !/userRedact=1/.test(raw))
        throw new Error(`${engine}: user mark was lost after partial apply\n${raw}`);
      sendCommandSync(marked.frame, cmdId("CmdUndo"));
      raw = await state(marked.client);
      if (!/annotations=4\b/.test(raw) || !/userRedact=1/.test(raw) || !/modified=1/.test(raw))
        throw new Error(`${engine}: undo lost the prior user mark\n${raw}`);
    } finally {
      marked.client.close();
      await killAndWait(marked.proc);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
