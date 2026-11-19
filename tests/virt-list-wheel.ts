import { strict as assert } from "node:assert";
import { ControlCommand } from "./control.ts";
import { cmdId, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync, waitToolWindow } from "./win-automation.ts";
import {
  clientToScreen,
  findVisibleChildWindow,
  getScrollInfo,
  getWindowRect,
  moveWindow,
  packCoords,
  postMessage,
  sendMessage,
  WM_CLOSE,
} from "./winapi.ts";

const WM_MOUSEWHEEL = 0x020a;
const wheelNotch = 120;

async function checkWheel(hwnd: number, x: number, y: number, position: () => Promise<number>): Promise<void> {
  const pt = clientToScreen(hwnd, x, y);
  const wheel = (delta: number) => sendMessage(hwnd, WM_MOUSEWHEEL, (delta & 0xffff) << 16, packCoords(pt.x, pt.y));
  const start = await position();
  wheel(-wheelNotch);
  const full = await position();
  assert.ok(full > start, "a full notch must scroll");
  wheel(wheelNotch);
  assert.equal(await position(), start);

  for (let i = 0; i < 4; i++) wheel(-wheelNotch / 4);
  assert.equal(await position(), full, "four quarter-notches must move as far as a full notch");
}

export async function testit(): Promise<void> {
  if (USE_NG) return;

  const appdata = writeAppdata("virt-list-wheel", "UiLanguage = en\nScrollbars = overlay\n");
  const { client, frame, proc } = await launchControlled(["-appdata", appdata]);
  try {
    sendCommandSync(frame, cmdId("CmdAdvancedSettings"));
    const dialog = await waitToolWindow(client, proc.pid!, "advsettings", { title: "Advanced Settings" });
    assert.ok(dialog, "Advanced Settings did not open");
    const geometry = async () => {
      const response = await client.request(ControlCommand.TestAdvSettingsRows, ["geom"]);
      const raw = String(response[1]);
      const fields = /content=(\d+),(\d+),(\d+),(\d+) itemDy=\d+ usableDy=\d+ scrollY=(\d+) maxScrollY=(\d+)/.exec(raw);
      assert.ok(fields, raw);
      return fields.slice(1).map(Number);
    };

    const [x, y, w, h] = await geometry();
    const scroll = async () => (await geometry())[4];
    await checkWheel(dialog, x + Math.floor(w / 2), y + Math.floor(h / 2), scroll);
    const bar = findVisibleChildWindow(dialog, "SUMATRA_OVERLAY_SCROLLBAR");
    assert.ok(bar, "the settings list must follow Scrollbars = overlay");
    const barRect = getWindowRect(bar);
    const listEdge = clientToScreen(dialog, x + w, y);
    assert.equal(barRect.right, listEdge.x);
    assert.equal(barRect.top, listEdge.y);
    sendMessage(dialog, 0x0115, 6, bar); // WM_VSCROLL, SB_TOP
    assert.equal(await scroll(), 0, "the shared bar must scroll its list");

    const settingsRect = getWindowRect(dialog);
    moveWindow(dialog, settingsRect.left, settingsRect.top, settingsRect.right - settingsRect.left, 400);
    // Enabling TeX inserts the inverse-search setting into the same list.
    const texToggle = async () => {
      const response = await client.request(ControlCommand.TestAdvSettingsRows, ["toggle-common", 9]);
      assert.match(String(response[1]), /EnableTeXEnhancements=/);
    };
    await texToggle();
    assert.ok((await scroll()) > 0, "changing a setting must keep its viewport");
    await texToggle();
    postMessage(dialog, WM_CLOSE, 0, 0);

    sendCommandSync(frame, cmdId("CmdToggleKeyboardHelp"));
    const help = await waitToolWindow(client, proc.pid!, "keyboard-help", { title: "Keyboard Shortcuts" });
    assert.ok(help, "Keyboard Shortcuts help did not open");
    const helpRect = getWindowRect(help);
    moveWindow(help, helpRect.left, helpRect.top, helpRect.right - helpRect.left, 240);
    await checkWheel(help, 40, 100, async () => getScrollInfo(help).pos);
    postMessage(help, WM_CLOSE, 0, 0);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
