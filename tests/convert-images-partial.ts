import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlClient, ControlCommand } from "./control.ts";
import {
  cmdId,
  loadPng,
  makeTextPdf,
  makeTopBottomPdf,
  pollUntil,
  runStandalone,
  SETTINGS_FILE,
  tmpPath,
  USE_NG,
} from "./util.ts";
import { killAndWait, launchControlled, moveTestCursor, sendCommand, sendCommandSync } from "./win-automation.ts";
import {
  clientToScreen,
  enumChildWindows,
  enumWindows,
  getClassName,
  getControlText,
  getWindowPid,
  getWindowText,
  isWindowEnabled,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  postMessage,
  sendCopyDataW,
  sendMessage,
  sendText,
  WM_CLOSE,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
} from "./winapi.ts";

const title = "Convert to Images";
const warningClass = "#32770";
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function findWindow(pid: number, kind: "tool" | "warning"): number {
  let hwnd = 0;
  enumWindows((h) => {
    if (getWindowPid(h) !== pid || !isWindowVisible(h)) return true;
    if (
      kind === "warning"
        ? getClassName(h) === warningClass
        : getWindowText(h) === title && getClassName(h) !== warningClass
    ) {
      hwnd = h;
      return false;
    }
    return true;
  });
  return hwnd;
}

async function click(client: ControlClient, dlg: number, label: string): Promise<void> {
  const control = (await client.virtTree(getClassName(dlg))).find((row) => row.text === label);
  assert.ok(control, `Missing ${label} control`);
  const { x, y, dx, dy } = control.rect;
  const cx = x + Math.floor(dx / 2);
  const cy = y + Math.floor(dy / 2);
  const screen = clientToScreen(dlg, cx, cy);
  await moveTestCursor(screen.x, screen.y, client);
  const pt = packCoords(cx, cy);
  postMessage(dlg, WM_LBUTTONDOWN, MK_LBUTTON, pt);
  postMessage(dlg, WM_LBUTTONUP, 0, pt);
}

async function openExport(frame: number, pid: number, dir: string): Promise<number> {
  sendCommand(frame, cmdId("CmdConvertPdfToImages"));
  const dlg = await pollUntil(() => findWindow(pid, "tool"), Boolean, { error: `Missing ${title} dialog` });
  let dest = 0;
  enumChildWindows(dlg, (h) => {
    if (getClassName(h) === "Edit" && getControlText(h).includes("<N>")) {
      dest = h;
      return false;
    }
    return true;
  });
  assert.ok(dest, "Missing destination edit");
  sendText(dest, join(dir, "page-<N>.png"));
  return dlg;
}

function warningText(warning: number): string {
  const lines: string[] = [];
  enumChildWindows(warning, (h) => {
    if (getClassName(h) === "Static") lines.push(getControlText(h));
    return true;
  });
  return lines.join("\n");
}

async function checkExport(
  client: ControlClient,
  frame: number,
  pid: number,
  dir: string,
  blocked: number,
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const output = (page: number) => join(dir, `page-${page}.png`);
  for (let page = 1; page <= blocked; page++) {
    mkdirSync(output(page));
  }

  const dlg = await openExport(frame, pid, dir);
  await click(client, dlg, "Convert");

  const warning = await pollUntil(
    () => findWindow(pid, "warning"),
    (h) => h !== 0 || !isWindowVisible(dlg),
    { error: "Image export did not finish" },
  );
  if (blocked === 0) {
    assert.equal(warning, 0, "All pages saved but the dialog showed a warning");
  } else {
    assert.ok(warning, `Saving ${2 - blocked} of 2 images showed no warning`);
    const message = warningText(warning);
    assert.match(message, new RegExp(`Saved ${2 - blocked} of 2 images`));
    assert.match(message, new RegExp(`Failed pages: ${blocked === 1 ? "1" : "1-2"}\\b`));
    postMessage(warning, WM_CLOSE, 0, 0);
    await pollUntil(() => !isWindowVisible(warning), Boolean, { error: "Warning stayed open" });
  }

  for (let page = 1; page <= 2; page++) {
    if (page <= blocked) {
      assert.ok(statSync(output(page)).isDirectory());
    } else {
      assert.deepEqual(readFileSync(output(page)).subarray(0, pngSignature.length), pngSignature);
    }
  }
  if (blocked === 2) {
    assert.ok(isWindowVisible(dlg), "The dialog should stay open for retry when no images were saved");
    postMessage(dlg, WM_CLOSE, 0, 0);
  }
  await pollUntil(() => !isWindowVisible(dlg), Boolean, { error: "Conversion dialog stayed open" });
}

function openPdf(frame: number, path: string, reload = 0): void {
  const ddeCopyData = 0x44646557;
  assert.ok(sendCopyDataW(frame, ddeCopyData, `[Open("${path.replaceAll("\\", "/")}",0,0,${reload})]`));
}

async function checkCancel(client: ControlClient, frame: number, pid: number, dir: string): Promise<void> {
  mkdirSync(dir);
  const dlg = await openExport(frame, pid, dir);
  const [status] = await client.request(ControlCommand.TestCurrentPdf, ["park-render", 4000, "contents", 0, 2, "any"]);
  assert.equal(status, 0);
  const parkState = async () => String((await client.request(ControlCommand.TestCurrentPdf, ["park-state"]))[1]);
  await click(client, dlg, "Convert");
  await pollUntil(parkState, (s) => /\bparked=1\b/.test(s), { error: "Export did not park rendering page 2" });
  assert.equal(isWindowEnabled(frame), false, "Source editing must pause during the export");
  postMessage(dlg, WM_CLOSE, 0, 0);
  await pollUntil(() => !isWindowVisible(dlg) && isWindowEnabled(frame), Boolean, {
    error: "Cancel did not close the dialog and restore the source controls",
  });
  assert.match(await parkState(), /\bparked=1\b/, "The dialog must close while rendering is still parked");
  await pollUntil(parkState, (s) => /\bparked=0\b/.test(s), { error: "Parked render did not release" });
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".png")),
    ["page-1.png"],
  );
}

async function checkSource(
  app: Awaited<ReturnType<typeof launchControlled>>,
  pdf: string,
  other: string,
  dir: string,
): Promise<void> {
  const { client, frame, proc } = app;
  const pid = proc.pid;
  const reference = loadPng(join(dir, "reference", "page-2.png"));
  sendCommandSync(frame, cmdId("CmdGoToNextPage"));
  assert.match(String((await client.request(ControlCommand.TestCurrentTab))[1]), /page=2$/);
  const switched = join(dir, "switched");
  mkdirSync(switched);
  let dlg = await openExport(frame, pid, switched);
  openPdf(frame, other);
  await client.waitForRenderIdle();
  assert.match(String((await client.request(ControlCommand.TestCurrentTab))[1]), /other\.pdf page=1$/);
  sendCommandSync(frame, cmdId("CmdRotateRight"));
  let current = 0;
  enumChildWindows(dlg, (h) => {
    if (getClassName(h) === "Button" && getControlText(h) === "Current") current = h;
    return !current;
  });
  assert.ok(current, "Missing Current radio button");
  const BM_CLICK = 0x00f5;
  sendMessage(current, BM_CLICK, 0, 0);
  const BM_GETCHECK = 0x00f0;
  assert.equal(sendMessage(current, BM_GETCHECK, 0, 0), 1n, "Current radio button did not select");
  await click(client, dlg, "Convert");
  await pollUntil(() => !isWindowVisible(dlg), Boolean, { error: "Switched export did not close" });
  assert.deepEqual(readdirSync(switched), ["page-2.png"], "Current page must come from the source tab");
  const exported = loadPng(join(switched, "page-2.png"));
  assert.deepEqual([exported.w, exported.h], [reference.w, reference.h], "Source rotation changed");
  for (let i = 0; i < reference.w * reference.h; i++) {
    const a = i * reference.nComp;
    const b = i * exported.nComp;
    const expected = reference.data;
    const actual = exported.data;
    const expectedAlpha = reference.nComp === 4 ? expected[a + 3] : 255;
    const actualAlpha = exported.nComp === 4 ? actual[b + 3] : 255;
    if (
      expected[a] !== actual[b] ||
      expected[a + 1] !== actual[b + 1] ||
      expected[a + 2] !== actual[b + 2] ||
      expectedAlpha !== actualAlpha
    ) {
      throw new Error(`Source image differs at pixel ${i}`);
    }
  }
  assert.match(String((await client.request(ControlCommand.TestCurrentTab))[1]), /other\.pdf page=1$/);

  for (const mode of ["reload", "close", "reopen", "duplicate"]) {
    openPdf(frame, pdf);
    await client.waitForRenderIdle();
    const dest = join(dir, mode);
    mkdirSync(dest);
    dlg = await openExport(frame, pid, dest);
    if (mode === "reload") {
      writeFileSync(pdf, makeTextPdf("RELOADED_SOURCE"));
      openPdf(frame, pdf, 1);
      const [, text] = await client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
      assert.match(String(text), /RELOADED_SOURCE/);
    } else if (mode === "duplicate") {
      const source = await client.selectTab();
      sendCommandSync(frame, cmdId("CmdDuplicateInNewTab"));
      await client.waitForRenderIdle();
      const duplicate = await client.selectTab();
      assert.equal(duplicate.count, source.count + 1);
      assert.ok(duplicate.idx > source.idx, "Duplicate should follow the source tab");
      await client.selectTab(source.idx);
      sendCommandSync(frame, cmdId("CmdClose"));
      await client.selectTab(duplicate.idx - 1);
      assert.equal((await client.selectTab()).count, source.count);
      assert.match(String((await client.request(ControlCommand.TestCurrentTab))[1]), /pages\.pdf page=1$/);
    } else {
      sendCommandSync(frame, cmdId("CmdClose"));
      assert.match(String((await client.request(ControlCommand.TestCurrentTab))[1]), /other\.pdf page=1$/);
      if (mode === "reopen") {
        openPdf(frame, pdf);
        await client.waitForRenderIdle();
      }
    }
    assert.ok(isWindowVisible(dlg), `${mode} closed the conversion dialog`);
    await click(client, dlg, "Convert");
    const warning = await pollUntil(
      () => findWindow(pid, "warning"),
      (h) => h !== 0 || !isWindowVisible(dlg),
      { error: `${mode}: conversion did not finish` },
    );
    assert.ok(warning, `${mode}: conversion used a stale source without warning`);
    assert.match(warningText(warning), /source document changed or was closed/i);
    assert.deepEqual(readdirSync(dest), [], `${mode}: conversion wrote an image`);
    postMessage(warning, WM_CLOSE, 0, 0);
    postMessage(dlg, WM_CLOSE, 0, 0);
    await pollUntil(() => !isWindowVisible(dlg), Boolean, { error: "Conversion dialog stayed open" });
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = mkdtempSync(tmpPath("convert-images-partial-"));
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\n");
  for (const engine of ["mupdf", "pdfium"]) {
    const engineDir = join(dir, engine);
    mkdirSync(engineDir);
    const pdf = join(engineDir, "pages.pdf");
    const other = join(engineDir, "other.pdf");
    writeFileSync(pdf, makeTopBottomPdf(2));
    writeFileSync(other, makeTextPdf("OTHER_DOCUMENT"));
    const app = await launchControlled(["-appdata", dir, pdf], {
      env: { SOLOKPDF_ENGINE: engine },
    });
    const { proc, client, frame } = app;
    try {
      await client.waitForRenderIdle();
      const [status, pdfInfo] = await client.request(ControlCommand.TestCurrentPdf);
      const kind = engine === "pdfium" ? "enginePdfium" : "enginePdf";
      assert.equal(status, 0);
      assert.ok(String(pdfInfo).startsWith(`engine=${kind} `), `Unexpected engine: ${pdfInfo}`);
      for (const blocked of [0, 1, 2]) {
        const name = blocked === 0 ? "reference" : `blocked-${blocked}`;
        await checkExport(client, frame, proc.pid, join(engineDir, name), blocked);
      }
      await checkCancel(client, frame, proc.pid, join(engineDir, "canceled"));
      await checkSource(app, pdf, other, engineDir);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
  console.log("convert-images-partial: OK");
}

if (import.meta.main) {
  await runStandalone(testit);
}
