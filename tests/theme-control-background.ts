import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import { assemblePdf, loadPng, ROOT, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import {
  activateTestFrame,
  clickAt,
  findCanvas,
  killAndWait,
  launchControlled,
  waitToolWindow,
} from "./win-automation";
import {
  captureWindowDCRegionToPng,
  captureWindowToPng,
  clientToScreen,
  enableWindow,
  enumChildWindows,
  enumWindows,
  findChildWindow,
  getClassName,
  getClientRect,
  getFocusedHwnd,
  getParentWindow,
  getWindowPid,
  getWindowRect,
  getWindowText,
  isWindowVisible,
  postMessage,
  sendMessage,
  sendText,
  sleep,
  VK_DOWN,
  VK_HOME,
  VK_RETURN,
  WM_GETTEXTLENGTH,
  WM_KEYDOWN,
  WM_KEYUP,
} from "./winapi";

function makePdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
    "<< /Title (Chapter one) /Parent 4 0 R /Dest [3 0 R /Fit] >>",
  ]);
}

// PrintWindow may paint dialogs in the OS theme: read their client area from the window DC
function captureDialog(hwnd: number, path: string): boolean {
  const win = getWindowRect(hwnd);
  const origin = clientToScreen(hwnd, 0, 0);
  const rc = getClientRect(hwnd);
  return captureWindowDCRegionToPng(hwnd, origin.x - win.left, origin.y - win.top, rc.right, rc.bottom, path);
}

function pixel(hwnd: number, path: string, kind: "dialog" | "list" | "edit" = "edit"): string {
  const capture = kind === "edit" ? captureWindowToPng : captureDialog;
  if (!capture(hwnd, path)) throw new Error(`capture failed: ${path}`);
  const img = loadPng(path);
  const x = kind === "dialog" ? 10 : kind === "list" ? 20 : img.w - 5;
  const y = kind === "dialog" ? img.h - 10 : Math.floor(img.h / 2);
  const p = (y * img.w + x) * img.nComp;
  return Array.from(img.data.subarray(p, p + 3))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

function maxCueContrast(hwnd: number, path: string, bg: string, startX = 5): number {
  if (!captureWindowToPng(hwnd, path)) throw new Error(`capture failed: ${path}`);
  const img = loadPng(path);
  const luminance = (r: number, g: number, b: number): number => {
    const channel = (v: number) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const bgLum = luminance(...([0, 2, 4].map((i) => parseInt(bg.slice(i, i + 2), 16)) as [number, number, number]));
  let max = 1;
  for (let y = 4; y < img.h - 4; y++) {
    for (let x = startX; x < img.w - 5; x++) {
      const p = (y * img.w + x) * img.nComp;
      const lum = luminance(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!);
      max = Math.max(max, (Math.max(lum, bgLum) + 0.05) / (Math.min(lum, bgLum) + 0.05));
    }
  }
  return max;
}

type Rgb = [number, number, number];

function contrast(a: Rgb, b: Rgb): number {
  const channel = (v: number) => ((v /= 255), v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (c: Rgb) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Background of an edit, its strongest text contrast, and with a selection the text contrast on the highlight.
function editColors(hwnd: number, path: string): { bg: string; text: number; selection: number } {
  if (!captureWindowToPng(hwnd, path)) throw new Error(`capture failed: ${path}`);
  const img = loadPng(path);
  const at = (x: number, y: number): Rgb => {
    const p = (y * img.w + x) * img.nComp;
    return [img.data[p]!, img.data[p + 1]!, img.data[p + 2]!];
  };
  const key = (c: Rgb) => c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const rgb = (k: string) => k.match(/../g)!.map((h) => parseInt(h, 16)) as Rgb;
  const counts = new Map<string, number>();
  for (let y = 2; y < img.h - 2; y++) {
    for (let x = 2; x < img.w - 2; x++) counts.set(key(at(x, y)), (counts.get(key(at(x, y))) ?? 0) + 1);
  }
  const [bg, highlight] = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));
  const minSelectionPixels = 50;
  const sel = highlight && highlight.n >= minSelectionPixels ? highlight.k : "";
  let [left, right] = [img.w, -1];
  for (let y = 2; y < img.h - 2 && sel; y++) {
    for (let x = 2; x < img.w - 2; x++) {
      if (key(at(x, y)) === sel) [left, right] = [Math.min(left, x), Math.max(right, x)];
    }
  }
  const bgRgb = rgb(bg!.k);
  const selRgb = sel ? rgb(sel) : bgRgb;
  // the caret is drawn by inverting what is under it
  const caret = new Set([bgRgb, selRgb].map((c) => key(c.map((v) => 255 - v) as Rgb)));
  let [text, selection] = [1, 1];
  for (let y = 2; y < img.h - 2; y++) {
    for (let x = 2; x < img.w - 2; x++) {
      if (caret.has(key(at(x, y)))) continue;
      const inside = x >= left && x <= right;
      if (inside) selection = Math.max(selection, contrast(at(x, y), selRgb));
      else text = Math.max(text, contrast(at(x, y), bgRgb));
    }
  }
  return { bg: bg!.k, text, selection: sel ? selection : 0 };
}

// The chapter box keeps the control background while focused, selected or disabled.
async function checkChapterEdit(): Promise<void> {
  const dir = tmpPath("theme-control-background-chapter");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en
Theme = Light
ShowChaptersInEbooks = true
RestoreSession = false
ShowStartPage = false
` +
      `CheckForUpdates = false
Themes [
 [
 Name = Custom Test
 TextColor = #ffffff
 BackgroundColor = #193247
` +
      ` ControlBackgroundColor = #52739b
 LinkColor = #ffffff
 ColorizeControls = true
 ]
]
`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, join(ROOT, "tests", "issue-6095.epub")]);
  try {
    await client.waitForRenderIdle();
    for (const theme of ["Light", "Dracula", "Solarized Dark", "Custom Test"]) {
      const res = await client.request(ControlCommand.TestInvokeCommand, [`CmdSetTheme ${theme}`]);
      if (res[0] !== 0) throw new Error(`chapter theme change failed: ${theme}: ${res[1]}`);
      await sleep(300);
      const boxes: number[] = [];
      enumChildWindows(frame, (hwnd) => {
        const toolbar = getClassName(getParentWindow(hwnd)) === "SUMATRA_VIRT_TOOLBAR";
        if (getClassName(hwnd) === "Edit" && isWindowVisible(hwnd) && toolbar) boxes.push(hwnd);
        return true;
      });
      if (boxes.length !== 2) throw new Error(`${theme}: expected chapter and page boxes, got ${boxes.length}`);
      const [chapter, page] = boxes.sort((a, b) => getWindowRect(a).left - getWindowRect(b).left) as [number, number];
      const want = theme === "Custom Test" ? "52739b" : editColors(page, join(dir, "page.png")).bg;
      const expect = (state: string, minText: number, minSelection = 0) => {
        const c = editColors(chapter, join(dir, `chapter-${state}.png`));
        const failed = c.bg !== want || c.text < minText || c.selection < minSelection;
        const got = `bg=${c.bg} text=${c.text.toFixed(2)} selection=${c.selection.toFixed(2)}`;
        if (failed) throw new Error(`${theme} chapter ${state}: ${got}, expected bg=${want}`);
        console.log(`${theme} chapter ${state}: ${got}`);
      };
      const minContrast = 3;
      expect("normal", minContrast);
      await activateTestFrame(client);
      await clickAt(chapter, 4, Math.floor(getClientRect(chapter).bottom / 2));
      if (getFocusedHwnd(frame) !== chapter) throw new Error(`${theme}: chapter box did not receive focus`);
      const EM_SETSEL = 0xb1;
      sendMessage(chapter, EM_SETSEL, 9, 9);
      await sleep(100);
      expect("focused", minContrast);
      sendMessage(chapter, EM_SETSEL, 0, -1);
      await sleep(100);
      expect("selected", 0, minContrast);
      // the app disables only an empty box; the native edit grays disabled text
      sendMessage(chapter, EM_SETSEL, 9, 9);
      enableWindow(chapter, false);
      await sleep(100);
      expect("disabled", 0);
      enableWindow(chapter, true);
      await activateTestFrame(client);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

function edits(frame: number): number[] {
  const toolbar: number[] = [];
  const sidebar: number[] = [];
  enumChildWindows(frame, (hwnd) => {
    if (getClassName(hwnd) !== "Edit" || !isWindowVisible(hwnd)) return true;
    const parent = getClassName(getParentWindow(hwnd));
    if (parent === "SUMATRA_VIRT_TOOLBAR") toolbar.push(hwnd);
    if (parent === "Static") sidebar.push(hwnd);
    return true;
  });
  sidebar.sort((a, b) => getWindowRect(a).top - getWindowRect(b).top);
  if (toolbar.length !== 1 || sidebar.length !== 2) {
    throw new Error(`expected page and two sidebar edits, got ${toolbar.length} and ${sidebar.length}`);
  }
  return [...toolbar, ...sidebar];
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP theme-control-background: ng draws its own controls");
    return;
  }
  const dir = tmpPath("theme-control-background");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "outline.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nTheme = Dracula\nShowToc = true\nShowFavorites = true\nRestoreSession = false\n` +
      `CheckForUpdates = false\nDocumentColorsFollowTheme = smart\nThemes [\n [\n Name = Custom Test\n` +
      ` TextColor = #ffffff\n BackgroundColor = #193247\n ControlBackgroundColor = #52739b\n` +
      ` LinkColor = #ffffff\n ColorizeControls = true\n ]\n]\n`,
  );

  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    const check = (theme: string, expected?: string): string => {
      const canvas = pixel(findCanvas(frame), join(dir, "canvas.png"));
      const want = expected ?? canvas;
      const colors = edits(frame).map((h, i) => pixel(h, join(dir, `edit-${i}.png`)));
      if (colors.some((c) => c !== want)) {
        throw new Error(`${theme}: canvas=${canvas}, edits=${colors.join(",")}, expected=${want}`);
      }
      console.log(`${theme}: canvas=${canvas}, edits=${colors.join(",")}`);
      return canvas;
    };
    const setMode = async (key: number): Promise<void> => {
      const res = await client.request(ControlCommand.TestInvokeCommand, ["CmdSetDocumentColorsFollowTheme"]);
      if (res[0] !== 0) throw new Error(`color mode dialog failed: ${res[1]}`);
      let dialog = 0;
      for (let i = 0; i < 40 && !dialog; i++) {
        enumWindows((hwnd) => {
          if (getWindowPid(hwnd) === proc.pid && getWindowText(hwnd) === "Make Document Colors Follow Theme") {
            dialog = hwnd;
          }
          return !dialog;
        });
        if (!dialog) await sleep(50);
      }
      const combo = findChildWindow(dialog, "ComboBox");
      if (!combo) throw new Error("color mode combo missing");
      sendMessage(combo, WM_KEYDOWN, key, 0);
      sendMessage(combo, WM_KEYUP, key, 0);
      const dialogBg = pixel(dialog, join(dir, `mode-${key}.png`), "dialog");
      const canvas = pixel(findCanvas(frame), join(dir, "mode-canvas.png"));
      if (dialogBg !== canvas) throw new Error(`mode preview dialog=${dialogBg}, canvas=${canvas}`);
      postMessage(dialog, WM_KEYDOWN, VK_RETURN, 0);
      await sleep(300);
    };
    for (const theme of [
      "Dracula",
      "Greeny",
      "Solarized Dark",
      "Light Warm",
      "Dark",
      "Light",
      "Light Gray",
      "Dark from 3.5",
      "Charcoal",
      "Solarized Light",
      "Nebula",
      "Choco",
      "Choco Navy",
      "Purpy",
      "Purpy Slate",
      "One Dark",
      "Monokai",
      "Nord",
      "GitHub Dark",
      "Catppuccin Mocha",
      "Tokyo Night",
      "Gruvbox",
      "Night Owl",
      "Ayu",
      "Palenight",
      "Catppuccin Latte",
      "Catppuccin Frappe",
      "Catppuccin Macchiato",
      "Gruvbox Light",
      "Everforest Light",
      "Rose Pine Dawn",
      "Sepia",
      "Custom Test",
    ]) {
      const res = await client.request(ControlCommand.TestInvokeCommand, [`CmdSetTheme ${theme}`]);
      if (res[0] !== 0) throw new Error(`theme change failed: ${theme}: ${res[1]}`);
      await sleep(300);
      const canvas = check(theme, theme === "Custom Test" ? "52739b" : undefined);
      if (theme === "Greeny" || theme === "Solarized Dark") {
        const sidebar = edits(frame).slice(1);
        for (const [i, hwnd] of sidebar.entries()) {
          const contrast = maxCueContrast(hwnd, join(dir, `cue-${i}.png`), canvas);
          if (contrast < 3) throw new Error(`${theme}: search cue contrast ${contrast.toFixed(2)} is too low`);
        }
      }
      if (theme === "Greeny") {
        const edit = edits(frame)[1]!;
        await activateTestFrame(client);
        const rc = getClientRect(edit);
        await clickAt(edit, 10, Math.floor(rc.bottom / 2));
        if (getFocusedHwnd(frame) !== edit) throw new Error("bookmark search did not receive focus");
        const focused = maxCueContrast(edit, join(dir, "cue-focused.png"), canvas, 25);
        if (focused >= 3) throw new Error(`focused search still shows its cue: ${focused.toFixed(2)}`);
        sendText(edit, "x");
        if (sendMessage(edit, WM_GETTEXTLENGTH, 0, 0) !== 1n) throw new Error("bookmark search did not accept text");
        sendText(edit, "");
        if (sendMessage(edit, WM_GETTEXTLENGTH, 0, 0) !== 0n) throw new Error("bookmark search did not clear");
        await activateTestFrame(client);
        await sleep(100);
        const contrast = maxCueContrast(edit, join(dir, "cue-cleared.png"), canvas);
        if (contrast < 3) throw new Error(`cleared search cue contrast ${contrast.toFixed(2)} is too low`);
      }
      if (theme === "Light Warm" || theme === "Light") {
        await setMode(VK_HOME); // smart -> off
        const off = check(`${theme} off`);
        if (off !== canvas) throw new Error(`${theme}: canvas changed in off mode`);
        await setMode(VK_DOWN); // off -> smart
        const restored = check(`${theme} smart`);
        if (restored !== canvas) throw new Error(`${theme}: canvas did not return to smart mode`);
      }
      if (theme === "Light") {
        const res = await client.request(ControlCommand.TestInvokeCommand, ["CmdAdvancedSettings"]);
        if (res[0] !== 0) throw new Error(`advanced settings failed: ${res[1]}`);
        const dialog = await waitToolWindow(client, proc.pid!, "advanced-settings", { title: "Advanced Settings" });
        const filter = findChildWindow(dialog, "Edit");
        if (!filter) throw new Error("advanced settings filter missing");
        sendText(filter, "DocumentColorsFollowTheme");
        postMessage(filter, WM_KEYDOWN, VK_DOWN, 0);
        await sleep(100);
        postMessage(dialog, WM_KEYDOWN, VK_RETURN, 0);
        await sleep(200);
        const combo = findChildWindow(dialog, "ComboBox");
        if (!combo) throw new Error("advanced settings color mode missing");
        sendMessage(combo, WM_KEYDOWN, VK_HOME, 0);
        sendMessage(combo, WM_KEYUP, VK_HOME, 0);
        await sleep(100);
        const preview = pixel(findCanvas(frame), join(dir, "advanced-canvas.png"));
        const dialogBg = pixel(dialog, join(dir, "advanced-dialog.png"), "dialog");
        const listBg = pixel(dialog, join(dir, "advanced-list.png"), "list");
        if (preview !== canvas || dialogBg !== preview || listBg !== preview) {
          throw new Error(`advanced preview: canvas=${preview}, dialog=${dialogBg}, list=${listBg}`);
        }
        const cancel = await client.request(ControlCommand.TestAdvSettingsRows, ["cancel"]);
        if (cancel[0] !== 0) throw new Error(`advanced settings cancel failed: ${cancel[1]}`);
        await sleep(200);
        if (check("Light preview canceled") !== canvas) throw new Error("cancel did not restore canvas color");
      }
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
  await checkChapterEdit();
}

if (import.meta.main) {
  await runStandalone(testit);
}
