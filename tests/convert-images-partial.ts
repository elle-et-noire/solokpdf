import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlClient, ControlCommand } from "./control.ts";
import { makeTwoPagePdf } from "./issue-5991.ts";
import { cmdId, pollUntil, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, moveTestCursor, sendCommand } from "./win-automation.ts";
import {
  clientToScreen,
  enumChildWindows,
  enumWindows,
  getClassName,
  getControlText,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  postMessage,
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
    if (getWindowPid(h) === pid && isWindowVisible(h) && getWindowText(h) === title) {
      if ((getClassName(h) === warningClass) === (kind === "warning")) {
        hwnd = h;
        return false;
      }
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
    const lines: string[] = [];
    enumChildWindows(warning, (h) => {
      if (getClassName(h) === "Static") lines.push(getControlText(h));
      return true;
    });
    const message = lines.join("\n");
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

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = mkdtempSync(tmpPath("convert-images-partial-"));
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\n");
  const pdf = join(dir, "pages.pdf");
  writeFileSync(pdf, makeTwoPagePdf());
  for (const engine of ["mupdf", "pdfium"]) {
    const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
      env: { SOLOKPDF_ENGINE: engine },
    });
    try {
      await client.waitForRenderIdle();
      const [status, pdfInfo] = await client.request(ControlCommand.TestCurrentPdf);
      const kind = engine === "pdfium" ? "enginePdfium" : "enginePdf";
      assert.equal(status, 0);
      assert.ok(String(pdfInfo).startsWith(`engine=${kind} `), `Unexpected engine: ${pdfInfo}`);
      for (const blocked of [0, 1, 2]) {
        await checkExport(client, frame, proc.pid, join(dir, `${engine}-${blocked}`), blocked);
      }
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
