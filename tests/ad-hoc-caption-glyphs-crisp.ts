// Caption minimize / maximize / restore glyphs must sit on the pixel grid: every pixel of the
// glyph box is either background or full ink, at 100/150/200%. The stroke is max(1, round(dpi/96)).
import { ControlCommand } from "./control.ts";
import { makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import { writeFileSync } from "node:fs";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { captureWindowPixels, sendMessage, WM_SYSCOMMAND } from "./winapi.ts";

const kScales = [100, 150, 200];
const kGlyphDip = 10;
const SC_MAXIMIZE = 0xf030;
// a channel this close to the background or the ink counts as that color
const kTolerance = 24;

type Cap = { w: number; h: number; data: Uint8Array };
type Box = { x: number; y: number; dx: number; dy: number };

function gray(c: Cap, x: number, y: number): number {
  const i = (y * c.w + x) * 4;
  return Math.round((c.data[i]! + c.data[i + 1]! + c.data[i + 2]!) / 3);
}

// Checks the glyph box centered in a caption button: every pixel is background or ink.
function checkGlyph(c: Cap, btn: Box, glyphPx: number, name: string): { msg: string; ink: number } {
  const bg = gray(c, btn.x + 1, btn.y + 1);
  const x0 = btn.x + Math.floor((btn.dx - glyphPx) / 2) - 1;
  const y0 = btn.y + Math.floor((btn.dy - glyphPx) / 2) - 1;
  const n = glyphPx + 2;
  let ink = bg;
  for (let y = y0; y < y0 + n; y++) {
    for (let x = x0; x < x0 + n; x++) {
      const v = gray(c, x, y);
      if (Math.abs(v - bg) > Math.abs(ink - bg)) ink = v;
    }
  }
  if (Math.abs(ink - bg) < 40) throw new Error(`${name}: no visible glyph (bg ${bg}, ink ${ink})`);

  let blurred = 0;
  let minX = 1e9,
    maxX = -1,
    minY = 1e9,
    maxY = -1;
  const rows: string[] = [];
  for (let y = y0; y < y0 + n; y++) {
    let row = "";
    for (let x = x0; x < x0 + n; x++) {
      const v = gray(c, x, y);
      const isInk = Math.abs(v - ink) <= kTolerance;
      const isBg = Math.abs(v - bg) <= kTolerance;
      if (!isInk && !isBg) blurred++;
      if (!isBg) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      row += isInk ? "#" : isBg ? "." : "+";
    }
    rows.push(row);
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (blurred > 0) throw new Error(`${name}: ${blurred} half-covered pixels\n${rows.join("\n")}`);
  const stroke = Math.max(1, Math.round(glyphPx / kGlyphDip));
  if (name === "minimize" && (w !== glyphPx || h !== stroke)) {
    throw new Error(`${name}: ${w}x${h}, want ${glyphPx}x${stroke}`);
  }
  return { msg: `${name} ${w}x${h} bg ${bg} ink ${ink}`, ink };
}

async function checkScale(pct: number, pdf: string): Promise<void> {
  const s = await launchControlled([pdf], { env: { SUMATRA_DPI_OVERRIDE: String(pct) } });
  try {
    await s.client.request(ControlCommand.SetNotificationsEnabled, [0]);
    const glyphPx = Math.round((kGlyphDip * pct) / 100);
    const sysButtons = async () => {
      const caps = (await s.client.virtTree()).filter((c) => c.kind === "captionBtn" && c.rect.dx > 0);
      caps.sort((a, b) => a.rect.x - b.rect.x);
      // the three rightmost: minimize, maximize or restore, close
      return caps.slice(-3);
    };
    const shot = () => {
      const c = captureWindowPixels(s.frame, "client");
      if (!c) throw new Error("capture failed");
      return c;
    };

    const out: string[] = [];
    let inks: number[] = [];
    const errors: string[] = [];
    // glyphs in one capture share a color (maximizing may deactivate the window);
    // a glyph whose darkest pixel misses it has no full-ink pixel
    const checkInks = () => {
      const full = inks.reduce((a, v) => (v < a ? v : a), 255);
      if (inks.some((v) => Math.abs(v - full) > kTolerance)) errors.push(`glyph inks differ: ${inks.join(", ")}`);
      inks = [];
    };
    const check = (c: Cap, btn: Box, name: string) => {
      try {
        const r = checkGlyph(c, btn, glyphPx, name);
        out.push(r.msg);
        inks.push(r.ink);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    };
    let btns = await sysButtons();
    let c = shot();
    check(c, btns[0]!.rect, "minimize");
    check(c, btns[1]!.rect, "maximize");
    checkInks();

    sendMessage(s.frame, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
    await Bun.sleep(300);
    btns = await sysButtons();
    c = shot();
    check(c, btns[0]!.rect, "minimize");
    check(c, btns[1]!.rect, "restore");
    checkInks();
    console.log(`${pct}%: ${out.join(", ")}`);
    if (errors.length > 0) throw new Error(errors.join("\n"));
  } finally {
    await s.client.request(ControlCommand.Quit, []).catch(() => {});
    s.client.close();
    await killAndWait(s.proc);
  }
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("caption-glyphs-crisp.pdf");
  writeFileSync(pdf, makeTextPdf("caption glyphs"));
  const errors: string[] = [];
  for (const pct of kScales) {
    await checkScale(pct, pdf).catch((e) => errors.push(`${pct}%: ${e instanceof Error ? e.message : e}`));
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
