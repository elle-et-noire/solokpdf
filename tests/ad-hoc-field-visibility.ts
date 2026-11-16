// Query fields must read as fields in every theme (E77-2, E77-3):
// - the find bar's editable combobox is one color: in Light the native ring and drop-down button
//   stayed white around an f2 edit
// - the filter fields of Advanced Settings, Keyboard Shortcuts, Zoom and the command palette have
//   a visible border: they had the dialog's color and no border, so an empty focused one vanished
import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { cmdId, makeTextPdf, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import {
  captureWindowPixels,
  enumChildWindows,
  enumWindows,
  getClassName,
  getParentWindow,
  getWindowPid,
  getWindowRect,
  isWindowVisible,
  postMessage,
  WM_CLOSE,
  WM_COMMAND,
} from "./winapi.ts";

const kCases: { theme: string; dpi: number }[] = [
  { theme: "Light", dpi: 100 },
  { theme: "Dark", dpi: 100 },
  { theme: "Solarized Light", dpi: 100 },
  { theme: "Light", dpi: 200 },
];
const kDialogs = ["CmdAdvancedSettings", "CmdCustomizeShortcuts", "CmdZoomCustom", "CmdCommandPalette"];
// the border must differ this much (gray levels) from the field inside it
const kMinBorderContrast = 16;
// a second color covering this share of the combobox is a second tone
const kMaxSecondTone = 0.05;
const IDCANCEL = 2;

type Cap = { w: number; h: number; data: Uint8Array };

function gray(c: Cap, x: number, y: number): number {
  const i = (y * c.w + x) * 4;
  return Math.round((c.data[i]! + c.data[i + 1]! + c.data[i + 2]!) / 3);
}

function topWindows(pid: number): { hwnd: number; cls: string }[] {
  const out: { hwnd: number; cls: string }[] = [];
  enumWindows((h) => {
    if (getWindowPid(h) === pid && isWindowVisible(h)) out.push({ hwnd: h, cls: getClassName(h) });
    return true;
  });
  return out;
}

function visibleChildren(parent: number, cls: string): number[] {
  const out: number[] = [];
  enumChildWindows(parent, (h) => {
    if (isWindowVisible(h) && getClassName(h) === cls) out.push(h);
    return true;
  });
  return out;
}

// share of the second most common color inside the combobox's 1px border
function secondToneShare(owner: number, combo: number): { share: number; colors: string } {
  const c = captureWindowPixels(owner, "window");
  if (!c) throw new Error("capture failed");
  const o = getWindowRect(owner);
  const r = getWindowRect(combo);
  const counts = new Map<number, number>();
  let n = 0;
  for (let y = r.top - o.top + 1; y < r.bottom - o.top - 1; y++) {
    for (let x = r.left - o.left + 1; x < r.right - o.left - 1; x++) {
      const i = (y * c.w + x) * 4;
      const rgb = (c.data[i + 2]! << 16) | (c.data[i + 1]! << 8) | c.data[i]!;
      counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
      n++;
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const colors = top
    .slice(0, 2)
    .map(([rgb, k]) => `${rgb.toString(16).padStart(6, "0")} ${Math.round((k * 100) / n)}%`)
    .join(", ");
  return { share: (top[1]?.[1] ?? 0) / n, colors };
}

// gray of the edit's outer pixel row against the field just inside it
function borderContrast(dlg: number, edit: number): { contrast: number; desc: string } {
  const c = captureWindowPixels(dlg, "window");
  if (!c) throw new Error("capture failed");
  const o = getWindowRect(dlg);
  const r = getWindowRect(edit);
  const x = r.left - o.left + Math.floor(((r.right - r.left) * 3) / 4);
  const top = gray(c, x, r.top - o.top);
  const bottom = gray(c, x, r.bottom - o.top - 1);
  const inside = gray(c, r.right - o.left - 4, r.top - o.top + Math.floor((r.bottom - r.top) / 2));
  const contrast = Math.min(Math.abs(top - inside), Math.abs(bottom - inside));
  return { contrast, desc: `edge ${top}/${bottom}, field ${inside}` };
}

// the topmost visible edit of a window that is not a combobox's own edit
function filterEdit(dlg: number): number {
  const combos = visibleChildren(dlg, "ComboBox");
  const edits = visibleChildren(dlg, "Edit").filter((h) => !combos.includes(getParentWindow(h)));
  edits.sort((a, b) => getWindowRect(a).top - getWindowRect(b).top);
  if (edits.length === 0) throw new Error("no edit");
  return edits[0]!;
}

async function openWindow(pid: number, frame: number, cmd: string): Promise<number> {
  const before = new Set(topWindows(pid).map((w) => w.hwnd));
  postMessage(frame, WM_COMMAND, cmdId(cmd), 0);
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(100);
    const w = topWindows(pid).find((x) => !before.has(x.hwnd) && x.cls !== "SUMATRA_OVERLAY_SCROLLBAR");
    if (w) {
      await Bun.sleep(300);
      return w.hwnd;
    }
  }
  throw new Error(`${cmd}: no window`);
}

async function closeWindow(pid: number, hwnd: number): Promise<void> {
  postMessage(hwnd, WM_COMMAND, IDCANCEL, 0);
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    if (!topWindows(pid).some((x) => x.hwnd === hwnd)) return;
    if (i === 5) postMessage(hwnd, WM_CLOSE, 0, 0);
  }
  throw new Error("window did not close");
}

async function checkCase(theme: string, dpi: number, pdf: string, errors: string[]): Promise<void> {
  const tag = `${theme} ${dpi}%`;
  const dir = writeAppdata(`field-visibility-${theme.replace(/ /g, "-")}-${dpi}`, `Theme = ${theme}\n`);
  const s = await launchControlled(["-appdata", dir, pdf], { env: { SUMATRA_DPI_OVERRIDE: String(dpi) } });
  const pid = s.proc.pid!;
  const out: string[] = [];
  try {
    await s.client.request(ControlCommand.SetNotificationsEnabled, [0]);
    await s.client.waitForRenderIdle();

    sendCommandSync(s.frame, cmdId("CmdFindFirst"));
    await Bun.sleep(400);
    const bar = topWindows(pid).find((w) => w.hwnd !== s.frame && visibleChildren(w.hwnd, "ComboBox").length > 0);
    if (!bar) {
      errors.push(`${tag}: no find bar`);
    } else {
      const r = secondToneShare(bar.hwnd, visibleChildren(bar.hwnd, "ComboBox")[0]!);
      out.push(`find ${r.colors}`);
      if (r.share > kMaxSecondTone) errors.push(`${tag}: find box is two-tone (${r.colors})`);
    }
    sendCommandSync(s.frame, cmdId("CmdFindFirst"));

    for (const cmd of kDialogs) {
      const dlg = await openWindow(pid, s.frame, cmd);
      try {
        const r = borderContrast(dlg, filterEdit(dlg));
        out.push(`${cmd.slice(3)} ${r.desc}`);
        if (r.contrast < kMinBorderContrast) errors.push(`${tag}: ${cmd} filter has no visible border (${r.desc})`);
      } finally {
        await closeWindow(pid, dlg);
      }
    }
    console.log(`${tag}: ${out.join("; ")}`);
  } finally {
    await s.client.request(ControlCommand.Quit, []).catch(() => {});
    s.client.close();
    await killAndWait(s.proc);
  }
}

async function run(cases: { theme: string; dpi: number }[]): Promise<void> {
  const pdf = tmpPath("field-visibility.pdf");
  writeFileSync(pdf, makeTextPdf("field visibility"));
  const errors: string[] = [];
  for (const { theme, dpi } of cases) {
    await checkCase(theme, dpi, pdf, errors).catch((e) => errors.push(`${theme} ${dpi}%: ${e}`));
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

export async function testit(): Promise<void> {
  await run(kCases);
}

// Light and Dark at 100%, for the CI suite
export async function testQuick(): Promise<void> {
  await run(kCases.slice(0, 2));
}

if (import.meta.main) await runStandalone(testit);
