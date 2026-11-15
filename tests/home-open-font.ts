// The home page's "Open..." link must be drawn the same at startup as after a
// full relayout (switching the view mode). The cached-layout path used a larger
// font than LayoutHomePage(), so the link showed oversized until a view switch.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/home-open-font.ts [--no-build]
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlClient } from "./control";
import { ROOT, SETTINGS_FILE, loadPng, runStandalone, tmpPath, type PngImage } from "./util";
import { findCanvas, killAndWait, launchControlled } from "./win-automation";
import { captureWindowToPng, setProcessDpiAware, sleep } from "./winapi";

const SETTINGS = `UiLanguage = en
CheckForUpdates = false
RestoreSession = false
RememberOpenedFiles = true
ShowStartPage = true
NoHomeTab = false
HomePageViewMode = thumbnails
`;

type Box = { x: number; y: number; dx: number; dy: number };

// bounding box of pixels that differ from the region's top-left (background) pixel
function inkBox(img: PngImage, r: number[]): Box {
  const [rx, ry, rdx, rdy] = r as [number, number, number, number];
  const at = (x: number, y: number) => (y * img.w + x) * img.nComp;
  const bg = at(rx, ry);
  let x0 = img.w;
  let y0 = img.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = ry; y < ry + rdy; y++) {
    for (let x = rx; x < rx + rdx; x++) {
      const p = at(x, y);
      let diff = 0;
      for (let c = 0; c < 3; c++) diff += Math.abs(img.data[p + c]! - img.data[bg + c]!);
      if (diff < 96) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? { x: 0, y: 0, dx: 0, dy: 0 } : { x: x0, y: y0, dx: x1 - x0 + 1, dy: y1 - y0 + 1 };
}

async function openLinkInk(client: ControlClient, canvas: number, path: string): Promise<Box> {
  const home = await client.homeSelection();
  if (!home.ready) throw new Error(`home page not ready: ${home.raw}`);
  // repaint through the cached layout, as any later paint does
  await sleep(300);
  if (!captureWindowToPng(canvas, path)) throw new Error(`capture failed: ${path}`);
  const [x, y, dx, dy] = home.open as [number, number, number, number];
  // a few px of slack: an oversized font overflows the measured text rect
  const pad = 6;
  return inkBox(loadPng(path), [x, y - pad, dx + pad * 3, dy + pad * 2]);
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath("home-open-font");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const doc = join(dir, "a.pdf");
  copyFileSync(join(ROOT, "ext", "a-zlib", "zlib.3.pdf"), doc);
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `${SETTINGS}FileStates [\n\t[\n\t\tFilePath = ${doc}\n\t\tOpenCount = 1\n\t]\n]\n`,
  );

  const { proc, client, frame } = await launchControlled(["-appdata", dir]);
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForHomePainted();
    const canvas = findCanvas(frame);
    const before = await openLinkInk(client, canvas, join(dir, "startup.png"));

    await client.homeSelection("list");
    await client.homeSelection("thumbnails");
    const after = await openLinkInk(client, canvas, join(dir, "relayout.png"));

    console.log(`home-open-font: startup=${JSON.stringify(before)} relayout=${JSON.stringify(after)}`);
    if (after.dx === 0) throw new Error("Open link not drawn");
    if (before.dx !== after.dx || before.dy !== after.dy) {
      throw new Error(`Open link size differs: startup ${before.dx}x${before.dy}, relayout ${after.dx}x${after.dy}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
  console.log("home-open-font: OK");
}

if (import.meta.main) await runStandalone(testit);
