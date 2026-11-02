import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { cmdId, makePdf, runStandalone, tmpPath, writeAppdata } from "./util.ts";
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
    let res = await client.request(ControlCommand.TestSidebarThumbnails, []);
    let raw = String(res[1] ?? "");
    let match = /hwnd=(\d+) thumbnails=1 count=\d+ current=1.* rects=1:(-?\d+),(-?\d+),(\d+),(\d+)/.exec(raw);
    for (let attempt = 0; attempt < 30 && !/rendered=[1-9]/.test(raw); attempt++) {
      await sleep(50);
      res = await client.request(ControlCommand.TestSidebarThumbnails, []);
      raw = String(res[1] ?? "");
      match = /hwnd=(\d+) thumbnails=1 count=\d+ current=1.* rects=1:(-?\d+),(-?\d+),(\d+),(\d+)/.exec(raw);
    }
    check(res[0] === 0 && !!match, `no first thumbnail: ${raw}`);
    const hwnd = Number(match![1]);
    const pageX = Number(match![2]);
    const pageDx = Number(match![4]);
    const x = pageX + Math.floor(pageDx / 2);
    const pageY = Number(match![3]);
    const cap = captureWindowPixels(hwnd);
    check(!!cap, "capture failed");
    check(pageX >= 6 && pageX + pageDx + 6 <= cap!.w, `page outline clipped at sidebar edge: ${raw}`);
    const pixel = (py: number) => {
      const offset = (py * cap!.w + x) * 4;
      return [cap!.data[offset]!, cap!.data[offset + 1]!, cap!.data[offset + 2]!];
    };
    check(pageY >= 12 && pageY < cap!.h, `outline outside sidebar: ${raw}`);
    const background = pixel(pageY - 12);
    let contrast = 0;
    for (let y = pageY - 11; y < pageY; y++) {
      const line = pixel(y);
      contrast = Math.max(
        contrast,
        line.reduce((sum, c, i) => sum + Math.abs(c - background[i]!), 0),
      );
    }
    check(contrast > 60, `no spaced outline above page: contrast=${contrast}, background=${background}`);
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
