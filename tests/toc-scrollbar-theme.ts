import { findSidebarTree } from "./sidebar-tree";
import { writeFileSync } from "node:fs";
import { assemblePdf, cmdId, runStandalone, tmpPath, USE_NG, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { captureWindowDCRegionPixels, getScrollInfo, getWindowRect, sendMessage, sleep } from "./winapi.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const titles = Array.from(
    { length: 60 },
    (_, i) => `Bookmark ${i} with a very long title extending beyond the sidebar width`,
  );
  const first = 5;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    `<< /Type /Outlines /First ${first} 0 R /Last ${first + titles.length - 1} 0 R /Count ${titles.length} >>`,
    ...titles.map(
      (title, i) =>
        `<< /Title (${title}) /Parent 4 0 R ${i ? `/Prev ${first + i - 1} 0 R` : ""} ${i + 1 < titles.length ? `/Next ${first + i + 1} 0 R` : ""} /Dest [3 0 R /Fit] >>`,
    ),
  ];
  const pdf = tmpPath("toc-scrollbar-theme.pdf");
  writeFileSync(pdf, assemblePdf(objects), "latin1");
  const appdata = writeAppdata(
    "toc-scrollbar-theme",
    "RestoreSession = false\nShowToc = true\nSidebarDx = 220\nScrollbars = windows\nTheme = Bar Test\nThemes [\n [\n Name = Bar Test\n TextColor = #ffffff\n BackgroundColor = #222222\n ControlBackgroundColor = #222222\n ScrollbarColor = #a13377\n ScrollbarThumbColor = #34be56\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    await sleep(500);
    const tree = findSidebarTree(frame, true)?.hwnd ?? 0;
    if (!tree) throw new Error("TOC tree missing");
    function checkColors(): void {
      const r = getWindowRect(tree);
      const w = r.right - r.left;
      const h = r.bottom - r.top;
      const pixels = captureWindowDCRegionPixels(tree, 0, 0, w, h);
      if (!pixels) throw new Error("TOC capture failed");
      for (const [name, x0, y0, x1, y1] of [
        ["horizontal", 0, h - 18, w - 18, h],
        ["vertical", w - 18, 0, w, h - 18],
      ] as const) {
        let track = 0;
        let thumb = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (pixels[i] === 0x77 && pixels[i + 1] === 0x33 && pixels[i + 2] === 0xa1) track++;
            if (pixels[i] === 0x56 && pixels[i + 1] === 0xbe && pixels[i + 2] === 0x34) thumb++;
          }
        if (track >= 20 || thumb >= 5)
          throw new Error(`${name} scrollbar was painted with the custom theme: track=${track}, thumb=${thumb}`);
      }
    }
    checkColors();
    sendMessage(tree, 0x114, 7, 0); // WM_HSCROLL, SB_RIGHT
    sendMessage(tree, 0x115, 7, 0); // WM_VSCROLL, SB_BOTTOM
    await sleep(200);
    if (!getScrollInfo(tree, 0)?.pos || !getScrollInfo(tree, 1)?.pos) throw new Error("tree did not scroll");
    checkColors();
    sendCommandSync(frame, cmdId("CmdNextTheme"));
    await sleep(200);
    sendCommandSync(frame, cmdId("CmdPrevTheme"));
    await sleep(200);
    checkColors();
  } finally {
    client.close();
    await killAndWait(proc);
  }
}
if (import.meta.main) await runStandalone(testit);
