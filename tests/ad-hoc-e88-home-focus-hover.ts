// E88: opening Home leaves the keyboard focus out of its search box, typing a
// character there starts a search, and hovering a history entry shows its
// outline even while the search box has the focus (list and thumbnails).
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient, waitForHome } from "./control.ts";
import { ROOT, SETTINGS_FILE, cmdId, runStandalone, tmpPath } from "./util.ts";
import {
  clientToScreen,
  packCoords,
  postMessage,
  sendMessage,
  sleep,
  VK_ESCAPE,
  WM_KEYDOWN,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import {
  activateTestFrame,
  findCanvas,
  findChildByClass,
  killAndWait,
  launchControlled,
  moveTestCursor,
  sendCommand,
} from "./win-automation.ts";

const N_FILES = 6;
const VK_RIGHT = 0x27;
const VK_DOWN = 0x28;
const VK_4 = 0x34;
const SCAN_4 = 0x05;
// focus must not move to the search box once Home is up
const SETTLE_MS = 400;

function check(cond: boolean, what: string): void {
  if (!cond) throw new Error(`ad-hoc-e88: ${what}`);
}

function makeAppDir(): string {
  const dir = tmpPath("ad-hoc-e88");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "sub"), { recursive: true });
  const src = join(ROOT, "ext", "a-zlib", "zlib.3.pdf");
  const states: string[] = [];
  for (let i = 0; i < N_FILES; i++) {
    const p = join(dir, "sub", `doc-${String(i).padStart(2, "0")}.pdf`);
    copyFileSync(src, p);
    states.push(`\t[\n\t\tFilePath = ${p}\n\t\tOpenCount = ${N_FILES - i}\n\t]`);
  }
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = true\n` +
      `HomePageViewMode = thumbnails\nFileStates [\n${states.join("\n")}\n]\n`,
  );
  return dir;
}

async function expectNoSearchFocus(client: ControlClient, what: string): Promise<void> {
  await waitForHome(client, (h) => h.entries === N_FILES && h.searchBox, `${what}: Home not ready`);
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    const h = await client.homeSelection();
    check(!h.searchFocus, `${what}: the search box took the focus`);
    await sleep(50);
  }
}

// With the search box focused and the keyboard selection moved off an entry,
// hovering that entry must select it and show its outline.
async function checkHover(
  client: ControlClient,
  frame: number,
  canvas: number,
  mode: "list" | "thumbnails",
): Promise<void> {
  await client.homeSelection(mode);
  await waitForHome(client, (s) => s.listView === (mode === "list") && s.entries === N_FILES, `${mode}: no layout`);
  await moveTestCursor(0, 0);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(1, 1));
  await activateTestFrame(client);
  sendMessage(canvas, WM_KEYDOWN, mode === "list" ? VK_DOWN : VK_RIGHT, 0);
  const h = await waitForHome(client, (s) => s.sel >= 0 && s.selShown, `${mode}: no keyboard selection`);
  const idx = h.sel;
  const r = h.selRect;
  sendMessage(canvas, WM_KEYDOWN, mode === "list" ? VK_DOWN : VK_RIGHT, 0);
  await waitForHome(client, (s) => s.sel === idx + 1, `${mode}: arrow did not move the selection`);
  sendCommand(frame, cmdId("CmdFindFirst"));
  await waitForHome(client, (s) => s.searchFocus, `${mode}: CmdFindFirst did not focus the search box`);

  const x = r[0]! + Math.floor(r[2]! / 2);
  const y = r[1]! + Math.floor(r[3]! / 2);
  const screen = clientToScreen(canvas, x, y);
  await moveTestCursor(screen.x, screen.y);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(x, y));
  await waitForHome(
    client,
    (s) => s.hover === idx && s.sel === idx && s.searchFocus && s.selShown,
    `${mode}: hovering entry ${idx} with the search box focused shows no outline`,
  );
}

export async function testit(): Promise<void> {
  const { proc, client, frame } = await launchControlled(["-appdata", makeAppDir()]);
  try {
    const canvas = findCanvas(frame);
    check(canvas !== 0, "canvas not found");
    await expectNoSearchFocus(client, "startup Home");

    const pressed = await client.request(ControlCommand.TestShortcutsDialog, ["press", "", "Ctrl+T"]);
    check(pressed[1] === "CmdNewTab", `Ctrl+T ran ${pressed[1]}`);
    await expectNoSearchFocus(client, "Home from Ctrl+T");

    await checkHover(client, frame, canvas, "thumbnails");
    await checkHover(client, frame, canvas, "list");

    // Esc leaves the search box; a typed character then starts a new search
    const edit = findChildByClass(canvas, "Edit");
    check(edit !== 0, "search edit not found");
    sendMessage(edit, WM_KEYDOWN, VK_ESCAPE, 0);
    await waitForHome(client, (s) => !s.searchFocus && s.entries === N_FILES, "Esc did not leave the search box");
    postMessage(canvas, WM_KEYDOWN, VK_4, 1 | (SCAN_4 << 16));
    await waitForHome(
      client,
      (s) => s.searchFocus && s.entries === 1 && s.path.includes("doc-04.pdf"),
      "typing on Home did not start a search",
    );
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
