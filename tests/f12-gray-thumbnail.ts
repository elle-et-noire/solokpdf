// An F12 thumbnail of a page with only gray pixels must show its text. The
// PDFium engine returns such a page as an 8-bit gray DIB, which the GDI+
// painter skipped, leaving a blank page (e.g. black text in the Light theme).
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/f12-gray-thumbnail.ts [--no-build]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, cmdId, loadPng, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { captureWindowToPng, setProcessDpiAware, sleep } from "./winapi.ts";

// black text, nothing else: every rendered pixel is gray
function grayPdf(): string {
  let content = "BT /F1 36 Tf 50 740 Td 40 TL\n";
  for (let i = 0; i < 16; i++) content += "(Gray page text line) Tj T*\n";
  content += "ET\n";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath("f12-gray-thumbnail");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "gray.pdf");
  writeFileSync(pdf, grayPdf(), "latin1");
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nTheme = Light\nDocumentColorsFollowTheme = off\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    let raw = "";
    for (let i = 0; i < 80; i++) {
      raw = String((await client.request(ControlCommand.TestSidebarThumbnails, []))[1] ?? "");
      if (/rendered=[1-9]/.test(raw)) break;
      await sleep(50);
    }
    const hwnd = /hwnd=(\d+)/.exec(raw);
    const rect = /rects=1:(\d+),(\d+),(\d+),(\d+);/.exec(raw);
    if (!hwnd || !rect || !/rendered=[1-9]/.test(raw)) throw new Error(`F12 thumbnail missing: ${raw}`);
    // let the rendered thumbnail paint
    await sleep(200);

    const path = join(dir, "f12.png");
    if (!captureWindowToPng(Number(hwnd[1]), path)) throw new Error("F12 capture failed");
    const img = loadPng(path);
    const [x, y, dx, dy] = rect.slice(1).map(Number) as [number, number, number, number];
    // the top 60%: the page number label sits at the bottom
    let ink = 0;
    for (let py = y + 2; py < y + Math.floor(dy * 0.6); py++) {
      for (let px = x + 2; px < x + dx - 2; px++) {
        const p = (py * img.w + px) * img.nComp;
        if (img.data[p]! + img.data[p + 1]! + img.data[p + 2]! < 3 * 128) ink++;
      }
    }
    console.log(`f12-gray-thumbnail: ink=${ink} in ${dx}x${dy}`);
    if (ink < 100) throw new Error(`gray page thumbnail drew no text (ink=${ink}); see ${path}`);
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
