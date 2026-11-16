import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlClient, ControlCommand } from "./control.ts";
import { cmdId, contrastRatio, makePdf, runStandalone, selectionLookError, tmpPath, writeAppdata } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import {
  captureWindowDCToPng,
  captureWindowPixels,
  captureWindowToPng,
  sendCopyDataW,
  setProcessDpiAware,
  sleep,
} from "./winapi.ts";

const DDE_COPYDATA_ID = 0x44646557;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`selection-outlines: ${what}`);
}

type PageLook = {
  raw: string;
  pageX: number;
  pageY: number;
  pageDx: number;
  w: number;
  bg: number[];
  column: number[][];
};

// the sidebar column above the first (current) page's middle, from 12 px above it
async function currentPageLook(client: ControlClient): Promise<PageLook> {
  let raw = "";
  let match: RegExpExecArray | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await client.request(ControlCommand.TestSidebarThumbnails, []);
    raw = String(res[1] ?? "");
    match = /hwnd=(\d+) thumbnails=1 count=\d+ current=1.* rects=1:(-?\d+),(-?\d+),(\d+),(\d+)/.exec(raw);
    if (res[0] === 0 && match && /rendered=[1-9]/.test(raw)) break;
    await sleep(50);
  }
  check(!!match, `no first thumbnail: ${raw}`);
  const [hwnd, pageX, pageY, pageDx] = [1, 2, 3, 4].map((i) => Number(match![i]));
  const cap = captureWindowPixels(hwnd!);
  check(!!cap, "capture failed");
  check(pageY! >= 12 && pageY! < cap!.h, `outline outside sidebar: ${raw}`);
  const x = pageX! + Math.floor(pageDx! / 2);
  const column: number[][] = [];
  for (let y = pageY! - 12; y < pageY!; y++) {
    const offset = (y * cap!.w + x) * 4;
    column.push([cap!.data[offset + 2]!, cap!.data[offset + 1]!, cap!.data[offset]!]);
  }
  return { raw, pageX: pageX!, pageY: pageY!, pageDx: pageDx!, w: cap!.w, bg: column[0]!, column };
}

// The current page has room for its outline at the sidebar's edge and, from
// its frame up, the selection fill, a same-hue outline at 3:1 and the
// sidebar (E94).
async function checkCurrentPage(client: ControlClient, theme: string): Promise<void> {
  const look = await currentPageLook(client);
  check(
    look.pageX >= 6 && look.pageX + look.pageDx + 6 <= look.w,
    `${theme}: page outline clipped at sidebar edge: ${look.raw}`,
  );
  const fill = look.column[look.column.length - 1]!;
  let edge = fill;
  for (const c of look.column) {
    if (contrastRatio(c, look.bg) > contrastRatio(edge, look.bg)) edge = c;
  }
  const err = selectionLookError(look.bg, fill, edge);
  check(err === "", `${theme}: ${err}`);
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const pdf = tmpPath("selection-outlines.pdf");
  writeFileSync(pdf, makePdf(3, 400, 0, 0), "latin1");
  const appdata = writeAppdata("selection-outlines", "Theme = Light\nShowToc = false\nNoHomeTab = true\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    await checkCurrentPage(client, "Light");
    // the sidebar's background before the switch, to see the theme change
    const light = await currentPageLook(client);
    sendCommandSync(frame, cmdId("CmdToggleLightDarkTheme"));
    const deadline = Date.now() + 3000;
    while ((await currentPageLook(client)).bg.join() === light.bg.join() && Date.now() < deadline) await sleep(50);
    await checkCurrentPage(client, "Dark");
  } finally {
    await killAndWait(proc);
  }
}

export async function captureShots(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath("selection-outlines-shots");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "pages.pdf");
  writeFileSync(pdf, makePdf(3, 400, 0, 0), "latin1");
  for (const theme of ["Light", "Dark"]) {
    const appdata = writeAppdata(
      `selection-outlines-${theme}`,
      `Theme = ${theme}\nShowToc = false\nNoHomeTab = true\nRememberOpenedFiles = true\n` +
        `HomePageViewMode = thumbnails\nFileStates [\n\t[\n\t\tFilePath = ${pdf}\n\t\tOpenCount = 1\n\t]\n]\n`,
    );
    const { proc, client, frame } = await launchControlled(["-appdata", appdata]);
    try {
      const canvas = findCanvas(frame);
      check(!!canvas, "Home canvas missing");
      for (const mode of ["list", "thumbnails"] as const) {
        let home = await client.homeSelection(mode);
        for (let attempt = 0; attempt < 30 && (!home.ready || home.entries !== 1); attempt++) {
          await sleep(50);
          home = await client.homeSelection(mode);
        }
        check(home.ready && home.entries === 1, `Home ${mode} missing: ${home.raw}`);
        check(captureWindowToPng(canvas, join(dir, `${theme}-home-${mode}.png`)), `Home ${mode} capture failed`);
      }
      check(sendCopyDataW(frame, DDE_COPYDATA_ID, `[Open("${pdf}", 0, 1, 0)]`), "document open failed");
      await client.waitForRenderIdle();
      sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
      const res = await client.request(ControlCommand.TestSidebarThumbnails, []);
      const match = /hwnd=(\d+) thumbnails=1/.exec(String(res[1] ?? ""));
      check(!!match, `sidebar missing: ${res[1]}`);
      check(captureWindowToPng(Number(match![1]), join(dir, `${theme}-f12.png`)), "F12 capture failed");
      sendCommandSync(frame, cmdId("CmdDebugToggleRtl"));
      await sleep(100);
      const rtlRes = await client.request(ControlCommand.TestSidebarThumbnails, []);
      const rtlMatch = /hwnd=(\d+) thumbnails=1/.exec(String(rtlRes[1] ?? ""));
      check(!!rtlMatch, `RTL sidebar missing: ${rtlRes[1]}`);
      check(captureWindowDCToPng(Number(rtlMatch![1]), join(dir, `${theme}-f12-rtl.png`)), "RTL F12 capture failed");
    } finally {
      await killAndWait(proc);
    }
  }
  console.log(dir);
}

if (import.meta.main) {
  if (process.argv.includes("--screenshots")) {
    await captureShots();
  } else {
    await runStandalone(testit);
  }
}
