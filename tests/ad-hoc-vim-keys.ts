import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assemblePdf,
  cmdId,
  dpiRequest,
  parseDpiFields,
  runStandalone,
  SETTINGS_FILE,
  tmpPath,
  writeAppdata,
} from "./util.ts";
import {
  activateTestFrame,
  canActivateTestFrame,
  clickAt,
  findCanvas,
  killAndWait,
  launchControlled,
  moveTestCursor,
  pressKey,
  sendCommand,
  sendCommandSync,
  waitForFocusClass,
  waitToolWindow,
} from "./win-automation.ts";
import { ControlCommand } from "./control.ts";
import { makeBookmarkedPdf } from "./toc-tree-sent-click.ts";
import {
  clientToScreen,
  findVisibleChildWindow,
  getControlText,
  getFocusedHwnd,
  getScrollPos,
  MK_LBUTTON,
  packCoords,
  postMessage,
  sendMessage,
  sendText,
  sleep,
  treeGetItemHeight,
  treeGetSelection,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
} from "./winapi.ts";
import { canTestClipboard, clearTestClipboard, getTestClipboardText } from "./test-clipboard.ts";

const WM_IME_STARTCOMPOSITION = 0x010d;
const WM_IME_ENDCOMPOSITION = 0x010e;
const WM_ACTIVATE = 0x0006;
const WA_INACTIVE = 0;

function makePdf(links: "links" | "no-links" = "links"): string {
  const pages = Array.from({ length: 8 }, (_, i) => `${3 + i} 0 R`);
  const page = (i: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${i === 0 && links === "links" ? " /Annots [11 0 R]" : ""} /Contents ${12 + i} 0 R /Resources << /Font << /F1 20 0 R >> >> >>`;
  const content = (i: number) => `BT /F1 20 Tf 72 700 Td (vim-page-${i + 1}${i === 5 ? " stale-term" : ""}) Tj ET`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pages.length} >>`,
    ...pages.map((_, i) => page(i)),
    "<< /Type /Annot /Subtype /Link /Rect [72 650 260 680] /Border [0 0 0] /Dest [5 0 R /Fit] >>",
    ...pages.map((_, i) => `<< /Length ${content(i).length} >>\nstream\n${content(i)}\nendstream`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

export async function testit(): Promise<void> {
  if (!canTestClipboard("ad-hoc-vim-keys")) return;
  if (!canActivateTestFrame()) {
    console.log("SKIP ad-hoc-vim-keys: hidden desktop, CI, or SOLOKPDF_REAL_DESKTOP=1 required");
    return;
  }
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
    await activateTestFrame(off.client);
    await off.client.request(ControlCommand.TestFocusState, ["ctrl-down"]);
    postMessage(off.frame, WM_KEYDOWN, 0x46, 1);
    await off.client.request(ControlCommand.TestFocusState, []);
    await off.client.request(ControlCommand.TestFocusState, ["ctrl-up"]);
    const findEdit = await waitForFocusClass(off.frame, "Edit");
    sendText(findEdit, "");
    postMessage(findEdit, WM_KEYDOWN, 0x46, (1 << 30) | 1);
    await off.client.request(ControlCommand.TestFocusState, []);
    await sleep(400);
    if (getControlText(findEdit) !== "") throw new Error("repeated shortcut typed in find edit");
    postMessage(findEdit, WM_KEYUP, 0x46, 0xc0000001);
    await off.client.request(ControlCommand.TestFocusState, []);
    // Probe the release independently of the new-key path, which also clears suppression.
    postMessage(findEdit, WM_KEYDOWN, 0x46, (1 << 30) | 1);
    await off.client.request(ControlCommand.TestFocusState, []);
    await sleep(400);
    if (getControlText(findEdit) !== "f") throw new Error("key release did not clear repeat suppression");
    postMessage(findEdit, WM_KEYDOWN, 0x46, 1);
    await off.client.request(ControlCommand.TestFocusState, []);
    await sleep(400);
    const typed = getControlText(findEdit);
    if (typed !== "ff") throw new Error(`find edit after key release: ${JSON.stringify(typed)}`);
  } finally {
    await off.client.quit().catch(() => {});
    await killAndWait(off.proc);
  }

  const appdata = writeAppdata(
    "vim-keys-appdata",
    "VimKeys = true\nRestoreSession = false\nSmoothScroll = false\nScrollbars = windows\nKeyScrollLineAmount = 100\nScrollLineAmount = 10\nUseTabs = true\nNoHomeTab = true\nCtrlTabSimple = true\n",
  );
  const { proc, client, frame } = await launchControlled(
    ["-appdata", appdata, "-zoom", "200", "-view", "continuous", pdf, pdf2],
    { saveSettings: true },
  );
  if (process.env.SOLOKPDF_REAL_CLIPBOARD !== "1") await client.request(ControlCommand.TestClipboardText, ["enable"]);
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
    await activateTestFrame(client);
    if (!/mode=1/.test(await state())) throw new Error("VimKeys setting was not loaded");
    await pressKey(frame, 0x30);
    if (!/count=0 prefix=-/.test(await state())) throw new Error("leading zero started a count");
    await pressKey(frame, 0x31);
    await pressKey(frame, 0x30);
    if (!/count=10 prefix=-/.test(await state())) throw new Error("zero did not extend a count");
    await pressKey(frame, 0x1b);
    await pressKey(frame, 0x33);
    if (!/count=3/.test(await state())) throw new Error("count prefix was not recorded");
    await pressKey(frame, 0x4e);
    if (!/count=0/.test(await state())) throw new Error("n left an unused count prefix");
    await pressKey(frame, 0x33);
    await pressKey(frame, 0x46);
    if (!/count=0/.test(await state())) throw new Error("f left an unused count prefix");
    await pressKey(frame, 0x1b);
    await pressKey(frame, 0x33);
    await client.request(ControlCommand.TestFocusState, ["page-edit"]);
    if (!/focus=0.*count=0/.test(await state())) throw new Error("focus change left a count prefix");
    await pressKey(frame, 0x33);
    if (!/focus=0.*count=0/.test(await state())) throw new Error("unfocused frame accepted a count");
    await activateTestFrame(client);
    await pressKey(frame, 0x47);
    if (!/prefix=g/.test(await state())) throw new Error("g did not start a prefix");
    await client.request(ControlCommand.TestFocusState, ["page-edit"]);
    if (!/focus=0.*count=0 prefix=-/.test(await state())) throw new Error("focus change left a key prefix");
    await activateTestFrame(client);
    await pressKey(frame, 0x33);
    await pressKey(frame, 0x87);
    if (!/count=0 prefix=-/.test(await state())) throw new Error("unbound key left a count prefix");
    const initialTab = await path();
    await pressKey(frame, 0x47);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdNextTab"]);
    if ((await path()) === initialTab || !/count=0 prefix=-/.test(await state())) {
      throw new Error("tab change left a key prefix");
    }
    await client.request(ControlCommand.TestInvokeCommand, ["CmdNextTab"]);
    if ((await path()) !== initialTab) throw new Error("could not restore initial tab");
    await activateTestFrame(client);
    const clickCanvas = findCanvas(frame);
    const clickPoint = clientToScreen(clickCanvas, 10, 10);
    await moveTestCursor(clickPoint.x, clickPoint.y, client);
    await pressKey(frame, 0x33);
    await pressKey(frame, 0x47);
    if (!/count=3 prefix=g/.test(await state())) throw new Error("counted prefix was not recorded");
    postMessage(clickCanvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(10, 10));
    postMessage(clickCanvas, WM_LBUTTONUP, 0, packCoords(10, 10));
    if (!/count=0 prefix=-/.test(await state())) throw new Error("mouse click left a counted prefix");
    await activateTestFrame(client);
    await pressKey(frame, 0x33);
    await pressKey(frame, 0x47);
    if (!/count=3 prefix=g/.test(await state())) throw new Error("counted prefix was not recorded before deactivation");
    sendMessage(frame, WM_ACTIVATE, WA_INACTIVE, 0);
    if (!/count=0 prefix=-/.test(await state())) throw new Error("deactivation left a counted prefix");
    await activateTestFrame(client);
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
    await client.request(ControlCommand.TestInvokeCommand, ["CmdZoom200"]);
    await client.waitForRenderIdle();

    const canvas = findCanvas(frame);
    const pageTop = getScrollPos(canvas);
    const zPrefix = await key("z");
    const zResult = await key("z");
    const centered = getScrollPos(canvas);
    if (centered <= pageTop)
      throw new Error(`zz did not center the page: ${pageTop} -> ${centered}; ${zPrefix}; ${zResult}`);
    await key("z");
    await key("t");
    if (getScrollPos(canvas) >= centered) throw new Error("zt did not move the page to the top");
    await key("z");
    await key("b");
    if (getScrollPos(canvas) <= centered) throw new Error("zb did not move the page to the bottom");

    await clearTestClipboard(client);
    await key("y");
    await key("y");
    if (!(await getTestClipboardText(client)).includes("vim-page-5")) throw new Error("yy did not copy page 5 text");
    await clearTestClipboard(client);
    await pressKey(frame, 0x33);
    await key("y");
    await key("y");
    const copied = await getTestClipboardText(client);
    if (!["vim-page-5", "vim-page-6", "vim-page-7"].every((s) => copied.includes(s)) || copied.includes("vim-page-8")) {
      throw new Error(`3yy copied unexpected pages: ${copied}`);
    }

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
    if ((await state("jis-hint", ";")) !== "capture=1") throw new Error("JIS ; did not stay in link hints");
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

    const before = getScrollPos(canvas);
    await key("Ctrl+D");
    if (getScrollPos(canvas) <= before) throw new Error("Ctrl+D did not scroll half a page");
    const afterHalf = getScrollPos(canvas);
    await key("Ctrl+E");
    const wheelLine = getScrollPos(canvas) - afterHalf;
    const dpi = parseDpiFields(await dpiRequest(client, "state")).frame;
    const expectedKeyLine = Math.round((100 * dpi) / 96);
    if (Math.abs(wheelLine - expectedKeyLine) > 3) {
      throw new Error(`Ctrl+E used ${wheelLine}px, want ${expectedKeyLine}px`);
    }
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

    await key(":");
    const imeEdit = Number(/edit=(\d+)/.exec(await state())?.[1] ?? 0);
    sendText(imeEdit, ":composing");
    sendMessage(imeEdit, WM_IME_STARTCOMPOSITION, 0, 0);
    await pressKey(imeEdit, 0x26);
    if (getControlText(imeEdit) !== ":composing") throw new Error("IME Up changed the Vim command history");
    await pressKey(imeEdit, 0x28);
    if (getControlText(imeEdit) !== ":composing") throw new Error("IME Down changed the Vim command history");
    await pressKey(imeEdit, 0x1b);
    if (!/edit=[1-9]/.test(await state())) throw new Error("IME Escape closed the Vim command line");
    await pressKey(imeEdit, 0x0d);
    if (!/edit=[1-9]/.test(await state())) throw new Error("IME Enter submitted the Vim command line");
    sendMessage(imeEdit, WM_IME_ENDCOMPOSITION, 0, 0);
    await pressKey(imeEdit, 0x26);
    if (getControlText(imeEdit) !== ":3") throw new Error("Up did not recall command history after IME composition");
    await pressKey(imeEdit, 0x1b);

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
    await activateTestFrame(reopened.client);
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
    await activateTestFrame(empty.client);
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

  const customDir = writeAppdata(
    "vim-keys-custom-appdata",
    "UiLanguage = en\nVimKeys = true\nRestoreSession = false\nShortcuts [\n [\n  Cmd = CmdGoToNextPage\n  Key = g\n ]\n [\n  Cmd = CmdGoToNextPage\n  Key = 3\n ]\n [\n  Cmd = CmdGoToNextPage\n  Key = Ctrl+K\n ]\n]\n",
  );
  const custom = await launchControlled(["-appdata", customDir, pdf]);
  try {
    await custom.client.waitForRenderIdle();
    await activateTestFrame(custom.client);
    for (const [vk, expected] of [
      [0x33, 2],
      [0x47, 3],
    ]) {
      await pressKey(custom.frame, vk);
      const result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
      if (!result.includes(`page=${expected} `) || !/count=0 prefix=-/.test(result)) {
        throw new Error(`custom shortcut ${vk} lost to Vim keys: ${result}`);
      }
    }
    await pressKey(custom.frame, 0x34);
    let result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
    if (!/count=4 prefix=-/.test(result)) throw new Error(`count did not start: ${result}`);
    await pressKey(custom.frame, 0x47);
    result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
    if (!result.includes("page=4 ") || !/count=0 prefix=-/.test(result)) {
      throw new Error(`custom shortcut did not discard count: ${result}`);
    }
    await pressKey(custom.frame, 0x5a);
    result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
    if (!/count=0 prefix=z/.test(result)) throw new Error(`prefix did not start: ${result}`);
    await pressKey(custom.frame, 0x47);
    result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
    if (!result.includes("page=5 ") || !/count=0 prefix=-/.test(result)) {
      throw new Error(`custom shortcut did not discard prefix: ${result}`);
    }
    sendCommandSync(custom.frame, cmdId("CmdFindFirst"));
    const findEdit = await waitForFocusClass(custom.frame, "Edit");
    sendText(findEdit, "");
    await pressKey(findEdit, 0x47);
    await pressKey(findEdit, 0x33);
    await pressKey(findEdit, 0x25);
    await pressKey(findEdit, 0x34);
    const text = getControlText(findEdit);
    result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
    if (text !== "g43" || !result.includes("page=5 ") || !/count=0 prefix=-/.test(result)) {
      throw new Error(`find edit lost input to custom shortcuts: text=${text}, ${result}`);
    }
    await custom.client.request(ControlCommand.TestFocusState, ["ctrl-down"]);
    postMessage(findEdit, WM_KEYDOWN, 0x4b, 1);
    await custom.client.request(ControlCommand.TestFocusState, []);
    await custom.client.request(ControlCommand.TestFocusState, ["ctrl-up"]);
    postMessage(findEdit, WM_KEYUP, 0x4b, 0xc0000001);
    await custom.client.request(ControlCommand.TestFocusState, []);
    result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
    if (getControlText(findEdit) !== "g43" || !result.includes("page=6 ") || !/count=0 prefix=-/.test(result)) {
      throw new Error(`find edit lost modified shortcut: ${result}`);
    }
    await activateTestFrame(custom.client);
    sendCommand(custom.frame, cmdId("CmdZoomCustom"));
    const dialog = await waitToolWindow(custom.client, custom.proc.pid!, "customzoom", { title: "Zoom" });
    if (!dialog) throw new Error("custom zoom dialog did not open");
    const zoomEdit = await waitForFocusClass(custom.frame, "Edit");
    await pressKey(zoomEdit, 0x33);
    if (getControlText(zoomEdit) !== "3") throw new Error("custom shortcut stole dialog input");
    await pressKey(zoomEdit, 0x1b);
    result = String((await custom.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
    if (!result.includes("page=6 ") || !/count=0 prefix=-/.test(result)) {
      throw new Error(`dialog input changed document key state: ${result}`);
    }
  } finally {
    await custom.client.quit().catch(() => {});
    await killAndWait(custom.proc);
  }

  const outline = tmpPath("vim-keys-outline.pdf");
  writeFileSync(outline, makeBookmarkedPdf());
  for (const vim of [false, true]) {
    const dir = writeAppdata(
      `vim-keys-tree-${vim}`,
      `VimKeys = ${vim}\nRestoreSession = false\nShortcuts [\n [\n  Cmd = CmdGoToNextPage\n  Key = g\n ]\n]\n`,
    );
    const treeApp = await launchControlled(["-appdata", dir, outline]);
    try {
      await treeApp.client.waitForRenderIdle();
      await activateTestFrame(treeApp.client);
      const tree = findVisibleChildWindow(treeApp.frame, "SysTreeView32");
      if (!tree) throw new Error("bookmarks tree not found");
      await clickAt(tree, 40, Math.floor(treeGetItemHeight(tree) / 2));
      if (getFocusedHwnd(treeApp.frame) !== tree) throw new Error("bookmarks tree did not receive focus");
      const before = treeGetSelection(tree);
      await pressKey(tree, 0x28);
      if (!before || treeGetSelection(tree) === before)
        throw new Error(`tree Down did not move selection (Vim=${vim})`);
      await pressKey(tree, 0x47);
      const result = String((await treeApp.client.request(ControlCommand.TestVimKeys, ["state"]))[1]);
      if (!result.includes("page=3 ") || !/count=0 prefix=-/.test(result)) {
        throw new Error(`tree custom shortcut did not run (Vim=${vim}): ${result}`);
      }
    } finally {
      await treeApp.client.quit().catch(() => {});
      await killAndWait(treeApp.proc);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
