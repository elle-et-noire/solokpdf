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
// Run: bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-e98-anchored-popups.ts --no-build

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient, waitForHome } from "./control.ts";
import { makePdf as makeRefPdf, waitFor as waitRefPopup } from "./issue-6252.ts";
import { assemblePdf, cmdId, pollUntil, ROOT, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getClientRect,
  getControlText,
  getWindowLong,
  getWindowPid,
  getWindowRect,
  getWindowOwner,
  GWL_EXSTYLE,
  isWindowVisible,
  MK_RBUTTON,
  packCoords,
  sendMessage,
  setProcessDpiAware,
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
  WM_MOUSEMOVE,
  WM_RBUTTONDOWN,
  WM_RBUTTONUP,
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
  sendCommandSync,
} from "./win-automation.ts";

const TOOLBAR_CLASS = "SUMATRA_VIRT_TOOLBAR";
const MENU_CLASS = "SumatraToolbarHoverMenu";
const ABOUT_CLASS = "SUMATRA_ABOUT_HOVER";
const TIP_CLASS = "tooltips_class32";
const LINK_URL = "https://example.com/e100";
const N_FILES = 6;
const WS_EX_TOPMOST = 0x8;
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

const failures: string[] = [];
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
function shownTip(pid: number): number {
  let found = 0;
  enumWindows((h) => {
    if (getWindowPid(h) !== pid || getClassName(h) !== TIP_CLASS || !isWindowVisible(h)) return true;
    if ((getWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) === 0 || getWindowOwner(h) !== 0) return true;
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

async function waitShown(find: () => number, what: string): Promise<number> {
  return await pollUntil(find, (h) => h !== 0, {
    timeoutMs: WAIT_MS,
    error: () => `${what}: not shown (${describeTips(gPid)})`,
  });
}

async function waitGone(find: () => number, what: string): Promise<void> {
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
const SEL_CLASS = "SumatraSelectionToolbar";
const EDIT_CLASS = "SumatraAnnotEditToolbar";
const CARD_CLASS = "SumatraAnnotTextPopup";
const HOVER_CARD_CLASS = "SumatraAnnotationHoverOverlay";
const BAR_CLASS = "SumatraWgDefaultWinClass";
const COMBO_CLASS = "ComboBox";
const VK_END = 0x23;
const E110_LINE = "The quick brown fox jumps over the lazy dog";

// a line of text, a highlighted one off the selection, and a square with a comment
function makeE110Pdf(): string {
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

function shownTop(pid: number, cls: string, ok: (h: number) => boolean = () => true): number {
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
function shownFindBar(pid: number, frame: number): number {
  return shownTop(pid, BAR_CLASS, (h) => getWindowOwner(h) === frame && findChildByClass(h, COMBO_CLASS) !== 0);
}

async function barHwnd(client: ControlClient, cmd: ControlCommand): Promise<number> {
  const res = await client.request(cmd, []);
  const m = /^OK visible=1 .*hwnd=(\d+)/m.exec(String(res[1] ?? ""));
  return m && isWindowVisible(+m[1]!) ? +m[1]! : 0;
}

// a point of an annotation, fx across and half way down, in canvas
// coordinates, once it is on screen
async function annotPoint(client: ControlClient, type: string, fx = 0.5): Promise<{ x: number; y: number }> {
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
// moves to the frame (E137)
async function minimizeFrame(client: ControlClient, order: string, focus = ""): Promise<void> {
  const res = await client.request(ControlCommand.TestMinimizeFrame, [order, focus]);
  check(res[0] === 0, `TestMinimizeFrame ${order}: ${res[1]}`);
  check(order !== "anchor-first" || !/reshown=0\b/.test(String(res[1])), `${order}: nothing shown while minimized`);
  check(
    focus !== "frame" || /toFrame=[1-9]/.test(String(res[1])),
    `${order}: the focus did not move to the frame: ${res[1]}`,
  );
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

// minimized, `during` runs, restored. The anchor layer's syncs, posted by the
// restore, run before the next request: one Windows shows again only for its
// owner to hide is not back when it returns
async function minimizedAndRestored(
  client: ControlClient,
  way: { order: string; focus: string },
  find: () => number,
  what: string,
  during: () => Promise<void> = async () => {},
): Promise<void> {
  try {
    await minimizeFrame(client, way.order, way.focus);
    await waitGone(find, `${what} with the frame minimized`);
    await during();
  } finally {
    await minimizeFrame(client, "restore");
  }
  await client.request(ControlCommand.Ping, []);
}

// E124: the popup's owner hides it the way the user's actions reach it
async function hideByOwner(client: ControlClient, popup: string): Promise<void> {
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
      await client.request(ControlCommand.TestInvokeCommand, ["CmdNewWindow"]);
      other = await pollUntil(
        () => shownTop(getWindowPid(frame), FRAME_CLASS, (h) => h !== frame),
        (h) => h !== 0,
        { timeoutMs: WAIT_MS, error: "no new window" },
      );
      const res = String((await client.request(ControlCommand.TestFocusState, ["activate-last"]))[1] ?? "");
      check(res.includes("focus=other-window "), `the new window has no focus: ${res}`);
    });
    await after();
  } finally {
    if (other) {
      postMessage(other, WM_CLOSE, 0, 0);
      await pollUntil(
        () => isWindowVisible(other),
        (v) => !v,
        { timeoutMs: WAIT_MS, error: "the new window did not close" },
      );
    }
    await activateTestFrame(client);
  }
}

// a hover goes with a minimize and is not back on restore (E124)
async function checkHoverMinimized(
  client: ControlClient,
  name: string,
  find: () => number,
  show: () => Promise<void>,
): Promise<void> {
  for (const way of MINIMIZE_WAYS) {
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
      const before = await shown();
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
      await minimizedAndRestored(client, way, p.find, p.name, async () => {
        for (let i = 0; i < p.esc!; i++) pressVKey(frame, VK_ESCAPE);
      });
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

async function annotToolbarDump(client: ControlClient): Promise<string> {
  const raw = String((await client.request(ControlCommand.TestMarkupAnnots, []))[1] ?? "");
  return /annotEditToolbar .*/.exec(raw)?.[0] ?? "";
}

// the highlight selected, its toolbar's contents edit opened
async function openContentsEdit(client: ControlClient, canvas: number, find: () => number): Promise<number> {
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
  // deselected, the toolbar goes with the edit
  await hideByOwner(client, "annotation");
}

// keyboard caret, visual mode, End: a selection the selection toolbar shows for
async function selectLineByKeyboard(client: ControlClient, frame: number): Promise<void> {
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

async function checkCanvasPopups(): Promise<void> {
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

export async function testit(): Promise<void> {
  failures.length = 0;
  setProcessDpiAware();
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
  check(failures.length === 0, failures.join("\n"));
  console.log("e98-anchored-popups: OK");
}

if (import.meta.main) await runStandalone(testit);
