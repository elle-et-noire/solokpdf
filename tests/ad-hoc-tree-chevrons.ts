// Virtual bookmark tree expanders must be chevrons, as upstream's Explorer-themed TreeView
// draws them ('>' collapsed, 'v' expanded), not the text '+' / '-' (E85).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import {
  captureWindowPixels,
  captureWindowToPng,
  findChildWindow,
  sendMessage,
  sleep,
  VK_RIGHT,
  WM_KEYDOWN,
} from "./winapi.ts";

const TEST_STATE = 0x8000 + 102;
const kRows = 0;
const kRowDy = 3;
const kSetDpi = 9;
const kSelectRow = 14;
const kDpis = [96, 192];
const kThemes = ["Light", "Dark"];
// a channel this far from the row background is glyph ink
const kInkDelta = 40;
const kCollapsedRow = 1;
const kExpandedRow = 2;
const kTextGap = 3;
// px the chevron's arms must stand off its tip
const kShapeMargin = 1;

type Ink = { xs: number[]; ys: number[] };

function cellInk(tree: number, row: number, rowDy: number): Ink {
  const c = captureWindowPixels(tree, "client");
  if (!c) throw new Error("tree capture failed");
  const px = (x: number, y: number) => {
    const i = (y * c.w + x) * 4;
    return [c.data[i + 2]!, c.data[i + 1]!, c.data[i]!];
  };
  const y0 = row * rowDy;
  const bg = px(1, y0 + 1);
  const ink: Ink = { xs: [], ys: [] };
  for (let y = y0; y < y0 + rowDy; y++) {
    // stop short of the text's ClearType fringe
    for (let x = 0; x < rowDy - kTextGap; x++) {
      const p = px(x, y);
      if (p.some((v, k) => Math.abs(v - bg[k]!) > kInkDelta)) {
        ink.xs.push(x);
        ink.ys.push(y - y0);
      }
    }
  }
  return ink;
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

// '>': ink in the top quarter of the glyph sits left of ink in its middle rows; '+' lines up
function isRightChevron(ink: Ink): boolean {
  if (ink.xs.length === 0) return false;
  const [y0, y1] = [Math.min(...ink.ys), Math.max(...ink.ys)];
  const q = (y1 - y0) / 4;
  const top = ink.xs.filter((_, i) => ink.ys[i]! <= y0 + q);
  const mid = ink.xs.filter((_, i) => Math.abs(ink.ys[i]! - (y0 + y1) / 2) <= q / 2);
  return y1 - y0 >= 4 && mean(top) < mean(mid) - kShapeMargin;
}

// 'v': ink in the left quarter of the glyph sits above ink in its middle columns; '-' is flat
function isDownChevron(ink: Ink): boolean {
  if (ink.xs.length === 0) return false;
  const [x0, x1] = [Math.min(...ink.xs), Math.max(...ink.xs)];
  const q = (x1 - x0) / 4;
  const left = ink.ys.filter((_, i) => ink.xs[i]! <= x0 + q);
  const mid = ink.ys.filter((_, i) => Math.abs(ink.xs[i]! - (x0 + x1) / 2) <= q / 2);
  return mean(left) < mean(mid) - kShapeMargin;
}

async function checkTheme(theme: string, pdf: string, errors: string[]): Promise<void> {
  const appdata = tmpPath(`tree-chevrons-${theme}`);
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), `Theme = ${theme}\nShowToc = true\nShowFavorites = false\n`);
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    let tree = 0;
    const deadline = Date.now() + 10000;
    while (!tree && Date.now() < deadline) {
      tree = findChildWindow(frame, "SumatraVirtualBookmarksTree");
      if (!tree) await sleep(50);
    }
    if (!tree) throw new Error("virtual TOC host unavailable");
    const state = (field: number, value = 0) => Number(sendMessage(tree, TEST_STATE, field, value));
    // expand "Open" from the keyboard; it stays selected, so the selected row is checked too
    state(kSelectRow, kExpandedRow);
    sendMessage(tree, WM_KEYDOWN, VK_RIGHT, 0);
    await sleep(100);
    if (state(kRows) !== 4) throw new Error(`${theme}: want 4 TOC rows, got ${state(kRows)}`);

    for (const dpi of kDpis) {
      state(kSetDpi, dpi);
      await sleep(150);
      const rowDy = state(kRowDy);
      const label = `${theme} ${Math.round((dpi * 100) / 96)}%`;
      captureWindowToPng(tree, tmpPath(`tree-chevrons-${theme}-${dpi}.png`));
      const collapsed = cellInk(tree, kCollapsedRow, rowDy);
      const expanded = cellInk(tree, kExpandedRow, rowDy);
      console.log(`${label}: rowDy ${rowDy}, ink ${collapsed.xs.length} / ${expanded.xs.length} px`);
      if (!isRightChevron(collapsed)) errors.push(`${label}: collapsed expander is not '>'`);
      if (!isDownChevron(expanded)) errors.push(`${label}: expanded expander is not 'v'`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("tree-chevrons.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R /PageMode /UseOutlines >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 4 >>",
      "<< /Title (Leaf) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>",
      "<< /Title (Closed) /Parent 5 0 R /Prev 6 0 R /Next 8 0 R /First 9 0 R /Last 9 0 R /Count -1 /Dest [3 0 R /Fit] >>",
      "<< /Title (Open) /Parent 5 0 R /Prev 7 0 R /First 10 0 R /Last 10 0 R /Count 1 /Dest [4 0 R /Fit] >>",
      "<< /Title (Hidden child) /Parent 7 0 R /Dest [4 0 R /Fit] >>",
      "<< /Title (Shown child) /Parent 8 0 R /Dest [4 0 R /Fit] >>",
    ]),
  );
  const errors: string[] = [];
  for (const theme of kThemes) {
    await checkTheme(theme, pdf, errors).catch((e) => errors.push(e instanceof Error ? e.message : String(e)));
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
