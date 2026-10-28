import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath, writeAppdata } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, pressKey, waitToolWindow } from "./win-automation.ts";
import { ControlCommand } from "./control.ts";
import { getScrollPos, sendText, sleep } from "./winapi.ts";

function makePdf(links: "links" | "no-links" = "links"): string {
  const pages = Array.from({ length: 8 }, (_, i) => `${3 + i} 0 R`);
  const page = (i: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${i === 0 && links === "links" ? " /Annots [11 0 R]" : ""}${i === 5 ? " /Contents 12 0 R /Resources << /Font << /F1 13 0 R >> >>" : ""} >>`;
  const content = "BT /F1 20 Tf 72 700 Td (stale-term) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pages.length} >>`,
    ...pages.map((_, i) => page(i)),
    "<< /Type /Annot /Subtype /Link /Rect [72 650 260 680] /Border [0 0 0] /Dest [5 0 R /Fit] >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("vim-keys.pdf");
  const pdf2 = tmpPath("vim-keys-other.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  writeFileSync(pdf2, makePdf(), "latin1");
  const offAppdata = writeAppdata("vim-keys-off-appdata", "VimKeys = false\nRestoreSession = false\n");
  const off = await launchControlled(["-appdata", offAppdata, pdf]);
  try {
    await off.client.waitForRenderIdle();
    for (const [key, expected] of [
      ["g", "CmdGoToPage"],
      ["n", "CmdGoToNextPage"],
    ]) {
      const res = await off.client.request(ControlCommand.TestShortcutsDialog, ["resolve", "", key]);
      if (res[1] !== expected) throw new Error(`mode off ${key}: ${res[1]}`);
    }
  } finally {
    await off.client.quit().catch(() => {});
    await killAndWait(off.proc);
  }

  const appdata = writeAppdata(
    "vim-keys-appdata",
    "VimKeys = true\nRestoreSession = false\nSmoothScroll = false\nUseTabs = true\nNoHomeTab = true\nCtrlTabSimple = true\n",
  );
  const { proc, client, frame } = await launchControlled(
    ["-appdata", appdata, "-zoom", "200", "-view", "continuous", pdf, pdf2],
    { saveSettings: true },
  );
  let markedPath = "";
  const state = async (action = "state", key = "") => {
    const res = await client.request(ControlCommand.TestVimKeys, [action, key]);
    if (res[0] !== 0) throw new Error(String(res[1]));
    return String(res[1]);
  };
  const page = async () => Number(/page=(\d+)/.exec(await state())?.[1] ?? 0);
  const path = async () =>
    String((await client.request(ControlCommand.TestCurrentTab, []))[1]).match(/path=(.*) page=/)?.[1] ?? "";
  const key = async (stroke: string) => state("key", stroke);
  try {
    await client.waitForRenderIdle();
    if (!/mode=1/.test(await state())) throw new Error("VimKeys setting was not loaded");
    for (const [stroke, expected] of [
      ["n", "CmdFindNext"],
      ["shift-n", "CmdFindPrev"],
      ["ctrl-o", "CmdNavigateBack"],
      ["ctrl-i", "CmdNavigateForward"],
      ["ctrl-d", "CmdScrollDownHalfPage"],
      ["ctrl-u", "CmdScrollUpHalfPage"],
      ["ctrl-f", "CmdScrollDownPage"],
      ["ctrl-b", "CmdScrollUpPage"],
      ["ctrl-e", "CmdVimScrollDownLine"],
      ["ctrl-y", "CmdVimScrollUpLine"],
    ]) {
      const res = await client.request(ControlCommand.TestShortcutsDialog, ["resolve", "", stroke]);
      if (res[1] !== expected) throw new Error(`Vim ${stroke} resolved to ${res[1]}`);
    }
    await pressKey(frame, 0x23);
    if ((await page()) !== 8) throw new Error("End did not go to page 8");
    await pressKey(frame, 0x47);
    await pressKey(frame, 0x47);
    if ((await page()) !== 1) throw new Error("gg did not go to page 1");
    await pressKey(frame, 0x33);
    await pressKey(frame, 0x47);
    await pressKey(frame, 0x47);
    if ((await page()) !== 3) throw new Error("3gg did not go to page 3");
    await pressKey(frame, 0x47);
    await pressKey(frame, 0x47);

    await key("Shift+G");
    if ((await page()) !== 8) throw new Error("G did not go to last page");
    await key("Ctrl+O");
    if ((await page()) !== 1) throw new Error("Ctrl+O did not navigate back");
    await pressKey(frame, 0x35);
    await key("Shift+G");
    if ((await page()) !== 5) throw new Error("5G did not go to page 5");

    await pressKey(frame, 0xbf);
    if (/focus=1/.test(await state())) throw new Error("/ did not focus the find box");
    await client.request(ControlCommand.TestFindUiState, ["set-first-text"]);
    await key("N");
    for (let i = 0; i < 40 && (await page()) !== 6; i++) await sleep(50);
    if ((await page()) !== 6) throw new Error("n did not find the next match");

    await pressKey(frame, 0x47);
    await pressKey(frame, 0x47);
    await client.waitForRenderIdle();
    for (let i = 0; i < 10; i++) {
      await pressKey(frame, 0x46, 40);
      const res = await client.request(ControlCommand.TestKeyboardLinkFollow, []);
      if (/active=1.*count=1/.test(String(res[1]))) break;
      await sleep(50);
    }
    const hints = String((await client.request(ControlCommand.TestKeyboardLinkFollow, []))[1]);
    const hint = /hint=([A-Z;]+)/.exec(hints)?.[1];
    if (!hint || !/active=1/.test(hints)) throw new Error(`f did not show link hints: ${hints}`);
    for (const ch of hint) await pressKey(frame, ch.charCodeAt(0), 50);
    if ((await page()) !== 3) throw new Error("f link hint did not follow the internal link");

    markedPath = await path();
    await pressKey(frame, 0x4d);
    await pressKey(frame, 0x41);
    await pressKey(frame, 0x47);
    await pressKey(frame, 0x47);
    await key("'");
    await pressKey(frame, 0x41);
    if ((await page()) !== 3) throw new Error("'a did not restore the mark");
    await key("'");
    await key("'");
    if ((await page()) !== 1) throw new Error("'' did not jump back");

    const canvas = findCanvas(frame);
    const before = getScrollPos(canvas);
    await key("Ctrl+D");
    if (getScrollPos(canvas) <= before) throw new Error("Ctrl+D did not scroll half a page");
    const afterHalf = getScrollPos(canvas);
    await key("Ctrl+E");
    const wheelLine = getScrollPos(canvas) - afterHalf;
    if (wheelLine <= 0 || wheelLine > 40) throw new Error(`Ctrl+E used ${wheelLine}px, not a wheel line`);
    await key("Ctrl+Y");
    if (Math.abs(getScrollPos(canvas) - afterHalf) > 2) throw new Error("Ctrl+Y did not scroll one wheel line up");
    await pressKey(frame, 0x33);
    await key("Ctrl+E");
    if (Math.abs(getScrollPos(canvas) - afterHalf - 3 * wheelLine) > 3) {
      throw new Error("3 Ctrl+E did not scroll three wheel lines");
    }

    await key(":");
    const edit = Number(/edit=(\d+)/.exec(await state())?.[1] ?? 0);
    if (!edit) throw new Error(": did not open the command line");
    sendText(edit, ":3");
    await pressKey(edit, 0x0d);
    if ((await page()) !== 3) throw new Error(":3 did not go to page 3");

    for (const ch of [":", "'", "`"]) {
      const result = await state("jis", ch);
      if (ch === ":") {
        if (!/edit=[1-9]/.test(result)) throw new Error("JIS : did not open the command line");
        const jisEdit = Number(/edit=(\d+)/.exec(result)?.[1] ?? 0);
        await pressKey(jisEdit, 0x1b);
      } else {
        if (!result.includes(`prefix=${ch}`)) throw new Error(`JIS ${ch} did not start a mark command`);
        await pressKey(frame, 0x1b);
      }
    }

    const tabBefore = await path();
    await pressKey(frame, 0x47);
    await pressKey(frame, 0x54);
    if ((await path()) === tabBefore) throw new Error("gt did not switch tabs");
    await pressKey(frame, 0x32);
    await pressKey(frame, 0x47);
    await pressKey(frame, 0x54);
    if ((await path()) !== tabBefore) throw new Error("2gt did not select tab 2");
    await pressKey(frame, 0x47);
    await key("Shift+T");
    if ((await path()) === tabBefore) throw new Error("gT did not select the previous tab");

    await client.request(ControlCommand.TestInvokeCommand, ["CmdToggleVimKeys"]);
    for (let i = 0; i < 20 && !/mode=0/.test(await state()); i++) await sleep(25);
    if (!/mode=0/.test(await state())) throw new Error("Vim toggle did not turn the mode off");
    const offN = await client.request(ControlCommand.TestShortcutsDialog, ["resolve", "", "n"]);
    if (offN[1] !== "CmdGoToNextPage") throw new Error(`Vim toggle kept n mapped to ${offN[1]}`);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdToggleVimKeys"]);
    for (let i = 0; i < 20 && !/mode=1/.test(await state()); i++) await sleep(25);

    if (/focus=1/.test(await state("jis", "/"))) throw new Error("JIS / did not focus the find box");
    await state("jis", "?");
    const help = await waitToolWindow(client, proc.pid!, "keyboard-help", { title: "Keyboard Shortcuts" });
    if (!help) throw new Error("JIS ? did not open keyboard help");
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }

  const saved = readFileSync(join(appdata, SETTINGS_FILE), "utf8");
  if (!/VimMarks\s*=\s*a,3,/.test(saved)) throw new Error("Vim mark was not saved in FileState");
  const reopened = await launchControlled(["-appdata", appdata, markedPath], { saveSettings: true });
  try {
    await reopened.client.waitForRenderIdle();
    await pressKey(reopened.frame, 0x23);
    await reopened.client.request(ControlCommand.TestVimKeys, ["key", "'"]);
    await pressKey(reopened.frame, 0x41);
    const res = await reopened.client.request(ControlCommand.TestCurrentTab, []);
    if (!/page=3/.test(String(res[1]))) throw new Error("saved Vim mark was not restored");
  } finally {
    await reopened.client.quit().catch(() => {});
    await killAndWait(reopened.proc);
  }

  const noLinks = tmpPath("vim-keys-no-links.pdf");
  writeFileSync(noLinks, makePdf("no-links"), "latin1");
  const empty = await launchControlled(["-appdata", appdata, noLinks]);
  try {
    await empty.client.waitForRenderIdle();
    await pressKey(empty.frame, 0x23);
    await pressKey(empty.frame, 0x46);
    await pressKey(empty.frame, 0x47);
    await pressKey(empty.frame, 0x47);
    const res = await empty.client.request(ControlCommand.TestCurrentTab, []);
    if (!/page=1/.test(String(res[1]))) throw new Error("No-link hint mode swallowed later keys");
  } finally {
    await empty.client.quit().catch(() => {});
    await killAndWait(empty.proc);
  }
}

if (import.meta.main) await runStandalone(testit);
