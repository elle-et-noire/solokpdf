import { writeFileSync } from "node:fs";
import { assemblePdf, runStandalone, tmpPath, USE_NG, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowPixels, getScrollInfo, sendMessage, sleep } from "./winapi.ts";
import { findSidebarTree, sidebarItemHeight } from "./sidebar-tree.ts";

const title =
  "A very long bookmark title that extends beyond the sidebar and should scroll horizontally to show its ending 11111111";

async function capture(showPageNumbers: boolean, wrap: boolean, text = title): Promise<Uint8Array> {
  const pdf = tmpPath("toc-native-scroll.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
      "<< /Type /Outlines /First 6 0 R /Last 7 0 R /Count 2 >>",
      "<< /Title (Selected) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>",
      `<< /Title (${text}) /Parent 5 0 R /Prev 6 0 R /F 2 /Dest [4 0 R /Fit] >>`,
    ]),
    "latin1",
  );
  const dir = writeAppdata(
    `toc-native-scroll-${showPageNumbers}-${wrap}`,
    `RestoreSession = false\nShowToc = true\nSidebarDx = 220\nScrollbars = windows\nShowTocPageNumbers = ${showPageNumbers}\nTocWrapText = ${wrap}\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    await sleep(300);
    const tree = findSidebarTree(frame, true);
    if (!tree) throw new Error("TOC tree missing");
    sendMessage(tree.hwnd, 0x114, 7, 0); // WM_HSCROLL, SB_RIGHT
    await sleep(200);
    const scroll = getScrollInfo(tree.hwnd, 0);
    if (!scroll || scroll.pos <= 0) throw new Error("TOC did not scroll horizontally");
    const img = captureWindowPixels(tree.hwnd);
    if (!img) throw new Error("TOC capture failed");
    const row = sidebarItemHeight(tree);
    return img.data.slice(img.w * row * 4, img.w * row * 2 * 4);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const expected = await capture(false, false);
  const changedEnding = await capture(false, false, title.slice(0, -1) + "8");
  if (changedEnding.length !== expected.length || changedEnding.every((v, i) => v === expected[i])) {
    throw new Error("TOC title ending is not visible at the right edge");
  }
  for (const [page, wrap] of [
    [true, false],
    [false, true],
  ] as const) {
    const actual = await capture(page, wrap);
    if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
      throw new Error(`TOC row differs with ShowTocPageNumbers=${page} TocWrapText=${wrap}`);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
