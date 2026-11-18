// Apply Redactions keeps the document open and undoable in both engines (B17).
// A PDFium tab draws and reads a redacted page from the MuPDF editor until it is
// saved: the black box shows, the text is gone, the file is untouched, and one
// undo brings the original page back. Print renders a copy of the document; until Save
// it must be the redacted one (B52). Search follows apply and undo, and a PDFium page that
// isn't redacted never waits for the editor's lock (B53).

import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, ControlCommand } from "./control.ts";
import { assemblePdf, cmdId, pollUntil, runStandalone, SETTINGS_FILE, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";
import { captureWindowPixels } from "./winapi.ts";
import { findCanvas, killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";

const kTag = "ad-hoc-pdfium-redaction-undo";
const SECRET = "SECRETWORD";

// The mark covers SECRETWORD and the first of two lines. A link covers the first line.
function makePdf(): string {
  const content = `BT /F1 24 Tf 72 700 Td (${SECRET} KEEPWORD) Tj ET\n1 w 100 710 m 170 710 l S\n320 710 m 380 710 l S`;
  const content2 = "BT /F1 24 Tf 72 700 Td (PAGETWO) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 7 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> " +
      "/Contents 5 0 R /Annots [6 0 R 9 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Annot /Subtype /Redact /P 3 0 R /Rect [66 690 247 725] /QuadPoints [66 725 247 725 66 690 247 690] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>",
    `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [98 707 172 713] /A << /S /URI /URI (https://example.invalid/) >> >>",
  ]);
}

type State = { raw: string; annotations: number; text: string; canUndo: boolean; modified: boolean };

async function state(client: ControlClient): Promise<State> {
  const res = await client.request(ControlCommand.TestMarkupAnnots, []);
  const raw = String(res[1] ?? "");
  const undo = /undo canUndo=(\d) canRedo=\d modified=(\d)/.exec(raw);
  return {
    raw,
    annotations: +(/annotations=(\d+)/.exec(raw)?.[1] ?? -1),
    text: /^page1text=(.*)$/m.exec(raw)?.[1] ?? "",
    canUndo: undo?.[1] === "1",
    modified: undo?.[2] === "1",
  };
}

function waitState(client: ControlClient, ok: (s: State) => boolean, what: string): Promise<State> {
  return pollUntil(() => state(client), ok, { error: (s) => `${kTag}: ${what}\n${s.raw}` });
}

// page 1 of the copy print renders: its ink and text
async function printed(client: ControlClient): Promise<{ ink: number; text: string; raw: string }> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["clone-page", 1]);
  const raw = String(res[1] ?? "");
  const m = /^ink=(-?\d+) text=([\s\S]*)$/.exec(raw);
  if (res[0] !== 0 || !m) {
    throw new Error(`${kTag}: clone-page: ${raw}`);
  }
  return { ink: +m[1]!, text: m[2]!, raw };
}

// whether search finds SECRET on page 1
async function found(client: ControlClient): Promise<boolean> {
  const res = await client.request(ControlCommand.TestCurrentPdf, [SECRET]);
  const m = / found=(\d) /.exec(String(res[1] ?? ""));
  if (res[0] !== 0 || !m) {
    throw new Error(`${kTag}: search: ${String(res[1])}`);
  }
  return m[1] === "1";
}

async function checkSnap(client: ControlClient, x: number, expected: number, step: string): Promise<void> {
  const [status, result] = await client.request(ControlCommand.TestMeasurement, ["click", 1, x + 3, 84]);
  const measured = Number(/\bx=([^ ]+)/.exec(String(result))?.[1]);
  if (status !== 0 || !Number.isFinite(measured) || Math.abs(measured - expected) > 1) {
    throw new Error(`${kTag}: ${step}: expected snap x=${expected}, got ${result}`);
  }
}

async function checkLinks(
  client: ControlClient,
  expected: number,
  load: "normal" | "fail-load" = "normal",
): Promise<void> {
  const [status, result] = await client.request(ControlCommand.TestCurrentPdf, ["get-elements", 1, load]);
  if (status !== 0 || Number(/\blinks=(\d+)/.exec(String(result))?.[1]) !== expected) {
    const read = load === "fail-load" ? "failed page load" : "page elements";
    throw new Error(`${kTag}: ${read}: expected ${expected} links, got ${result}`);
  }
}

// How long a non-blocking read of pageNo takes while another thread holds the editor's
// document lock (as a long editor render does). Waits the hold out before returning.
async function readWhileEditorBusy(client: ControlClient, pageNo: number): Promise<number> {
  const kHoldMs = 1500;
  const held = await client.request(ControlCommand.TestCurrentPdf, ["hold-editor-lock", kHoldMs]);
  if (held[0] !== 0) {
    throw new Error(`${kTag}: hold-editor-lock: ${String(held[1])}`);
  }
  const start = Date.now();
  const res = await client.request(ControlCommand.TestCurrentPdf, ["try-elements", pageNo]);
  const ms = Date.now() - start;
  if (res[0] !== 0) {
    throw new Error(`${kTag}: try-elements: ${String(res[1])}`);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, kHoldMs - ms) + 100));
  return ms;
}

// near-black pixels of the canvas: text, or the black box redaction burns in
function darkPixels(canvas: number): number {
  const img = captureWindowPixels(canvas);
  if (!img) {
    return -1;
  }
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i]! < 60 && img.data[i + 1]! < 60 && img.data[i + 2]! < 60) {
      n++;
    }
  }
  return n;
}

async function runEngine(engine: string): Promise<void> {
  const dir = tmpPath(`${kTag}-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  const appdata = join(dir, "appdata");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), "UiLanguage = en\nRestoreSession = false\nCheckForUpdates = false\n");
  const pdf = join(dir, "secret.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const original = readFileSync(pdf);

  const { proc, client, frame } = await launchControlled(
    ["-appdata", appdata, "-view", "single page", "-zoom", "fit width", pdf],
    { env: { SOLOKPDF_ENGINE: engine } },
  );
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    let s = await waitState(client, (st) => st.annotations === 1, "the redaction mark did not load");
    if (!s.text.includes(SECRET)) {
      throw new Error(`${kTag} ${engine}: the page must have the text before applying\n${s.raw}`);
    }
    await client.waitForRenderIdle();
    const before = darkPixels(canvas);
    const printBefore = await printed(client);
    if (!printBefore.text.includes(SECRET)) {
      throw new Error(`${kTag} ${engine}: print copy before applying: ${printBefore.raw}`);
    }
    await client.request(ControlCommand.TestInvokeCommand, ["CmdMeasure"]);
    await checkSnap(client, 100, 100, `${engine} before Apply Redactions`);
    await checkSnap(client, 320, 320, `${engine} before Apply Redactions`);
    if (engine === "pdfium") {
      await checkLinks(client, 1);
    }

    sendCommandSync(frame, cmdId("CmdApplyRedactions"));
    s = await waitState(client, (st) => st.annotations === 0, "applying did not remove the mark");
    if (s.text.includes(SECRET) || !s.text.includes("KEEPWORD") || !s.modified || !s.canUndo) {
      throw new Error(`${kTag} ${engine}: applied text, undo or modified state is wrong\n${s.raw}`);
    }
    if (!readFileSync(pdf).equals(original)) {
      throw new Error(`${kTag} ${engine}: applying must not write the file before Save`);
    }
    if (engine === "pdfium") {
      const [, faults] = await client.request(ControlCommand.TestCurrentPdf, ["redact-faults"]);
      if (faults === "supported") {
        await checkLinks(client, 0, "fail-load");
      }
      await checkLinks(client, 0);
    }
    await checkSnap(client, 100, 103, `${engine} after Apply Redactions`);
    await checkSnap(client, 320, 320, `${engine} after Apply Redactions`);
    const printApplied = await printed(client);
    if (
      printApplied.text.includes(SECRET) ||
      !printApplied.text.includes("KEEPWORD") ||
      printApplied.ink < printBefore.ink * 1.5
    ) {
      throw new Error(
        `${kTag} ${engine}: print must show the unsaved redaction (ink ${printBefore.ink}): ${printApplied.raw}`,
      );
    }
    if (await found(client)) {
      throw new Error(`${kTag} ${engine}: search finds redacted text`);
    }
    if (engine === "pdfium") {
      const ms = await readWhileEditorBusy(client, 2);
      if (ms > 750) {
        throw new Error(`${kTag}: reading an unredacted page waited ${ms} ms for the editor`);
      }
    }
    const timeoutMs = 5000 * SLOW_BUILD_FACTOR;
    const applied = await pollUntil(
      async () => (await client.waitForRenderIdle(), darkPixels(canvas)),
      (n) => n > before * 1.5,
      { timeoutMs, error: (n) => `${kTag} ${engine}: no black box drawn (${before} -> ${n} dark pixels)` },
    );

    sendCommandSync(frame, cmdId("CmdUndo"));
    s = await waitState(client, (st) => st.annotations === 1, "one undo did not bring back the mark");
    if (!s.text.includes(SECRET) || s.modified || s.canUndo) {
      throw new Error(`${kTag} ${engine}: undo must restore the original page\n${s.raw}`);
    }
    await checkSnap(client, 100, 100, `${engine} after Undo`);
    await checkSnap(client, 320, 320, `${engine} after Undo`);
    if (engine === "pdfium") {
      await checkLinks(client, 1);
    }
    const printUndone = await printed(client);
    if (!printUndone.text.includes(SECRET)) {
      throw new Error(`${kTag} ${engine}: print after undo: ${printUndone.raw}`);
    }
    if (!(await found(client))) {
      throw new Error(`${kTag} ${engine}: search misses the text undo restored`);
    }
    if (engine === "pdfium") {
      const ms = await readWhileEditorBusy(client, 1);
      if (ms > 750) {
        throw new Error(`${kTag}: after undo, page 1 waited ${ms} ms for the editor`);
      }
    }
    await pollUntil(
      async () => (await client.waitForRenderIdle(), darkPixels(canvas)),
      (n) => n < applied * 0.8,
      { timeoutMs, error: (n) => `${kTag} ${engine}: undo left the black box (${applied} -> ${n} dark pixels)` },
    );

    sendCommandSync(frame, cmdId("CmdRedo"));
    s = await waitState(client, (st) => st.annotations === 0, "redo did not apply again");
    if (s.text.includes(SECRET)) {
      throw new Error(`${kTag} ${engine}: redo must remove the text again\n${s.raw}`);
    }
    await checkSnap(client, 100, 103, `${engine} after Redo`);
    await checkSnap(client, 320, 320, `${engine} after Redo`);
    if (engine === "pdfium") {
      await checkLinks(client, 0);
    }
    console.log(`${kTag} ${engine}: OK (dark pixels ${before} -> ${applied})`);
  } finally {
    client.close();
    await killAndWait(proc);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function testit(): Promise<void> {
  for (const engine of ["pdfium", "mupdf"]) {
    await runEngine(engine);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
