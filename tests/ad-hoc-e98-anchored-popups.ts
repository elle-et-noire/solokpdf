// E98-E100: popups that belong to a child window (toolbar hover drop-down,
// Home's About hover, the canvas infotip) are top-level windows in screen
// coordinates. They must show only while their window does and stay at their
// place next to it, whatever moved or hid it:
//
//   toolbar drop-down   frame moved, toolbar becomes the overlay -> moves along;
//                       overlay toolbar auto-hides, toolbar hidden -> gone;
//                       the cursor in it keeps the overlay toolbar
//   canvas infotip      link tip: cursor leaves the canvas -> gone
//                       Home's keyboard tip: frame moved, sidebar shifts the
//                       canvas -> moves along; frame minimized -> gone
//   Home About hover    frame moved -> moves along; Ctrl+Tab to a document -> gone
//   citation hover      frame moved -> moves along (same flaw, found by the audit)
//
// E110: popups their owner places from the canvas's content (find bar,
// Automatically Scroll and read-aloud bars, selection toolbar, comment card,
// Edit PDF annotation toolbar): frame moved -> moves along; sidebar shifts the
// canvas -> stays inside it and comes back with it; frame minimized -> gone,
// back at its place on restore, whether Windows or the anchor layer hid it
// (E121); hidden by its owner while minimized -> stays hidden (E124); another
// tab -> gone. E138: closed by Esc while minimized -> stays closed.
//
// E124: hovers (toolbar drop-down, About hover, citation hover, Edit PDF hover
// card) go with a minimize: they belong to the cursor.
//
// E137: the annotation toolbar's contents edit is still open, with its text
// and the focus, after a restore, whatever took the focus as the popups hid.
// E139: the focus moved to another window while minimized: the comment card
// closes and the contents edit commits, as for a click there.
//
// E140: popups the frame owns that aren't anchored (floating find window,
// annotation list) follow the same minimize rules: hidden with the frame, back
// at their place with their focus on restore, closed while minimized (Esc, their
// owner) -> stay closed.
//
// E142: with the focus gone to another app (`away`), the restore doesn't take it:
// the popup gets it back once the frame is activated. A focus loss delivered to an
// owner never moves the focus: not at once (an owner that moves it on WM_KILLFOCUS,
// `kill-moves-focus`), not later (the contents edit's commit, also after a click into
// another window without a minimize), also when another window takes the focus as
// the frame is restored, before the layer's sync. The other window's page box keeps
// its caret. Floating popups: find window, annotation list, command palette.
//
// E143: the other windows the frame owns (keyboard help, Merge PDF, a PDF tool dialog)
// follow the same rules; Properties, which it doesn't own, stays on screen. A dialog of
// a class not the app's (MessageBox, file dialog) is like another app: it keeps the
// focus through the restore, no loss is delivered, the popup gets the focus back after.
//
// E145: one waiting for the restore stays off screen when WS_VISIBLE is set without a
// show (WM_SETREDRAW TRUE, a style write).
//
// E148: a modal dialog, its frame disabled, loses the activation to another app as it
// hides with the frame; the restore leaves it there until the user activates the app.
//
// E147: a tip (toolbar, bookmarks tree, About hover link) goes with a minimize and is not
// back on restore. Modal Add Favorite and Zoom go and come back as Run PDF Script does,
// whose example pick runs for real with examples the test writes.
//
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e98-anchored-popups.ts --no-build

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient, waitForHome } from "./control.ts";
import { makePdf as makeRefPdf, waitFor as waitRefPopup } from "./issue-6252.ts";
import { assemblePdf, cmdId, pollUntil, ROOT, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  clientToScreen,
  enumWindows,
  findChildWindow,
  getClassName,
  getClientRect,
  getControlText,
  getForegroundWindow,
  getWindowLong,
  getWindowPid,
  getWindowRect,
  getWindowOwner,
  getWindowText,
  GWL_EXSTYLE,
  GWL_STYLE,
  isWindowVisible,
  MK_RBUTTON,
  packCoords,
  sendMessage,
  setProcessDpiAware,
  setTestWindowLayout,
  setWindowLong,
  setWindowPos,
  postChar,
  postMessage,
  sendText,
  showWindow,
  sleep,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  MK_LBUTTON,
  SW_SHOWMINNOACTIVE,
  SW_SHOWNOACTIVATE,
  SWP_NOACTIVATE,
  SWP_NOZORDER,
  VK_ESCAPE,
  WM_CLOSE,
  WM_KEYDOWN,
  WM_MOUSELEAVE,
  WM_MOUSEMOVE,
  WM_RBUTTONDOWN,
  WM_RBUTTONUP,
  WS_CAPTION,
} from "./winapi.ts";
import {
  activateTestFrame,
  clickAt,
  clickCanvasAway,
  findCanvas,
  findChildByClass,
  FRAME_CLASS,
  killAndWait,
  launchControlled,
  moveTestCursor,
  pressVKey,
  sendCommand,
  sendCommandSync,
} from "./win-automation.ts";

const TOOLBAR_CLASS = "SUMATRA_VIRT_TOOLBAR";
const MENU_CLASS = "SumatraToolbarHoverMenu";
const ABOUT_CLASS = "SUMATRA_ABOUT_HOVER";
const TIP_CLASS = "tooltips_class32";
const LINK_URL = "https://example.com/e100";
const N_FILES = 6;
const WS_EX_TOPMOST = 0x8;
const WS_VISIBLE = 0x10000000;
const SWP_NOSIZE = 0x0001;
const WM_SETCURSOR = 0x0020;
const HTCLIENT = 1;
const VK_RIGHT = 0x27;
const MOVE_DX = 60;
const MOVE_DY = 40;
const WAIT_MS = 3000;
// kDelayToolbarHide
const OVERLAY_HIDE_MS = 500;
const LOCK_HOLD_MS = 300;

type Box = { x: number; y: number; dx: number; dy: number };

export const failures: string[] = [];
// the running app's log
let gLog = "";

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

function logBytes(): Buffer {
  return gLog && existsSync(gLog) ? readFileSync(gLog) : Buffer.alloc(0);
}

// a step's failure is recorded, with what the app logged meanwhile, and the next step still runs
async function step(what: string, f: () => Promise<void>): Promise<void> {
  const logStart = logBytes().length;
  try {
    await f();
    console.log(`  ok: ${what}`);
  } catch (e) {
    failures.push(`${what}: ${(e as Error).message}`);
    console.log(`  FAILED: ${what}: ${(e as Error).message}`);
    const logged = logBytes().subarray(logStart).toString("utf8").trimEnd();
    console.log(logged ? `  app log:\n${logged}` : "  app log: (empty)");
  }
}

// launched with its log in gLog
async function launchLogged(name: string, args: string[]) {
  gLog = tmpPath(`${name}.log`);
  rmSync(gLog, { force: true });
  return await launchControlled(["-log-to-file", gLog, ...args]);
}

function box(hwnd: number): Box {
  const r = getWindowRect(hwnd);
  return { x: r.left, y: r.top, dx: r.right - r.left, dy: r.bottom - r.top };
}

const show = (b: Box | null) => (b ? `${b.x},${b.y} ${b.dx}x${b.dy}` : "none");

function shownTopWindow(pid: number, cls: string): number {
  let found = 0;
  enumWindows((h) => {
    if (getWindowPid(h) === pid && getClassName(h) === cls && isWindowVisible(h)) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

// the canvas infotip: the shown topmost tooltip with no owner (the toolbar's
// and the tabs' tips are owned by their windows). Another process can't read
// a tooltip's text.
function shownTip(pid: number, where: (h: number) => boolean = () => true): number {
  let found = 0;
  enumWindows((h) => {
    if (getWindowPid(h) !== pid || getClassName(h) !== TIP_CLASS || !isWindowVisible(h)) return true;
    if ((getWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) === 0 || getWindowOwner(h) !== 0) return true;
    if (!where(h)) return true;
    found = h;
    return false;
  });
  return found;
}

// the shown tooltips, for a failure message
function describeTips(pid: number): string {
  const out: string[] = [];
  enumWindows((h) => {
    if (getWindowPid(h) === pid && getClassName(h) === TIP_CLASS && isWindowVisible(h)) {
      out.push(`${show(box(h))} owner=${getWindowOwner(h)}`);
    }
    return true;
  });
  return out.join("; ") || "no tooltips";
}

let gPid = 0;

export async function waitShown(find: () => number, what: string): Promise<number> {
  return await pollUntil(find, (h) => h !== 0, {
    timeoutMs: WAIT_MS,
    error: () => `${what}: not shown (${describeTips(gPid)})`,
  });
}

export async function waitGone(find: () => number, what: string): Promise<void> {
  const h = await pollUntil(find, (v) => v === 0, {
    timeoutMs: WAIT_MS,
    error: (v) => `${what}: still shown at ${show(box(v))}`,
  });
  check(h === 0, what);
}

// the popup is at `want`, give or take a pixel
async function waitAt(find: () => number, want: Box, what: string): Promise<void> {
  const near = (b: Box) => Math.abs(b.x - want.x) <= 1 && Math.abs(b.y - want.y) <= 1;
  await pollUntil(
    () => {
      const h = find();
      return h ? box(h) : null;
    },
    (b) => !!b && near(b),
    { timeoutMs: WAIT_MS, error: (b) => `${what}: at ${show(b)}, want ${show(want)}` },
  );
}

const moved = (b: Box, dx: number, dy: number): Box => ({ ...b, x: b.x + dx, y: b.y + dy });

function moveFrame(frame: number, dx: number, dy: number): void {
  const r = getWindowRect(frame);
  setWindowPos(frame, r.left + dx, r.top + dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

// the frame moved by MOVE_DX, MOVE_DY while f runs, as Win+arrow or a drag does
async function whileFrameMoved(frame: number, f: () => Promise<void>, dx = MOVE_DX, dy = MOVE_DY): Promise<void> {
  moveFrame(frame, dx, dy);
  try {
    await f();
  } finally {
    moveFrame(frame, -dx, -dy);
  }
}

function makeLinkPdf(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] >>",
    `<< /Type /Annot /Subtype /Link /Rect [0 0 612 792] /Border [0 0 0] /A << /S /URI /URI (${LINK_URL}) >> >>`,
  ]);
}

// Home lists N_FILES documents, and the link document once it is open
function makeAppDir(): string {
  const dir = tmpPath("ad-hoc-e98");
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
    "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nRememberOpenedFiles = true\n" +
      `Theme = Light\nHomePageViewMode = thumbnails\nFileStates [\n${states.join("\n")}\n]\n`,
  );
  return dir;
}

async function mainButton(client: ControlClient, cmd: number): Promise<Box> {
  const raw = String((await client.request(ControlCommand.TestToolbarButtons, []))[1] ?? "");
  const re = /^idx=\d+ cmd=(\d+) hidden=(\d) rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (+m[1]! === cmd && m[2] === "0") {
      return { x: +m[3]!, y: +m[4]!, dx: +m[5]! - +m[3]!, dy: +m[6]! - +m[4]! };
    }
  }
  throw new Error(`no toolbar button for command ${cmd}`);
}

// E100: a link's tip goes when the cursor leaves the canvas from the link
async function checkLinkTipLeave(pid: number, client: ControlClient, frame: number, canvas: number): Promise<void> {
  const cr = getClientRect(canvas);
  const cx = Math.floor(cr.right / 2);
  const cy = Math.floor(cr.bottom / 2);
  const on = clientToScreen(canvas, cx, cy);
  await moveTestCursor(on.x, on.y, client);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(cx, cy));
  sendMessage(canvas, WM_SETCURSOR, canvas, packCoords(HTCLIENT, WM_MOUSEMOVE));
  await waitShown(() => shownTip(pid), "link tip");

  // onto the toolbar, which says nothing to the canvas
  const toolbar = findChildByClass(frame, TOOLBAR_CLASS);
  const tr = getClientRect(toolbar);
  const off = clientToScreen(toolbar, 4, Math.floor(tr.bottom / 2));
  await moveTestCursor(off.x, off.y, client);
  sendMessage(toolbar, WM_MOUSEMOVE, 0, packCoords(4, Math.floor(tr.bottom / 2)));
  await waitGone(() => shownTip(pid), "link tip after the cursor left the canvas");
}

// E98: the drop-down moves with the frame and the toolbar, and goes with the
// toolbar. CmdToggleToolbar cycles shown -> overlay (auto-hides) -> hidden.
async function checkToolbarDropdown(pid: number, client: ControlClient, frame: number, canvas: number): Promise<void> {
  const toolbar = findChildByClass(frame, TOOLBAR_CLASS);
  check(toolbar !== 0, "no toolbar");
  const find = () => shownTopWindow(pid, MENU_CLASS);
  const cr = getClientRect(canvas);

  // right-click the Zoom In button: a sticky drop-down, no close timer
  const openMenu = async () => {
    const b = await mainButton(client, cmdId("CmdZoomIn"));
    const x = b.x + Math.floor(b.dx / 2);
    const y = b.y + Math.floor(b.dy / 2);
    const s = clientToScreen(toolbar, x, y);
    await moveTestCursor(s.x, s.y, client);
    sendMessage(toolbar, WM_RBUTTONDOWN, MK_RBUTTON, packCoords(x, y));
    sendMessage(toolbar, WM_RBUTTONUP, 0, packCoords(x, y));
    return await waitShown(find, "zoom drop-down");
  };
  // the cursor on the canvas: x, y in canvas client coordinates
  const cursorOnCanvas = async (x: number, y: number) => {
    const s = clientToScreen(canvas, x, y);
    await moveTestCursor(s.x, s.y, client);
    sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(x, y));
  };
  // the drop-down's place from the toolbar's
  const offset = (menu: number) => {
    const m = getWindowRect(menu);
    const t = getWindowRect(toolbar);
    return { x: m.left - t.left, y: m.top - t.top };
  };

  await step("toolbar drop-down: frame moved", async () => {
    const before = box(await openMenu());
    await whileFrameMoved(frame, () => waitAt(find, moved(before, MOVE_DX, MOVE_DY), "drop-down, frame moved"));
    await waitAt(find, before, "drop-down after the frame moved back");
  });

  await checkHoverMinimized(client, "toolbar drop-down", find, async () => {
    await openMenu();
  });

  await step("toolbar drop-down: overlay toolbar", async () => {
    const menu = find() || (await openMenu());
    const o0 = offset(menu);
    const t0 = getWindowRect(toolbar);
    sendCommandSync(frame, cmdId("CmdToggleToolbar"));
    await pollUntil(
      () => getWindowRect(toolbar).left,
      (x) => x !== t0.left,
      { timeoutMs: WAIT_MS, error: () => "the overlay toolbar did not move" },
    );
    const t = getWindowRect(toolbar);
    await waitAt(find, { ...box(menu), x: t.left + o0.x, y: t.top + o0.y }, "drop-down on the overlay toolbar");

    // the cursor in the drop-down keeps the overlay toolbar, and so the drop-down
    const m = box(find());
    await moveTestCursor(m.x + Math.floor(m.dx / 2), m.y + Math.floor(m.dy / 2), client);
    await sleep(OVERLAY_HIDE_MS * 2);
    check(isWindowVisible(toolbar) && find() !== 0, "the overlay toolbar hid with the cursor in its drop-down");

    // the cursor elsewhere: the toolbar auto-hides, the drop-down with it
    await cursorOnCanvas(Math.floor(cr.right / 2), Math.floor(cr.bottom / 2));
    await waitGone(find, "drop-down after the overlay toolbar auto-hid");
  });

  await step("toolbar drop-down: toolbar hidden", async () => {
    // reveal the overlay toolbar from the top of the canvas
    await cursorOnCanvas(Math.floor(cr.right / 2), 2);
    await pollUntil(
      () => isWindowVisible(toolbar),
      (v) => v,
      { timeoutMs: WAIT_MS, error: () => "the overlay toolbar did not show" },
    );
    await openMenu();
    sendCommandSync(frame, cmdId("CmdToggleToolbar"));
    await waitGone(find, "drop-down with the toolbar hidden");
  });
  sendCommandSync(frame, cmdId("CmdToggleToolbar"));
}

// E100: Home's keyboard-selection tip stays under the selected entry
async function checkHomeTip(pid: number, client: ControlClient, frame: number, canvas: number): Promise<void> {
  await activateTestFrame(client);
  const away = clientToScreen(canvas, 1, 1);
  await moveTestCursor(away.x, away.y, client);
  sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(1, 1));
  sendMessage(canvas, WM_KEYDOWN, VK_RIGHT, 0);
  await waitForHome(client, (s) => s.sel >= 0 && s.selShown, "no keyboard selection");
  const find = () => shownTip(pid);
  await waitShown(find, "Home selection tip");

  // the selected entry's outline, on screen
  const outline = async (): Promise<Box> => {
    const s = await client.homeSelection();
    const [x, y, dx, dy] = s.selRect;
    const o = clientToScreen(canvas, x!, y!);
    return { x: o.x, y: o.y, dx: dx!, dy: dy! };
  };
  const gapY = box(find()).y - (await outline()).y;
  // E113: Home places the tip again from the entry: just below it, starting at
  // its left edge or shifted left to stay inside the row and the work area
  const waitUnder = async (what: string) => {
    let last = "";
    await pollUntil(
      async () => {
        const h = find();
        const o = await outline();
        const b = h ? box(h) : null;
        last = `tip at ${show(b)}, entry at ${show(o)}`;
        return !!b && Math.abs(b.y - o.y - gapY) <= 1 && b.x <= o.x + 1 && b.x + b.dx > o.x;
      },
      (ok) => ok,
      { timeoutMs: WAIT_MS, error: () => `${what}: ${last}` },
    );
  };

  await step("Home tip: frame moved", async () => {
    await whileFrameMoved(frame, () => waitUnder("Home tip, frame moved"));
    await waitUnder("Home tip after the frame moved back");
  });

  await step("Home tip: sidebar shifts the canvas", async () => {
    const c0 = getWindowRect(canvas).left;
    sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    try {
      await pollUntil(
        async () => getWindowRect(canvas).left,
        (x) => x !== c0,
        { timeoutMs: WAIT_MS, error: () => "the favorites sidebar did not shift the canvas" },
      );
      await waitUnder("Home tip with the sidebar shown");
    } finally {
      sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    }
  });

  await step("Home tip: frame minimized", async () => {
    if (!find()) sendMessage(canvas, WM_KEYDOWN, VK_RIGHT, 0);
    showWindow(frame, SW_SHOWMINNOACTIVE);
    try {
      await waitGone(() => shownTip(pid), "Home tip with the frame minimized");
    } finally {
      showWindow(frame, SW_SHOWNOACTIVATE);
    }
  });
}

// E99: the About hover moves with the frame and goes with Home
async function checkAboutHover(pid: number, client: ControlClient, frame: number, canvas: number): Promise<void> {
  const find = () => shownTopWindow(pid, ABOUT_CLASS);
  const hoverLogo = async () => {
    const s = await client.homeSelection();
    const [lx, ly, ldx, ldy] = s.logo;
    const x = lx! + Math.floor(ldx! / 2);
    const y = ly! + Math.floor(ldy! / 2);
    const p = clientToScreen(canvas, x, y);
    await moveTestCursor(p.x, p.y, client);
    sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(x, y));
  };
  // onto the logo from off it: the hover opens as the cursor enters the logo
  const enterLogo = async () => {
    const off = clientToScreen(canvas, 1, 1);
    await moveTestCursor(off.x, off.y, client);
    sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(1, 1));
    await hoverLogo();
  };
  await hoverLogo();
  const before = box(await waitShown(find, "About hover"));

  await step("About hover: frame moved", async () => {
    // the cursor rides along on the logo, which keeps the hover up
    await whileFrameMoved(frame, async () => {
      await hoverLogo();
      await waitAt(find, moved(before, MOVE_DX, MOVE_DY), "About hover, frame moved");
    });
    await hoverLogo();
    await waitAt(find, before, "About hover after the frame moved back");
  });

  await checkHoverMinimized(client, "About hover", find, enterLogo);

  await step("About hover: Ctrl+Tab to a document", async () => {
    if (!find()) await enterLogo();
    await waitShown(find, "About hover");
    sendCommandSync(frame, cmdId("CmdPrevTab"));
    await waitGone(find, "About hover over the document");
  });
}

// the citation hover popup, opened by TestRefHover (see issue-6252)
async function checkRefHover(): Promise<void> {
  const dir = tmpPath("ad-hoc-e98-refhover");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makeRefPdf(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nCitationHoverDelay = 100\n");
  const { proc, client, frame } = await launchLogged("e98-ref", ["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const cr = getClientRect(findCanvas(frame));
    const at = ["show", Math.floor(cr.right / 2), Math.floor(cr.bottom / 3)];
    // E120: a render holds PDFium's lock meanwhile; the hover looks again once it's free
    const held = await client.request(ControlCommand.TestCurrentPdf, ["hold-pdfium-lock", LOCK_HOLD_MS]);
    check(held[0] === 0 || process.env.SOLOKPDF_ENGINE === "mupdf", `hold-pdfium-lock: ${held[1]}`);
    const res = await client.request(ControlCommand.TestRefHover, at);
    check(res[0] === 0, `could not show the citation popup: ${res[1]}`);
    const p = await waitRefPopup(client, "the citation popup did not open", (q) => q.visible && q.hwnd !== 0);
    const find = () => (isWindowVisible(p.hwnd) ? p.hwnd : 0);
    await step("citation hover: frame moved", async () => {
      const before = box(p.hwnd);
      await whileFrameMoved(frame, () => waitAt(find, moved(before, MOVE_DX, MOVE_DY), "citation popup, frame moved"));
      await waitAt(find, before, "citation popup after the frame moved back");
    });
    await checkHoverMinimized(client, "citation hover", find, async () => {
      const again = await client.request(ControlCommand.TestRefHover, at);
      check(again[0] === 0, `could not show the citation popup: ${again[1]}`);
    });
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// E110: popups placed by their owner from the canvas's content
export const SEL_CLASS = "SumatraSelectionToolbar";
export const EDIT_CLASS = "SumatraAnnotEditToolbar";
const CARD_CLASS = "SumatraAnnotTextPopup";
const HOVER_CARD_CLASS = "SumatraAnnotationHoverOverlay";
const BAR_CLASS = "SumatraWgDefaultWinClass";
const COMBO_CLASS = "ComboBox";
const FILTER_CLASS = "SUMATRA_ANNOT_FILTER_WND";
const VK_END = 0x23;
const E110_LINE = "The quick brown fox jumps over the lazy dog";

// a line of text, a highlighted one off the selection, and a square with a comment
export function makeE110Pdf(): string {
  const text = `BT /F1 18 Tf 72 700 Td (${E110_LINE}) Tj 0 -60 Td (Pack my box with five dozen jugs) Tj ET`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> " +
      "/Contents 5 0 R /Annots [6 0 R 7 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Annot /Subtype /Square /Rect [72 300 300 450] /C [1 0 0] /Contents (a comment) >>",
    "<< /Type /Annot /Subtype /Highlight /Rect [72 634 380 658] /QuadPoints [72 658 380 658 72 634 380 634] " +
      "/C [1 1 0] >>",
  ]);
}

export function shownTop(pid: number, cls: string, ok: (h: number) => boolean = () => true): number {
  let found = 0;
  enumWindows((h) => {
    if (getWindowPid(h) === pid && getClassName(h) === cls && isWindowVisible(h) && ok(h)) {
      found = h;
      return false;
    }
    return true;
  });
  return found;
}

// the compact find bar: the frame's popup holding the search field
export function shownFindBar(pid: number, frame: number): number {
  return shownTop(pid, BAR_CLASS, (h) => getWindowOwner(h) === frame && findChildByClass(h, COMBO_CLASS) !== 0);
}

async function barHwnd(client: ControlClient, cmd: ControlCommand): Promise<number> {
  const res = await client.request(cmd, []);
  const m = /^OK visible=1 .*hwnd=(\d+)/m.exec(String(res[1] ?? ""));
  return m && isWindowVisible(+m[1]!) ? +m[1]! : 0;
}

// a point of an annotation, fx across and half way down, in canvas
// coordinates, once it is on screen
export async function annotPoint(client: ControlClient, type: string, fx = 0.5): Promise<{ x: number; y: number }> {
  let raw = "";
  const re = new RegExp(`type=${type}(?:(?!type=)[\\s\\S])*?screen=(-?\\d+),(-?\\d+),(\\d+),(\\d+)`);
  const r = await pollUntil(
    async () => {
      raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
      return re.exec(raw);
    },
    (m) => !!m && +m[3]! > 0,
    { timeoutMs: WAIT_MS, error: () => `the ${type} is not on screen\n${raw}` },
  );
  return { x: +r![1]! + Math.floor(+r![3]! * fx), y: +r![2]! + Math.floor(+r![4]! / 2) };
}

// the popup is within the canvas's width
async function waitInCanvas(find: () => number, canvas: number, what: string): Promise<void> {
  await pollUntil(
    () => {
      const h = find();
      return h ? box(h) : null;
    },
    (b) => {
      const c = getWindowRect(canvas);
      return !!b && b.x >= c.left && b.x + b.dx <= c.right;
    },
    { timeoutMs: WAIT_MS, error: (b) => `${what}: at ${show(b)}, canvas ${show(box(canvas))}` },
  );
}

// on the UI thread, so the order Windows and the anchor layer act in is fixed.
// "away": the focus leaves the app as the popups hide, as on an interactive
// desktop, where Windows activates another window then (E136). "frame": it
// moves to the frame (E137), or out of the app if a modal dialog disabled it (E148)
export async function minimizeFrame(client: ControlClient, order: string, focus = "", trace = ""): Promise<string> {
  const res = await client.request(ControlCommand.TestMinimizeFrame, [order, focus, trace]);
  check(res[0] === 0, `TestMinimizeFrame ${order}: ${res[1]}`);
  check(order !== "anchor-first" || !/reshown=0\b/.test(String(res[1])), `${order}: nothing shown while minimized`);
  check(
    focus !== "frame" || /toFrame=[1-9]|leftApp=[1-9]/.test(String(res[1])),
    `${order}: the focus did not leave the hidden popup: ${res[1]}`,
  );
  return String(res[1]);
}

// E121: Windows hides them before the frame goes iconic; shown again while it
// is minimized, the anchor layer sees them first. "away": E136
const MINIMIZE_WAYS = ["os-first", "anchor-first"].flatMap((order) => [
  { order, focus: "", how: order },
  { order, focus: "away", how: `${order}, focus left the app` },
]);

// for a popup with the focus, also where the focus moves to the frame (E137)
const FOCUS_WAYS = [
  ...MINIMIZE_WAYS,
  ...["os-first", "anchor-first"].map((order) => ({
    order,
    focus: "frame",
    how: `${order}, focus moved to the frame`,
  })),
];

enum AwayCheck {
  // the focus that left the app stays there through the restore (E142)
  Kept,
  // `during` gave the frame the focus
  Skip,
}

type ForegroundFixture = { client: ControlClient; frame: number };

function checkForeground(hwnd: number, what: string): void {
  const actual = getForegroundWindow();
  check(actual === hwnd, `${what}: expected foreground ${hwnd}, got ${actual}`);
}

// minimized, `during` runs, restored. The anchor layer's syncs, posted by the
// restore, run before the next request: one Windows shows again only for its
// owner to hide is not back when it returns
async function minimizedAndRestored(
  client: ControlClient,
  way: { order: string; focus: string },
  find: () => number,
  what: string,
  during: () => Promise<void> = async () => {},
  away = AwayCheck.Kept,
  duringTrace = "",
  foreground?: ForegroundFixture,
): Promise<void> {
  let minimized = "";
  let trace = "";
  try {
    minimized = await minimizeFrame(client, way.order, way.focus);
    await waitGone(find, `${what} with the frame minimized`);
    if (foreground) {
      await activateTestFrame(foreground.client);
      checkForeground(foreground.frame, `${what} before changing the hidden window`);
    }
    trace = duringTrace;
    await during();
  } finally {
    await minimizeFrame(client, "restore", "", trace);
  }
  if (foreground) {
    await client.request(ControlCommand.Ping, []);
    checkForeground(foreground.frame, `${what} after restoring the frame`);
    await client.request(ControlCommand.TestFocusState, ["activate"]);
    await client.request(ControlCommand.Ping, []);
    return;
  }
  // E148: its frame disabled by a modal dialog, Windows gave the activation to another app
  const leftApp = /leftApp=[1-9]/.test(minimized);
  if ((way.focus !== "away" && !leftApp) || away === AwayCheck.Skip) {
    await client.request(ControlCommand.Ping, []);
    return;
  }
  // E142: another app keeps the focus until the user activates the frame
  const res = await focusState(client);
  const other = way.focus === "away" ? / active=(away|other-window)$/ : /^focus=none active=none$/;
  check(other.test(res), `${what}: the restore took the focus from another app: ${res}`);
  await client.request(ControlCommand.TestFocusState, ["activate"]);
  await client.request(ControlCommand.Ping, []);
}

export async function focusState(client: ControlClient, action = ""): Promise<string> {
  return String((await client.request(ControlCommand.TestFocusState, [action]))[1] ?? "");
}

// another of the app's windows; cmd: CmdNewWindow or CmdDuplicateInNewWindow, which has a page box
async function openOtherWindow(client: ControlClient, frame: number, cmd: string): Promise<number> {
  await client.request(ControlCommand.TestInvokeCommand, [cmd]);
  return await pollUntil(
    () => shownTop(getWindowPid(frame), FRAME_CLASS, (h) => h !== frame),
    (h) => h !== 0,
    { timeoutMs: WAIT_MS, error: "no new window" },
  );
}

// closed, and the frame under test active again
async function closeOtherWindow(client: ControlClient, other: number): Promise<void> {
  if (other) {
    postMessage(other, WM_CLOSE, 0, 0);
    await pollUntil(
      () => isWindowVisible(other),
      (v) => !v,
      { timeoutMs: WAIT_MS, error: "the new window did not close" },
    );
  }
  await activateFrame(client);
}

// the frame under test active; its popups may take the focus back
export async function activateFrame(client: ControlClient): Promise<void> {
  await focusState(client, "activate");
  const res = await focusState(client);
  check(!/ active=(other-window|away)$/.test(res), `the frame under test did not activate: ${res}`);
}

// another window open while f runs, the frame under test active
export async function withOtherWindow(
  client: ControlClient,
  frame: number,
  cmd: string,
  f: () => Promise<void>,
): Promise<void> {
  let other = 0;
  try {
    other = await openOtherWindow(client, frame, cmd);
    await activateFrame(client);
    await f();
  } finally {
    await closeOtherWindow(client, other);
  }
}

// E142: the focus another window took stays there, after the posted reactions to the loss
async function checkFocusInOther(client: ControlClient, what: string): Promise<void> {
  await client.request(ControlCommand.Ping, []);
  const res = await focusState(client, "detail");
  check(/^focus=other-window active=other-window /.test(res), `${what}: the focus left the other window: ${res}`);
  check(/ killMoved=0\b/.test(res), `${what}: its owner moved the focus on the loss: ${res}`);
}

// E142: the focus goes straight to the other window's page box, which shows a caret
async function focusOtherPageBox(client: ControlClient, what: string): Promise<void> {
  await pollUntil(
    () => focusState(client, "page-edit-last"),
    (r) => r.startsWith("focus=other-window "),
    { timeoutMs: WAIT_MS, error: (r) => `${what}: the other window's page box has no focus: ${r}` },
  );
  const res = await focusState(client, "detail");
  check(/ caret=focus /.test(res), `${what}: the page box lost its caret: ${res}`);
}

// E124: the popup's owner hides it the way the user's actions reach it
export async function hideByOwner(client: ControlClient, popup: string): Promise<void> {
  const res = await client.request(ControlCommand.TestMinimizeFrame, ["hide", popup]);
  check(res[0] === 0, `hide ${popup}: ${res[1]}`);
}

// E139: while the frame is minimized, a new window takes the focus as a click
// on it does; `after` runs once the frame is restored without activating it
async function focusOtherWindow(
  client: ControlClient,
  frame: number,
  way: { order: string; focus: string },
  find: () => number,
  what: string,
  after: () => Promise<void>,
): Promise<void> {
  let other = 0;
  try {
    await minimizedAndRestored(client, way, find, what, async () => {
      other = await openOtherWindow(client, frame, "CmdNewWindow");
      const res = await focusState(client, "activate-last");
      check(res.includes("focus=other-window "), `the new window has no focus: ${res}`);
    });
    await after();
  } finally {
    await closeOtherWindow(client, other);
  }
}

// a hover goes with a minimize and is not back on restore (E124)
async function checkHoverMinimized(
  client: ControlClient,
  name: string,
  find: () => number,
  show: () => Promise<void>,
  ways = MINIMIZE_WAYS,
): Promise<void> {
  for (const way of ways) {
    await step(`${name}: frame minimized, ${way.how}`, async () => {
      if (!find()) await show();
      await waitShown(find, name);
      await minimizedAndRestored(client, way, find, name);
      check(find() === 0, `${name} came back after the frame was restored`);
    });
  }
}

type Followed = {
  name: string;
  find: () => number;
  open: () => Promise<void>;
  // with the sidebar shown: inside the canvas, at the frame's edge, or closed
  // by the sidebar taking the focus
  sidebar: "inside" | "stays" | "closes";
  // TestFocusState's name for it when it has the focus, which it gets back on restore
  focus?: string;
  // TestMinimizeFrame "hide": its owner hides it
  hide: string;
  // Esc presses on the frame that close it
  esc?: number;
};

async function checkFollows(p: Followed, client: ControlClient, frame: number, canvas: number): Promise<void> {
  const shown = async () => {
    if (!p.find()) await p.open();
    return box(await waitShown(p.find, p.name));
  };

  // to the left: the find bar keeps inside the work area, at the frame's right
  await step(`${p.name}: frame moved`, async () => {
    const before = await shown();
    const want = moved(before, -MOVE_DX, MOVE_DY);
    await whileFrameMoved(frame, () => waitAt(p.find, want, `${p.name}, frame moved`), -MOVE_DX, MOVE_DY);
    await waitAt(p.find, before, `${p.name} after the frame moved back`);
  });

  await step(`${p.name}: sidebar shifts the canvas`, async () => {
    const before = await shown();
    const c0 = getWindowRect(canvas).left;
    sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    try {
      await pollUntil(
        () => getWindowRect(canvas).left,
        (x) => x !== c0,
        { timeoutMs: WAIT_MS, error: () => "the favorites sidebar did not shift the canvas" },
      );
      const what = `${p.name} with the sidebar shown`;
      if (p.sidebar === "inside") await waitInCanvas(p.find, canvas, what);
      if (p.sidebar === "stays") await waitAt(p.find, before, what);
      if (p.sidebar === "closes") await waitGone(p.find, what);
    } finally {
      sendCommandSync(frame, cmdId("CmdFavoriteToggle"));
    }
    if (p.sidebar !== "closes") await waitAt(p.find, before, `${p.name} after the sidebar hid`);
  });

  // whichever hid them, they come back, also when the focus left the app meanwhile (E136)
  for (const way of p.focus ? FOCUS_WAYS : MINIMIZE_WAYS) {
    await step(`${p.name}: frame minimized, ${way.how}`, async () => {
      const before = await shown(true);
      await minimizedAndRestored(client, way, p.find, p.name);
      await waitAt(p.find, before, `${p.name} after the frame was restored`);
      if (!p.focus) return;
      const res = String((await client.request(ControlCommand.TestFocusState, [""]))[1] ?? "");
      check(res.includes(`focus=${p.focus} `), `${p.name}'s focus after the frame was restored: ${res}`);
    });
  }

  // E139: the focus left for another window, its owner closes it, as for a click there
  for (const way of p.focus ? FOCUS_WAYS : []) {
    await step(`${p.name}: focus moved to another window while minimized, ${way.how}`, async () => {
      // opened now, with the focus
      if (p.find()) await hideByOwner(client, p.hide);
      await waitGone(p.find, p.name);
      await shown();
      await focusOtherWindow(client, frame, way, p.find, p.name, async () => {
        await clickCanvasAway(canvas);
        await waitGone(p.find, `${p.name} after a click away`);
      });
    });
  }

  // E124: hidden by its owner meanwhile, it stays hidden
  for (const way of MINIMIZE_WAYS) {
    await step(`${p.name}: hidden by its owner while minimized, ${way.how}`, async () => {
      await shown();
      await minimizedAndRestored(client, way, p.find, p.name, () => hideByOwner(client, p.hide));
      check(p.find() === 0, `${p.name} came back after its owner hid it`);
    });
  }

  // E138: its owner sees it shown while minimized, so Esc closes it then
  for (const way of p.esc ? MINIMIZE_WAYS : []) {
    await step(`${p.name}: closed by Esc while minimized, ${way.how}`, async () => {
      await shown();
      // keys reach the frame as if it had the focus, which a real Esc needs
      const esc = async () => {
        for (let i = 0; i < p.esc!; i++) pressVKey(frame, VK_ESCAPE);
      };
      await minimizedAndRestored(client, way, p.find, p.name, esc, AwayCheck.Skip);
      check(p.find() === 0, `${p.name} came back after Esc closed it`);
    });
  }

  await step(`${p.name}: another tab`, async () => {
    await shown();
    sendCommandSync(frame, cmdId("CmdNextTab"));
    try {
      await waitGone(p.find, `${p.name} over another tab`);
    } finally {
      sendCommandSync(frame, cmdId("CmdPrevTab"));
      await client.waitForRenderIdle();
    }
  });
}

const CONTENTS_TEXT = "kept through a minimize";

export async function annotToolbarDump(client: ControlClient): Promise<string> {
  const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
  return /annotEditToolbar .*/.exec(raw)?.[0] ?? "";
}

// the highlight selected, its toolbar's contents edit opened
export async function openContentsEdit(client: ControlClient, canvas: number, find: () => number): Promise<number> {
  const c = await annotPoint(client, "Highlight", 0.6);
  await clickAt(canvas, c.x, c.y, 0, 0, client);
  const tb = await waitShown(find, "annotation toolbar");
  const dump = await annotToolbarDump(client);
  const chip = /[=;]contents:(-?\d+),(-?\d+),(\d+),(\d+)/.exec(dump);
  check(!!chip, `no contents chip: ${dump}`);
  const r = getWindowRect(tb);
  const x = +chip![1]! - r.left + Math.floor(+chip![3]! / 2);
  const y = +chip![2]! - r.top + Math.floor(+chip![4]! / 2);
  await clickAt(tb, x, y, 0, 0, client);
  return await pollUntil(
    () => findChildByClass(tb, "Edit"),
    (h) => h !== 0,
    { timeoutMs: WAIT_MS, error: "the contents edit did not open" },
  );
}

// E137: a focus loss from the minimize doesn't commit and close the contents edit
async function checkContentsEdit(pid: number, client: ControlClient, frame: number, canvas: number): Promise<void> {
  const name = "annotation toolbar contents edit";
  const find = () => shownTop(pid, EDIT_CLASS);
  let edit = 0;
  await step(`${name}: opened`, async () => {
    edit = await openContentsEdit(client, canvas, find);
    sendText(edit, CONTENTS_TEXT);
  });
  if (!edit) return;
  for (const way of FOCUS_WAYS) {
    await step(`${name}: frame minimized, ${way.how}`, async () => {
      await minimizedAndRestored(client, way, find, name);
      const dump = await annotToolbarDump(client);
      check(/ editing=1\b/.test(dump), `the contents edit closed: ${dump}`);
      const text = getControlText(edit);
      check(text === CONTENTS_TEXT, `the contents edit holds "${text}"`);
      const res = String((await client.request(ControlCommand.TestFocusState, [""]))[1] ?? "");
      check(res.includes("focus=annot-toolbar "), `${name}'s focus after the frame was restored: ${res}`);
    });
  }
  // E139: the focus left for another window: committed, as for a click there
  for (const [i, way] of FOCUS_WAYS.entries()) {
    await step(`${name}: focus moved to another window while minimized, ${way.how}`, async () => {
      const text = `${CONTENTS_TEXT} ${i}`;
      const editing = (d: string) => / editing=1\b/.test(d);
      if (!find() || !editing(await annotToolbarDump(client))) edit = await openContentsEdit(client, canvas, find);
      sendText(edit, text);
      await focusOtherWindow(client, frame, way, find, name, async () => {
        await clickCanvasAway(canvas);
        await pollUntil(
          () => annotToolbarDump(client),
          (d) => !editing(d),
          { timeoutMs: WAIT_MS, error: (d) => `the contents edit is still open after a click away: ${d}` },
        );
      });
      edit = await openContentsEdit(client, canvas, find);
      const kept = getControlText(edit);
      check(kept === text, `committed "${kept}", want "${text}"`);
    });
  }
  await checkContentsEditFocus(client, frame, canvas, find);
  // deselected, the toolbar goes with the edit
  await hideByOwner(client, "annotation");
}

// E142: where the focus goes when the contents edit loses it to another window
async function checkContentsEditFocus(
  client: ControlClient,
  frame: number,
  canvas: number,
  find: () => number,
): Promise<void> {
  const name = "annotation toolbar contents edit";
  let edit = 0;
  const editing = async () => / editing=1\b/.test(await annotToolbarDump(client));
  // opened afresh, focused, holding text
  const openWith = async (text: string) => {
    if (find()) await hideByOwner(client, "annotation");
    await waitGone(find, "annotation toolbar");
    edit = await openContentsEdit(client, canvas, find);
    sendText(edit, text);
    const res = await focusState(client);
    check(res.startsWith("focus=annot-toolbar "), `the contents edit has no focus: ${res}`);
  };
  const committed = async (text: string) => {
    edit = await openContentsEdit(client, canvas, find);
    const kept = getControlText(edit);
    check(kept === text, `committed "${kept}", want "${text}"`);
  };

  await step(`${name}: a click into another window commits it there`, async () => {
    const text = `${CONTENTS_TEXT} click`;
    await withOtherWindow(client, frame, "CmdNewWindow", async () => {
      await openWith(text);
      const res = await focusState(client, "activate-last");
      check(res.startsWith("focus=other-window "), `the new window has no focus: ${res}`);
      await checkFocusInOther(client, name);
      check(!(await editing()), "the contents edit is still open");
    });
    await committed(text);
  });

  for (const [i, way] of FOCUS_WAYS.entries()) {
    await step(`${name}: another window takes the focus as the frame is restored, ${way.how}`, async () => {
      const text = `${CONTENTS_TEXT} restore ${i}`;
      await withOtherWindow(client, frame, "CmdNewWindow", async () => {
        await openWith(text);
        try {
          await minimizeFrame(client, way.order, way.focus);
          await waitGone(find, `${name} with the frame minimized`);
        } finally {
          await minimizeFrame(client, "restore", "last");
        }
        await checkFocusInOther(client, name);
      });
      await committed(text);
    });
  }

  for (const [i, way] of FOCUS_WAYS.entries()) {
    await step(`${name}: the other window's page box keeps its caret, ${way.how}`, async () => {
      await withOtherWindow(client, frame, "CmdDuplicateInNewWindow", async () => {
        await openWith(`${CONTENTS_TEXT} caret ${i}`);
        try {
          await minimizeFrame(client, way.order, way.focus);
          await waitGone(find, `${name} with the frame minimized`);
          await focusOtherPageBox(client, name);
        } finally {
          await minimizeFrame(client, "restore");
        }
      });
    });
  }

  // E143: a dialog of a class not the app's is like another app, owned by the frame or not
  for (const [kind, whose] of [
    ["dialog-owned", "the frame owns"],
    ["dialog", "no window owns"],
  ]) {
    for (const [i, way] of FOCUS_WAYS.entries()) {
      await step(`${name}: a dialog ${whose} takes the focus while minimized, ${way.how}`, async () => {
        const text = `${CONTENTS_TEXT} ${kind} ${i}`;
        await openWith(text);
        try {
          try {
            await minimizeFrame(client, way.order, way.focus);
            await waitGone(find, `${name} with the frame minimized`);
            const res = await focusState(client, kind!);
            check(res.startsWith("focus=dialog active=dialog"), `the dialog has no focus: ${res}`);
          } finally {
            await minimizeFrame(client, "restore");
          }
          await client.request(ControlCommand.Ping, []);
          const res = await focusState(client);
          check(res.startsWith("focus=dialog active=dialog"), `the restore took the focus from the dialog: ${res}`);
          check(await editing(), "the contents edit closed for the dialog");
        } finally {
          await focusState(client, "dialog-close");
        }
        // Windows activates the owner of the closed dialog; else the user does
        if (!/ active=(frame|annot-toolbar)$/.test(await focusState(client))) await activateFrame(client);
        await pollUntil(
          () => focusState(client),
          (r) => r.startsWith("focus=annot-toolbar "),
          { timeoutMs: WAIT_MS, error: (r) => `the contents edit did not get the focus back: ${r}` },
        );
        check(await editing(), "the contents edit closed");
        const kept = getControlText(edit);
        check(kept === text, `the contents edit holds "${kept}", want "${text}"`);
      });
    }
  }
}

// keyboard caret, visual mode, End: a selection the selection toolbar shows for
export async function selectLineByKeyboard(client: ControlClient, frame: number): Promise<void> {
  const keyboardSel = async (re: RegExp, what: string) => {
    let raw = "";
    await pollUntil(
      async () => {
        raw = String((await client.request(ControlCommand.TestSelectTextKeyboard, []))[1] ?? "");
        return re.test(raw);
      },
      (ok) => ok,
      {
        timeoutMs: WAIT_MS,
        error: () => `${what}
${raw}`,
      },
    );
  };
  sendCommandSync(frame, cmdId("CmdSelectTextViaKeyboard"));
  await keyboardSel(/active=1/, "keyboard selection did not start");
  await postChar(frame, "v");
  await keyboardSel(/visual=1/, "visual mode did not start");
  pressVKey(frame, VK_END);
}

// a shown window, remembered: a bar's handle comes from its owner's dump
function keep(h: () => number): () => number {
  return () => (h() && isWindowVisible(h()) ? h() : 0);
}

export async function checkCanvasPopups(): Promise<void> {
  const dir = tmpPath("ad-hoc-e110");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  const other = join(dir, "other.pdf");
  writeFileSync(pdf, makeE110Pdf(), "latin1");
  writeFileSync(other, makeE110Pdf(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\n");
  // the document under test is the first tab, the other one follows it
  const { proc, client, frame } = await launchLogged("e98-e110", ["-appdata", dir, pdf, other]);
  const pid = proc.pid!;
  const invoke = async (cmd: string) => {
    await client.request(ControlCommand.TestInvokeCommand, [cmd]);
  };
  const follows = async (p: Followed) => checkFollows(p, client, frame, canvas);
  let canvas = 0;
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    sendCommandSync(frame, cmdId("CmdPrevTab"));
    await client.waitForRenderIdle();
    canvas = findCanvas(frame);
    check(canvas !== 0, "canvas not found");

    await follows({
      name: "find bar",
      find: () => shownFindBar(pid, frame),
      open: async () => sendCommandSync(frame, cmdId("CmdFindFirst")),
      sidebar: "stays",
      hide: "find",
      esc: 1,
    });

    let scrollBar = 0;
    await follows({
      name: "Automatically Scroll bar",
      find: keep(() => scrollBar),
      open: async () => {
        await invoke("CmdToggleAutomaticallyScroll");
        scrollBar = await pollUntil(
          () => barHwnd(client, ControlCommand.TestReadingAutoScroll),
          (h) => h !== 0,
          { timeoutMs: WAIT_MS, error: "no Automatically Scroll bar" },
        );
      },
      sidebar: "inside",
      hide: "autoscroll",
      esc: 1,
    });
    if (scrollBar && isWindowVisible(scrollBar)) await invoke("CmdToggleAutomaticallyScroll");

    await follows({
      name: "selection toolbar",
      find: () => shownTop(pid, SEL_CLASS),
      open: () => selectLineByKeyboard(client, frame),
      sidebar: "inside",
      hide: "selection",
      esc: 2,
    });

    // a click on the square outside Edit PDF shows its comment
    await follows({
      name: "comment card",
      find: () => shownTop(pid, CARD_CLASS),
      open: async () => {
        const c = await annotPoint(client, "Square");
        await clickAt(canvas, c.x, c.y, 0, 0, client);
      },
      sidebar: "closes",
      focus: "card",
      hide: "card",
    });

    // in Edit PDF a click selects an annotation, even while a render holds the
    // page (E123). The highlight's toolbar starts at the click, which it keeps (E121)
    sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
    await follows({
      name: "annotation toolbar",
      find: () => shownTop(pid, EDIT_CLASS),
      open: async () => {
        const c = await annotPoint(client, "Highlight", 0.6);
        await clickAt(canvas, c.x, c.y, 0, 0, client);
      },
      sidebar: "inside",
      hide: "annotation",
    });
    await checkContentsEdit(pid, client, frame, canvas);

    // the cursor over the square shows its hover card
    await checkHoverMinimized(
      client,
      "Edit PDF hover card",
      () => shownTop(pid, HOVER_CARD_CLASS),
      async () => {
        const c = await annotPoint(client, "Square");
        const s = clientToScreen(canvas, c.x, c.y);
        await moveTestCursor(s.x, s.y, client);
        sendMessage(canvas, WM_MOUSEMOVE, 0, packCoords(c.x, c.y));
      },
    );
    sendCommandSync(frame, cmdId("CmdToggleEditPDF"));

    const voices = /voices=(\d+)/.exec(String((await client.request(ControlCommand.TestReadAloudPlaybackBar, []))[1]));
    if (!voices || +voices[1]! === 0) {
      console.log("  skip: read-aloud bar (no TTS voices)");
      return;
    }
    let readBar = 0;
    await follows({
      name: "read-aloud bar",
      find: keep(() => readBar),
      open: async () => {
        await invoke("CmdToggleReadAloud");
        readBar = await pollUntil(
          () => barHwnd(client, ControlCommand.TestReadAloudPlaybackBar),
          (h) => h !== 0,
          { timeoutMs: WAIT_MS * 2, error: "no read-aloud bar" },
        );
        // paused, the bar stays up and quiet
        const raw = String((await client.request(ControlCommand.TestReadAloudPlaybackBar, []))[1] ?? "");
        const m = /^pause=(-?\d+),(-?\d+),(\d+),(\d+)$/m.exec(raw);
        if (!m) return;
        const at = packCoords(+m[1]! + Math.floor(+m[3]! / 2), +m[2]! + Math.floor(+m[4]! / 2));
        sendMessage(readBar, WM_LBUTTONDOWN, MK_LBUTTON, at);
        sendMessage(readBar, WM_LBUTTONUP, 0, at);
      },
      sidebar: "inside",
      hide: "readaloud",
    });
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// E140: a popup the frame owns but no child window anchors
type Floating = {
  name: string;
  find: () => number;
  open: () => Promise<void>;
  // TestMinimizeFrame "hide": its owner hides it
  hide?: string;
  // gives it the focus; TestFocusState's name for it then
  focus?: { give: () => Promise<void>; name: string };
  // Esc presses on the frame that close it
  esc?: number;
};

async function checkFloating(p: Floating, client: ControlClient, frame: number): Promise<void> {
  // with the focus for the focus steps
  const shown = async (focus = false) => {
    if (!p.find()) await p.open();
    await waitShown(p.find, p.name);
    if (focus && p.focus) {
      await p.focus.give();
      const res = await focusState(client);
      check(res.includes(`focus=${p.focus.name} `), `${p.name} has no focus: ${res}`);
    }
    return box(p.find());
  };

  for (const way of p.focus ? FOCUS_WAYS : MINIMIZE_WAYS) {
    await step(`${p.name}: frame minimized, ${way.how}`, async () => {
      const before = await shown(true);
      await minimizedAndRestored(client, way, p.find, p.name);
      await waitAt(p.find, before, `${p.name} after the frame was restored`);
      if (!p.focus) return;
      const res = await focusState(client);
      check(res.includes(`focus=${p.focus.name} `), `${p.name}'s focus after the frame was restored: ${res}`);
    });
  }

  // E142: delivered to an owner that moves the focus on the loss
  for (const way of p.focus ? FOCUS_WAYS.filter((w) => w.focus) : []) {
    await step(
      `${p.name}: another window takes the focus as the frame is restored, its owner moving it on the loss, ${way.how}`,
      async () => {
        await withOtherWindow(client, frame, "CmdNewWindow", async () => {
          await shown(true);
          await focusState(client, "kill-moves-focus");
          try {
            await minimizeFrame(client, way.order, way.focus);
            await waitGone(p.find, `${p.name} with the frame minimized`);
          } finally {
            await minimizeFrame(client, "restore", "last");
          }
          await checkFocusInOther(client, p.name);
        });
      },
    );
    await step(`${p.name}: the other window's page box keeps its caret, ${way.how}`, async () => {
      await withOtherWindow(client, frame, "CmdDuplicateInNewWindow", async () => {
        await shown(true);
        try {
          await minimizeFrame(client, way.order, way.focus);
          await waitGone(p.find, `${p.name} with the frame minimized`);
          await focusOtherPageBox(client, p.name);
        } finally {
          await minimizeFrame(client, "restore");
        }
      });
    });
  }

  for (const way of p.hide ? MINIMIZE_WAYS : []) {
    await step(`${p.name}: hidden by its owner while minimized, ${way.how}`, async () => {
      await shown();
      await minimizedAndRestored(client, way, p.find, p.name, () => hideByOwner(client, p.hide!));
      check(p.find() === 0, `${p.name} came back after its owner hid it`);
    });
  }

  for (const way of p.esc ? MINIMIZE_WAYS : []) {
    await step(`${p.name}: closed by Esc while minimized, ${way.how}`, async () => {
      await shown();
      // keys reach the frame as if it had the focus, which a real Esc needs
      const esc = async () => {
        for (let i = 0; i < p.esc!; i++) pressVKey(frame, VK_ESCAPE);
      };
      await minimizedAndRestored(client, way, p.find, p.name, esc, AwayCheck.Skip);
      check(p.find() === 0, `${p.name} came back after Esc closed it`);
    });
  }
}

export async function checkFloatingPopups(): Promise<void> {
  const dir = tmpPath("ad-hoc-e140");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makeE110Pdf(), "latin1");
  const settings = ["UiLanguage = en", "CheckForUpdates = false", "RestoreSession = false", "SearchUIFloating = true"];
  writeFileSync(join(dir, SETTINGS_FILE), settings.join("\n") + "\n");
  const { proc, client, frame } = await launchLogged("e140", ["-appdata", dir, pdf]);
  const pid = proc.pid!;
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const owned = (h: number) => getWindowOwner(h) === frame;
    await checkFloating(
      {
        name: "floating find window",
        find: () =>
          shownTop(pid, BAR_CLASS, (h) => owned(h) && (getWindowLong(h, GWL_STYLE) & WS_CAPTION) === WS_CAPTION),
        open: async () => sendCommandSync(frame, cmdId("CmdFindFirst")),
        hide: "find",
        focus: { give: async () => void (await focusState(client, "find-edit")), name: "find-window" },
        esc: 1,
      },
      client,
      frame,
    );
    await checkFloating(
      {
        name: "annotation list",
        find: () => shownTop(pid, FILTER_CLASS, owned),
        open: async () => {
          await client.request(ControlCommand.TestInvokeCommand, ["CmdFindAnnotation"]);
        },
        hide: "filter",
        focus: { give: async () => void (await focusState(client, "annot-filter")), name: "annot-filter" },
      },
      client,
      frame,
    );
    // E142: open again, it takes the focus
    const palette = async () => sendCommandSync(frame, cmdId("CmdCommandPalette"));
    await checkFloating(
      {
        name: "command palette",
        find: () =>
          shownTop(
            pid,
            BAR_CLASS,
            (h) =>
              owned(h) &&
              (getWindowLong(h, GWL_STYLE) & WS_CAPTION) !== WS_CAPTION &&
              findChildByClass(h, "Edit") !== 0,
          ),
        open: palette,
        focus: { give: palette, name: "palette" },
      },
      client,
      frame,
    );
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

// E143: a shown window the frame owns, by its title
function shownOwned(pid: number, frame: number, title: RegExp): number {
  let found = 0;
  enumWindows((h) => {
    if (getWindowPid(h) !== pid || !isWindowVisible(h) || !title.test(getWindowText(h))) return true;
    if (getWindowOwner(h) !== frame) return true;
    found = h;
    return false;
  });
  return found;
}

// closed by its close box
async function closeWindow(find: () => number, what: string): Promise<void> {
  const h = find();
  if (h) postMessage(h, WM_CLOSE, 0, 0);
  await waitGone(find, `${what} after WM_CLOSE`);
}

// E147: Run PDF Script's examples for the test, written by it: the app's come from the
// website checkout, which CI doesn't have. Two, so a pick changes the script
const SCRIPT_EXAMPLES = [
  "// Info: Print the page count.\nprint(Document.openDocument(scriptArgs[0]).countPages());",
  "// Info: Print the first page's bounds.\nprint(Document.openDocument(scriptArgs[0]).loadPage(0).getBounds());",
].join("\n// ---\n");

const WM_SETREDRAW = 0x000b;

// E145: a window hidden with the frame isn't put back on screen by setting WS_VISIBLE
// without a show: WM_SETREDRAW TRUE (what Run PDF Script's example pick sends a window
// it reads as shown) or a style write
async function checkStaysHidden(
  pid: number,
  client: ControlClient,
  frame: number,
  foreground?: ForegroundFixture,
): Promise<void> {
  const name = "Run PDF Script";
  const find = () => shownOwned(pid, frame, /^Run PDF Script$/);
  const examples = tmpPath("ad-hoc-e147-scripts.js");
  writeFileSync(examples, SCRIPT_EXAMPLES + "\n");
  const loaded = await client.request(ControlCommand.TestPdfScript, ["load-examples", -1, examples]);
  check(loaded[0] === 0 && /examples=2\b/.test(String(loaded[1])), `examples not loaded: ${loaded[1]}`);
  // A hidden dialog's example pick skips its top-level redraw toggle. Exercise the
  // direct pair from E149 as well as the example list's normal path.
  const redraw = async (h: number) => {
    sendMessage(h, WM_SETREDRAW, 0, 0);
    sendMessage(h, WM_SETREDRAW, 1, 0);
  };
  let picked = 0;
  const pick = async () => {
    picked = 1 - picked;
    const res = await client.request(ControlCommand.TestPdfScript, ["pick", picked]);
    check(res[0] === 0 && String(res[1]).includes(` sel=${picked} `), `pick ${picked}: ${res[1]}`);
  };
  const styleWrite = async (h: number) => void setWindowLong(h, GWL_STYLE, getWindowLong(h, GWL_STYLE) | WS_VISIBLE);
  const writes = [
    { what: "WM_SETREDRAW TRUE", write: redraw, event: (h: string) => `WM_SETREDRAW hwnd=${h} wp=0x1 ` },
    { what: "a style write sets WS_VISIBLE", write: styleWrite, event: () => "style-written ", trace: "style-written" },
    { what: "an example picked", write: pick, event: () => "pick-end " },
  ];
  for (const w of writes) {
    const during = async (hwnd: number) => {
      await w.write(hwnd);
      check(!isWindowVisible(hwnd), `${name} is on screen with the frame minimized after ${w.what}`);
    };
    await checkModalMinimized(
      client,
      frame,
      { name, find, cmd: "CmdRunPDFScript" },
      {
        what: `${w.what} while minimized`,
        during,
        event: w.event,
        trace: w.trace,
      },
      foreground,
    );
  }
  await closeWindow(find, name);
}

type Modal = { name: string; find: () => number; cmd: string };
type MinimizedAction = {
  what: string;
  during: (hwnd: number) => Promise<void>;
  event: (hwnd: string) => string;
  trace?: string;
};

// E148: a modal dialog, its frame disabled, goes with the frame and is back at its place
// with the focus. With the app in the foreground Windows gives the activation to another
// app as it hides the dialog with the frame: the "frame" way, the same on both desktops.
// Without a foreground the hidden desktop leaves the dialog active, so no kept way. A step
// starts with a click on it: in the background Windows moves no activation and the
// stand-in can't take it. `during` runs while minimized
async function checkModalMinimized(
  client: ControlClient,
  frame: number,
  m: Modal,
  action?: MinimizedAction,
  foreground?: ForegroundFixture,
): Promise<void> {
  const ways = FOCUS_WAYS.filter((w) => w.focus).map((w) =>
    w.focus === "frame" ? { ...w, how: `${w.order}, the activation left the app` } : w,
  );
  for (const way of ways) {
    await step(`${m.name}: ${action?.what ?? "frame minimized"}, ${way.how}`, async () => {
      // posted: the dialog runs its own message loop
      if (!m.find()) sendCommand(frame, cmdId(m.cmd));
      const hwnd = await waitShown(m.find, m.name);
      const before = box(hwnd);
      const external = way.focus === "frame" ? foreground : undefined;
      const run = async () => {
        const res = await focusState(client, "activate-owned");
        check(res.includes("focus=owned "), `${m.name} has no focus: ${res}`);
        await minimizedAndRestored(
          client,
          way,
          m.find,
          m.name,
          action && (() => action.during(hwnd)),
          AwayCheck.Kept,
          action?.trace,
          external,
        );
        await waitAt(m.find, before, `${m.name} after the frame was restored`);
        const after = await focusState(client);
        check(after.includes("focus=owned "), `${m.name}'s focus after the frame was restored: ${after}`);
      };
      if (!action && !external) return run();

      const [, started] = await client.request(ControlCommand.TestActivationTrace, ["start-focus"]);
      check(started === "OK", `${m.name}: activation diagnostics did not start`);
      let failure: unknown;
      try {
        await run();
      } catch (error) {
        failure = error;
      }
      const [, focusTrace] = await client.request(ControlCommand.TestActivationTrace, ["stop-focus"]).catch((error) => {
        if (!failure) throw error;
        return [1, `focus trace unavailable: ${error}`];
      });
      const trace = String(focusTrace ?? "");
      if (failure) throw new Error(`${(failure as Error).message}\n${trace}`);
      if (!action || way.order !== "anchor-first" || way.focus !== "frame") return;

      const minimized = trace.indexOf("minimize-end ");
      const restore = trace.indexOf("restore-begin ");
      const reshow = trace.indexOf("reshow-begin ");
      const event = trace.indexOf(action.event(`0x${hwnd.toString(16)}`), reshow);
      check(
        /foreground=(none|app|other)\b.* active=0x[\da-f]+ focus=0x[\da-f]+/.test(trace) &&
          minimized >= 0 &&
          reshow > minimized &&
          event > reshow &&
          restore > event,
        `missing activation diagnostics for ${m.name}: ${action.what}\n${trace}`,
      );
      if (process.env.SOLOKPDF_HIDDEN_DESKTOP) {
        check(
          /activate-end .* foreground=none\/0x0\/0 active=0x[1-9a-f][\da-f]* focus=0x[1-9a-f][\da-f]*/.test(trace),
          `${m.name}: activation should have thread focus without foreground on the hidden desktop:\n${trace}`,
        );
      }
    });
  }
}

// E143: the windows the frame owns follow its minimize; one it doesn't own stays
export async function checkOwnedWindows(): Promise<void> {
  const dir = tmpPath("ad-hoc-e143");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makeE110Pdf(), "latin1");
  const settings = ["UiLanguage = en", "CheckForUpdates = false", "RestoreSession = false"];
  writeFileSync(join(dir, SETTINGS_FILE), settings.join("\n") + "\n");
  // A separate input queue can retain the real foreground on the hosted desktop.
  const interactive =
    !process.env.SOLOKPDF_HIDDEN_DESKTOP &&
    (process.env.CI || process.env.GITHUB_ACTIONS || process.env.SOLOKPDF_REAL_DESKTOP === "1");
  const foreground = interactive ? await launchControlled([]) : undefined;
  try {
    await checkOwnedInSession(dir, pdf, foreground);
  } finally {
    if (foreground) {
      foreground.client.close();
      await killAndWait(foreground.proc);
    }
  }
}

async function checkOwnedInSession(dir: string, pdf: string, foreground?: ForegroundFixture): Promise<void> {
  const { proc, client, frame } = await launchLogged("e143", ["-appdata", dir, pdf]);
  const pid = proc.pid!;
  const focus = { give: async () => void (await focusState(client, "owned-popup")), name: "owned" };
  const owned = async (p: Floating) => {
    await checkFloating(p, client, frame);
    await closeWindow(p.find, p.name);
  };
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    await owned({
      name: "keyboard help",
      find: () => shownOwned(pid, frame, /^Keyboard Shortcuts$/),
      open: async () => sendCommandSync(frame, cmdId("CmdToggleKeyboardHelp")),
      hide: "help",
      focus,
    });
    await owned({
      name: "Merge PDF",
      find: () => shownOwned(pid, frame, /^Merge PDF/),
      open: async () => sendCommandSync(frame, cmdId("CmdMergePDF")),
      focus,
    });
    await owned({
      name: "Compress PDF",
      find: () => shownOwned(pid, frame, /^Compress PDF/),
      open: async () => sendCommandSync(frame, cmdId("CmdPdfCompress")),
      focus,
    });
    await checkStaysHidden(pid, client, frame, foreground);
    // E147: other modal dialogs
    for (const m of [
      { name: "Add Favorite", find: () => shownOwned(pid, frame, /^Add Favorite$/), cmd: "CmdFavoriteAdd" },
      { name: "Zoom", find: () => shownOwned(pid, frame, /^Zoom$/), cmd: "CmdZoomCustom" },
    ]) {
      await checkModalMinimized(client, frame, m, undefined, foreground);
      await closeWindow(m.find, m.name);
    }
    // With the toolbar hidden, Go to page opens a modal instead of focusing its page box.
    sendCommandSync(frame, cmdId("CmdToggleToolbar"));
    sendCommandSync(frame, cmdId("CmdToggleToolbar"));
    const goToPage = { name: "Go to page", find: () => shownOwned(pid, frame, /^Go to page$/), cmd: "CmdGoToPage" };
    await checkModalMinimized(client, frame, goToPage, undefined, foreground);
    await closeWindow(goToPage.find, goToPage.name);
    sendCommandSync(frame, cmdId("CmdToggleToolbar"));

    // not owned: Windows and the layer leave it alone. anchor-first shows again only
    // what the frame owns
    const props = () => shownTop(pid, BAR_CLASS, (h) => getWindowText(h) === "Document Properties");
    for (const way of MINIMIZE_WAYS.filter((w) => w.order === "os-first")) {
      await step(`Properties: frame minimized, ${way.how}`, async () => {
        if (!props()) sendCommandSync(frame, cmdId("CmdProperties"));
        const before = box(await waitShown(props, "Properties"));
        check(getWindowOwner(props()) !== frame, "the frame owns Properties");
        try {
          await minimizeFrame(client, way.order, way.focus);
          check(props() !== 0, "Properties hid with the frame");
        } finally {
          await minimizeFrame(client, "restore");
        }
        await client.request(ControlCommand.Ping, []);
        await waitAt(props, before, "Properties after the frame was restored");
      });
    }
    await closeWindow(props, "Properties");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

const OVERLAY_CLASS = "SplitterResizeOverlayWnd";
const DRAG_DX = 40;

// the AI chat splitter, the frame's last one, in frame client coordinates
async function aiChatSplitter(client: ControlClient): Promise<Box> {
  const re = /^layout path=\S+ kind=virtCtrlSplitter visibility=0 rect=(-?\d+),(-?\d+),(\d+),(\d+)$/gm;
  let raw = "";
  return await pollUntil(
    async () => {
      raw = String((await client.request(ControlCommand.TestLayout, ["get"]))[1] ?? "");
      let last: Box | null = null;
      for (const m of raw.matchAll(re)) {
        const b = { x: +m[1]!, y: +m[2]!, dx: +m[3]!, dy: +m[4]! };
        if (b.dy > 0 && (!last || b.x > last.x)) last = b;
      }
      return last;
    },
    (b) => !!b,
    { timeoutMs: WAIT_MS * 3, error: () => `no AI chat splitter\n${raw}` },
  );
}

// E143: the AI chat splitter's resize overlay, a popup the frame owns while the splitter
// is dragged, follows the minimize; the drag ending meanwhile hides it for good
export async function checkResizeOverlay(): Promise<void> {
  const dir = tmpPath("ad-hoc-e143-overlay");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makeE110Pdf(), "latin1");
  // a provider that is never called: the panel only has to show
  const settings = [
    "UiLanguage = en",
    "CheckForUpdates = false",
    "RestoreSession = false",
    "CustomAI [\n BaseURL = http://127.0.0.1:9/v1\n Model = e143\n ApiKeyEnv = SUMATRA_E143_NO_KEY\n]",
  ];
  writeFileSync(join(dir, SETTINGS_FILE), settings.join("\n") + "\n");
  const { proc, client, frame } = await launchLogged("e143-overlay", ["-appdata", dir, pdf]);
  const pid = proc.pid!;
  const name = "resize overlay";
  const find = () => shownTop(pid, OVERLAY_CLASS, (h) => getWindowOwner(h) === frame);
  let at = { x: 0, y: 0 };
  let dragging = false;
  const mouse = async (msg: number, keys: number, x: number, y: number) => {
    const s = clientToScreen(frame, x, y);
    await moveTestCursor(s.x, s.y, client);
    sendMessage(frame, msg, keys, packCoords(x, y));
  };
  // from the splitter's middle, which a drop moves
  const drag = async () => {
    if (!dragging) {
      const r = await aiChatSplitter(client);
      at = { x: r.x + Math.floor(r.dx / 2), y: r.y + Math.floor(r.dy / 2) };
      await mouse(WM_LBUTTONDOWN, MK_LBUTTON, at.x, at.y);
      await mouse(WM_MOUSEMOVE, MK_LBUTTON, at.x - DRAG_DX, at.y);
      dragging = true;
    }
    return box(await waitShown(find, name));
  };
  const drop = async () => {
    await mouse(WM_LBUTTONUP, 0, at.x - DRAG_DX, at.y);
    dragging = false;
  };
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    sendCommandSync(frame, cmdId("CmdAIChatWithCustomAPI"));

    for (const way of MINIMIZE_WAYS) {
      await step(`${name}: frame minimized, ${way.how}`, async () => {
        const before = await drag();
        await minimizedAndRestored(client, way, find, name);
        await waitAt(find, before, `${name} after the frame was restored`);
      });
    }
    for (const way of MINIMIZE_WAYS) {
      await step(`${name}: the drag ended while minimized, ${way.how}`, async () => {
        await drag();
        await minimizedAndRestored(client, way, find, name, drop);
        check(find() === 0, `${name} came back after the drag ended`);
      });
    }
  } finally {
    if (dragging) await drop();
    client.close();
    await killAndWait(proc);
  }
}

const TREE_CLASS = "SumatraVirtualBookmarksTree";
// SidebarTree's test message and its row height field
const TREE_STATE = 0x8000 + 102;
const TREE_ROW_DY = 3;

// one bookmark, too long for the sidebar in any layout: its row shows a tip
function makeTocPdf(): string {
  const title = "A bookmark with a title far too long to fit into the sidebar ".repeat(4).trimEnd();
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    `<< /Title (${title}) /Parent 3 0 R /Dest [4 0 R /Fit] >>`,
  ]);
}

// E147: a tip shown at the minimize goes with the frame and is not back on restore. A tip
// has no owner: Windows doesn't hide it with the frame, and anchor-first shows again only
// what the frame owns, so it runs where the tip's window is a popup the frame owns
export async function checkTips(): Promise<void> {
  const dir = tmpPath("ad-hoc-e147");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "toc.pdf");
  writeFileSync(pdf, makeTocPdf(), "latin1");
  const settings = ["UiLanguage = en", "CheckForUpdates = false", "RestoreSession = false", "ShowToc = true"];
  writeFileSync(join(dir, SETTINGS_FILE), settings.join("\n") + "\n");
  const { proc, client, frame } = await launchLogged("e147", ["-appdata", dir, pdf]);
  const pid = proc.pid!;
  gPid = pid;
  const find = () => shownTip(pid);
  const osFirst = MINIMIZE_WAYS.filter((w) => w.order === "os-first");
  // the cursor at (x, y) in hwnd's client area, as Windows reports its arrival
  const hover = async (hwnd: number, x: number, y: number) => {
    const s = clientToScreen(hwnd, x, y);
    await moveTestCursor(s.x, s.y, client);
    sendMessage(hwnd, WM_MOUSEMOVE, 0, packCoords(x, y));
    sendMessage(hwnd, WM_SETCURSOR, hwnd, packCoords(HTCLIENT, WM_MOUSEMOVE));
  };
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    check(canvas !== 0, "canvas not found");

    // a toolbar button's tip, a virtual control's
    const toolbar = findChildByClass(frame, TOOLBAR_CLASS);
    check(toolbar !== 0, "no toolbar");
    await checkHoverMinimized(
      client,
      "toolbar tip",
      find,
      async () => {
        const b = await mainButton(client, cmdId("CmdZoomIn"));
        await hover(toolbar, b.x + Math.floor(b.dx / 2), b.y + Math.floor(b.dy / 2));
      },
      osFirst,
    );
    sendMessage(toolbar, WM_MOUSELEAVE, 0, 0);
    await waitGone(find, "toolbar tip after the cursor left");

    // the bookmark's tip, after the tree's hover delay
    const tree = findChildWindow(frame, TREE_CLASS);
    check(tree !== 0, "no bookmarks tree");
    await checkHoverMinimized(
      client,
      "bookmarks tip",
      find,
      async () => {
        const rowDy = Number(sendMessage(tree, TREE_STATE, TREE_ROW_DY, 0));
        sendMessage(tree, WM_MOUSELEAVE, 0, 0);
        await hover(tree, 10, Math.floor(rowDy / 2));
      },
      osFirst,
    );
    sendMessage(tree, WM_MOUSELEAVE, 0, 0);
    await waitGone(find, "bookmarks tip after the cursor left");

    // a link's tip in Home's About hover, a popup the frame owns
    sendCommandSync(frame, cmdId("CmdNewTab"));
    await waitForHome(client, (s) => s.logo[2]! > 0, "Home not ready");
    const aboutHover = () => shownTopWindow(pid, ABOUT_CLASS);
    // not Home's keyboard selection tip, which shows once the restored frame focuses Home
    let linkTip = 0;
    const findLinkTip = () => (linkTip && isWindowVisible(linkTip) ? linkTip : 0);
    const showLinkTip = async () => {
      if (!aboutHover()) {
        const [lx, ly, ldx, ldy] = (await client.homeSelection()).logo;
        await hover(canvas, 1, 1);
        await hover(canvas, lx! + Math.floor(ldx! / 2), ly! + Math.floor(ldy! / 2));
      }
      const host = await waitShown(aboutHover, "About hover");
      // a web link: its tip is the url, shown below the cursor
      const links = (await client.virtTree(ABOUT_CLASS)).filter((c) => /link/i.test(c.kind) && c.name !== "aboutCopy");
      check(links.length > 0, "the About hover shows no web link");
      const r = links[0]!.rect;
      const at = { x: r.x + Math.floor(r.dx / 2), y: r.y + Math.floor(r.dy / 2) };
      await hover(host, at.x, at.y);
      const cursorY = clientToScreen(host, at.x, at.y).y;
      const below = (h: number) => box(h).y > cursorY && box(h).y < cursorY + r.dy * 3;
      linkTip = await waitShown(() => shownTip(pid, below), "About hover link tip");
    };
    await checkHoverMinimized(client, "About hover link tip", findLinkTip, showLinkTip);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  failures.length = 0;
  setProcessDpiAware();
  if (process.argv.includes("--owned-windows-only")) {
    await checkOwnedWindows();
    check(failures.length === 0, failures.join("\n"));
    return;
  }
  const pdf = tmpPath("e98-link.pdf");
  writeFileSync(pdf, makeLinkPdf(), "latin1");
  const { proc, client, frame } = await launchLogged("e98", ["-appdata", makeAppDir(), pdf]);
  const pid = proc.pid!;
  gPid = pid;
  try {
    await client.waitForRenderIdle();
    await client.setNotificationsEnabled(false);
    const canvas = findCanvas(frame);
    check(canvas !== 0, "canvas not found");

    await step("link tip: cursor leaves the canvas", () => checkLinkTipLeave(pid, client, frame, canvas));
    await checkToolbarDropdown(pid, client, frame, canvas);

    // a Home tab after the document's tab
    sendCommandSync(frame, cmdId("CmdNewTab"));
    await waitForHome(client, (s) => s.entries === N_FILES + 1, "Home not ready");
    await checkHomeTip(pid, client, frame, canvas);
    await checkAboutHover(pid, client, frame, canvas);
  } finally {
    client.close();
    await killAndWait(proc);
  }
  await step("citation hover", checkRefHover);
  await step("E110 popups", checkCanvasPopups);
  await step("E140 floating popups", checkFloatingPopups);
  await step("E143 owned windows", checkOwnedWindows);
  await step("E143 resize overlay", checkResizeOverlay);
  await step("E147 tips", checkTips);
  check(failures.length === 0, failures.join("\n"));
  console.log("e98-anchored-popups: OK");
}

if (import.meta.main) {
  if (process.argv.includes("--work-area")) setTestWindowLayout("workArea");
  await runStandalone(testit);
}
