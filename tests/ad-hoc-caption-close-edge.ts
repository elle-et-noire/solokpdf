// A hovered caption close button must fill red to the window's top and outer edges, like
// Windows 11. It stopped 1 px short of the top and 2 px short of the outer edge, and the
// border pixels must return to the strip color once the hover ends.
import { cmdId, makeTextPdf, runStandalone, tmpPath, waitForDpiFrame, writeAppdata } from "./util.ts";
import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { killAndWait, launchControlled, moveTestCursor, sendCommandSync } from "./win-automation.ts";
import {
  captureWindowPixels,
  captureWindowToPng,
  clientToScreen,
  packCoords,
  sendMessage,
  WM_MOUSELEAVE,
  WM_MOUSEMOVE,
} from "./winapi.ts";

type Rgb = [number, number, number];
type Session = Awaited<ReturnType<typeof launchControlled>>;

const kCloseRed: Rgb = [0xc4, 0x2b, 0x1c];
// channels this close count as the same color
const kTolerance = 6;
const kHighDpi = 144;
const kHoverPolls = 40;

function rgbHex(p: Rgb): string {
  return p.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function near(a: Rgb, b: Rgb): boolean {
  return a.every((v, k) => Math.abs(v - b[k]!) <= kTolerance);
}

// min/max/close are the tallest caption buttons; close is the outermost, at the left in RTL
async function closeRect(s: Session, rtl: boolean) {
  const caps = (await s.client.virtTree()).filter((c) => c.kind === "captionBtn" && c.rect.dx > 0);
  const sysDy = Math.max(...caps.map((c) => c.rect.dy));
  const sys = caps.filter((c) => c.rect.dy === sysDy).sort((a, b) => a.rect.x - b.rect.x);
  return (rtl ? sys[0] : sys[sys.length - 1])!.rect;
}

// Window-edge pixels next to the close button: top row above it and outer column beside it.
// PrintWindow draws an RTL window mirrored, so the button is at the capture's right edge there too.
function edgePixels(s: Session): { name: string; rgb: Rgb }[] {
  const c = captureWindowPixels(s.frame, "client");
  if (!c) throw new Error("capture failed");
  const px = (x: number, y: number): Rgb => {
    const i = (y * c.w + x) * 4;
    return [c.data[i + 2]!, c.data[i + 1]!, c.data[i]!];
  };
  const outerX = c.w - 1;
  const innerX = c.w - 10;
  return [
    { name: `(${outerX},0)`, rgb: px(outerX, 0) },
    { name: `(${outerX},10)`, rgb: px(outerX, 10) },
    { name: `(${innerX},0)`, rgb: px(innerX, 0) },
    // inside the button: proves the hover took
    { name: `(${innerX},10)`, rgb: px(innerX, 10) },
  ];
}

async function check(s: Session, label: string, rtl: boolean, errors: string[]): Promise<void> {
  const before = edgePixels(s);

  const r = await closeRect(s, rtl);
  const x = r.x + Math.floor(r.dx / 2);
  const y = r.y + Math.floor(r.dy / 2);
  // an RTL window's client coordinates are mirrored
  const cw = captureWindowPixels(s.frame, "client")!.w;
  const msgX = rtl ? cw - 1 - x : x;
  const p = clientToScreen(s.frame, msgX, y);
  await moveTestCursor(p.x, p.y, s.client);
  // poll until the frame has repainted the button's inside (the last pixel) hovered
  sendMessage(s.frame, WM_MOUSEMOVE, 0, packCoords(msgX, y));
  let hot = before;
  let attempt = 0;
  for (; attempt < kHoverPolls; attempt++) {
    hot = edgePixels(s);
    if (near(hot[hot.length - 1]!.rgb, kCloseRed)) break;
    await Bun.sleep(50);
  }
  console.log(`${label}: hover after ${attempt} polls`);
  captureWindowToPng(s.frame, tmpPath(`caption-close-edge-${label.replace(/[^a-z0-9]+/gi, "-")}.png`));

  // leave for the document, or moves at the test cursor hover the button again
  const away = clientToScreen(s.frame, Math.floor(cw / 2), r.y + r.dy * 4);
  await moveTestCursor(away.x, away.y, s.client);
  sendMessage(s.frame, WM_MOUSELEAVE, 0, 0);
  let after = before;
  for (let i = 0; i < kHoverPolls; i++) {
    after = edgePixels(s);
    if (!near(after[after.length - 1]!.rgb, kCloseRed)) break;
    await Bun.sleep(50);
  }

  const fmt = (v: { name: string; rgb: Rgb }[]) => v.map((e) => `${e.name}=${rgbHex(e.rgb)}`).join(" ");
  console.log(`${label}: before ${fmt(before)} | hot ${fmt(hot)} | after ${fmt(after)}`);
  for (let i = 0; i < hot.length; i++) {
    if (!near(hot[i]!.rgb, kCloseRed)) {
      errors.push(`${label}: hovered edge ${hot[i]!.name} is ${rgbHex(hot[i]!.rgb)}, want ${rgbHex(kCloseRed)}`);
    }
    if (!near(after[i]!.rgb, before[i]!.rgb)) {
      errors.push(`${label}: edge ${after[i]!.name} stays ${rgbHex(after[i]!.rgb)} after hover`);
    }
  }
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("caption-close-edge.pdf");
  writeFileSync(pdf, makeTextPdf("caption close edge"));
  const dir = writeAppdata("caption-close-edge", `Theme = Light\n`);
  const s = await launchControlled(["-appdata", dir, pdf]);
  const errors: string[] = [];
  try {
    await s.client.request(ControlCommand.SetNotificationsEnabled, [0]);
    await check(s, "system dpi", false, errors);

    // system -> 125% -> 150%
    sendCommandSync(s.frame, cmdId("CmdDebugToggleDpiOverride"));
    sendCommandSync(s.frame, cmdId("CmdDebugToggleDpiOverride"));
    await waitForDpiFrame(s.client, kHighDpi, () => true);
    await Bun.sleep(200);
    await check(s, "150%", false, errors);

    sendCommandSync(s.frame, cmdId("CmdDebugToggleRtl"));
    await Bun.sleep(200);
    await check(s, "150% rtl", true, errors);
  } finally {
    await s.client.request(ControlCommand.Quit, []).catch(() => {});
    s.client.close();
    await killAndWait(s.proc);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
