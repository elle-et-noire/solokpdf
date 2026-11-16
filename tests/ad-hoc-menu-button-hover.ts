// The ≡ menu button's hover must use the same theme hover color as the caption buttons beside
// it. It used a black/white alpha overlay that went lighter in Light while every other hovered
// control on the strip went darker.
import { makeTextPdf, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { killAndWait, launchControlled, moveTestCursor } from "./win-automation.ts";
import { captureWindowPixels, clientToScreen, packCoords, sendMessage, WM_MOUSELEAVE, WM_MOUSEMOVE } from "./winapi.ts";

const kThemes = ["Light", "Dark"];
// channels this close count as the same color
const kTolerance = 6;

type Rgb = [number, number, number];

function rgbHex(p: Rgb): string {
  return p.map((v) => v.toString(16).padStart(2, "0")).join("");
}

async function checkTheme(theme: string, pdf: string): Promise<void> {
  const dir = writeAppdata(`menu-button-hover-${theme}`, `Theme = ${theme}\n`);
  const s = await launchControlled(["-appdata", dir, pdf]);
  try {
    await s.client.request(ControlCommand.SetNotificationsEnabled, [0]);
    const caps = (await s.client.virtTree()).filter((c) => c.kind === "captionBtn" && c.rect.dx > 0);
    caps.sort((a, b) => a.rect.x - b.rect.x);
    // system menu, ≡ menu, minimize, maximize, close
    const menu = caps[caps.length - 4]!.rect;
    const maxBtn = caps[caps.length - 2]!.rect;

    // a pixel in the button's top-left corner, away from its glyph
    const hoverBg = async (r: { x: number; y: number; dx: number; dy: number }): Promise<Rgb> => {
      const x = r.x + Math.floor(r.dx / 2);
      const y = r.y + Math.floor(r.dy / 2);
      const p = clientToScreen(s.frame, x, y);
      await moveTestCursor(p.x, p.y, s.client);
      sendMessage(s.frame, WM_MOUSEMOVE, 0, packCoords(x, y));
      await Bun.sleep(150);
      const c = captureWindowPixels(s.frame, "client");
      if (!c) throw new Error("capture failed");
      const i = ((r.y + 2) * c.w + r.x + 2) * 4;
      sendMessage(s.frame, WM_MOUSELEAVE, 0, 0);
      return [c.data[i + 2]!, c.data[i + 1]!, c.data[i]!];
    };

    const menuHover = await hoverBg(menu);
    const maxHover = await hoverBg(maxBtn);
    console.log(`${theme}: menu hover ${rgbHex(menuHover)}, maximize hover ${rgbHex(maxHover)}`);
    if (menuHover.some((v, k) => Math.abs(v - maxHover[k]!) > kTolerance)) {
      throw new Error(`${theme}: menu hover ${rgbHex(menuHover)} differs from caption hover ${rgbHex(maxHover)}`);
    }
  } finally {
    await s.client.request(ControlCommand.Quit, []).catch(() => {});
    s.client.close();
    await killAndWait(s.proc);
  }
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("menu-button-hover.pdf");
  writeFileSync(pdf, makeTextPdf("menu button hover"));
  const errors: string[] = [];
  for (const theme of kThemes) {
    await checkTheme(theme, pdf).catch((e) => errors.push(e instanceof Error ? e.message : String(e)));
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
