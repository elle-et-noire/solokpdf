// Opt-in monkey test (E71): seeded random sequences of UI operations driven through -dbg-control,
// catching crashes, hangs, ReportIf asserts and ASan reports that single-scenario tests miss.
// Build with solok-build.ts (-quick or -asan), then run on the hidden desktop:
//   bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-monkey.ts --no-build --seed 1 --ops 300 --runs 3
// Options: --seed <n> (default 1; run i uses seed+i), --ops <n> per run (default 300), --runs <n> (default 1),
// --replay <ops.jsonl> (runs a saved op log once), --shrink-attempts <n> (default 30, 0 = no shrink).
// Engine: PDFium by default, MuPDF with SOLOKPDF_ENGINE=mupdf. ASan: SUMATRA_TEST_EXE=out/dbg64_asan/...
// Findings (op log, shrunk log, app log, stderr) go to tests/tmp/monkey/findings/.
//
// Excluded commands, and why:
// - dialogs that block on input: Open*/Save As/Print/Rename/Properties/Options/Change*/Set*/Configure*/
//   Go to Page/Zoom Custom/Customize*/Merge/Extract/Compress/Encrypt/Bake/Convert*/Sign*/Insert Image/
//   Run PDF Script/Screenshot/Navigate* pickers, file attachment and image-from-clipboard annotations.
//   The "Unsaved changes" prompt is answered (op.answer); any other dialog is a finding and is cancelled.
// - external apps, browser, network, printer: OpenWith*, Help*, Translate/Search*, AI chats, Send by Email,
//   Show In Folder, Check Update, Open from URL, Contribute Translation, Exec, External Viewer, Google Lens.
// - writes outside tests/tmp or deletes: Delete File*, Create Shortcut, Tab Group Save, Delete Cached Files,
//   Clear History, settings saves (Debug: Save Settings), Fix Default App, Windows previewer/filter toggles.
// - quits or a second window: Exit, Close Current Document (quits on the last tab), New Window,
//   Duplicate In New Window; control requests and frame lookup target the first window.
// - timers, audio and window state: Read Aloud, Auto-Scroll, Laser Pointer, Fullscreen, Presentation,
//   Minimize; Debug: crash/corrupt/stress commands; Command Palette (focus-only popup).
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, DEBUG_REPORT_EXIT_CODE, type ControlArg, type ControlClient } from "./control.ts";
import {
  assemblePdf,
  cmdId,
  IS_ASAN,
  makePng,
  ROOT,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  tmpPath,
} from "./util.ts";
import { captureStartupFailure } from "./startup-diagnostics.ts";
import { findCanvas, killAndWait, launchControlled, moveTestCursor, takeStderr } from "./win-automation.ts";
import {
  clientToScreen,
  enumWindows,
  getClassName,
  getClientRect,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  postMessage,
  sendCopyDataW,
  VK_DELETE,
  VK_ESCAPE,
  WM_CLOSE,
  WM_COMMAND,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi.ts";

// a request taking longer than this is a hang
const kRequestTimeoutMs = 30000 * SLOW_BUILD_FACTOR;
const kQuitTimeoutMs = 30000 * SLOW_BUILD_FACTOR;
const kDdeCopyData = 0x44646557;
const kDialogClass = "#32770";
const kUnsavedTitle = "Unsaved changes";
const kClickButton = 0x0400 + 102; // TDM_CLICK_BUTTON
const kIdCancel = 2;
const kBtnDiscard = 100;
const kBtnSaveExisting = 101;
const kBtnSaveNew = 102;
const kMaxDialogRounds = 4;
const kFindingsDir = join(ROOT, "tests", "tmp", "monkey", "findings");

// xorshift32: the same seed gives the same op sequence
class Rng {
  constructor(private state: number) {
    if (this.state === 0) this.state = 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  int(n: number): number {
    return this.next() % n;
  }
  frac(): number {
    return Math.round((this.next() % 10000) / 100) / 100;
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }
}

//--- fixtures

const kFixtures = ["text", "annots", "form", "image", "saved"] as const;
type Fixture = (typeof kFixtures)[number];

const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
const kFont = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

// 8 pages of searchable text, an outline, internal links, labels, a rotated and an odd-sized page
function textPdf(): string {
  const nPages = 8;
  const pageObj = (i: number) => 3 + i * 2;
  const objs: string[] = [
    `<< /Type /Catalog /Pages 2 0 R /Outlines ${3 + nPages * 2} 0 R /PageLabels << /Nums [0 << /S /r >> 2 << /S /D >>] >> >>`,
    `<< /Type /Pages /Count ${nPages} /Kids [${[...Array(nPages).keys()].map((i) => `${pageObj(i)} 0 R`).join(" ")}] >>`,
  ];
  const outlines = 3 + nPages * 2;
  const linkObj = outlines + 5;
  const fontObj = outlines + 7;
  for (let i = 0; i < nPages; i++) {
    const box = i === 3 ? "[0 0 400 300]" : "[0 0 612 792]";
    const rotate = i === 2 ? " /Rotate 90" : "";
    const annots = i === 0 ? ` /Annots [${linkObj} 0 R ${linkObj + 1} 0 R]` : "";
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${box}${rotate}${annots} /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`,
    );
    const lines = [...Array(12).keys()]
      .map(
        (l) =>
          `BT /F1 14 Tf 40 ${260 - l * 18 + (i === 3 ? 0 : 480)} Td (page ${i + 1} line ${l} needle word${l}) Tj ET`,
      )
      .join(" ");
    objs.push(stream(lines));
  }
  objs.push(
    `<< /Type /Outlines /First ${outlines + 1} 0 R /Last ${outlines + 3} 0 R /Count 3 >>`,
    `<< /Title (Start) /Parent ${outlines} 0 R /Next ${outlines + 2} 0 R /Dest [${pageObj(0)} 0 R /Fit] >>`,
    `<< /Title (Middle) /Parent ${outlines} 0 R /Prev ${outlines + 1} 0 R /Next ${outlines + 3} 0 R /First ${outlines + 4} 0 R /Last ${outlines + 4} 0 R /Count 1 /Dest [${pageObj(4)} 0 R /XYZ 0 400 2] >>`,
    `<< /Title (End) /Parent ${outlines} 0 R /Prev ${outlines + 2} 0 R /Dest [${pageObj(7)} 0 R /FitH 100] >>`,
    `<< /Title (Rotated) /Parent ${outlines + 2} 0 R /Dest [${pageObj(2)} 0 R /Fit] >>`,
    `<< /Type /Annot /Subtype /Link /Rect [40 740 300 760] /Dest [${pageObj(5)} 0 R /Fit] >>`,
    "<< /Type /Annot /Subtype /Link /Rect [40 700 300 720] /A << /S /Named /N /NextPage >> >>",
    kFont,
  );
  return assemblePdf(objs);
}

function annotsPdf(): string {
  const text1 =
    "BT /F1 18 Tf 72 700 Td (SECRETONE visible words to mark) Tj ET BT /F1 18 Tf 72 600 Td (more text) Tj ET";
  const text2 = "BT /F1 18 Tf 72 700 Td (SECRETTWO second page) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /DR << /Font << /Helv 4 0 R >> >> >> >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 7 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R 9 0 R 10 0 R 11 0 R 12 0 R 13 0 R] >>",
    kFont,
    stream(text1),
    "<< /Type /Annot /Subtype /Redact /P 3 0 R /Rect [66 690 200 725] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R /Annots [14 0 R] >>",
    stream(text2),
    "<< /Type /Annot /Subtype /Text /P 3 0 R /Rect [500 700 520 720] /Contents (note) /T (author) >>",
    "<< /Type /Annot /Subtype /Highlight /P 3 0 R /Rect [72 595 180 620] /QuadPoints [72 620 180 620 72 595 180 595] /C [1 1 0] >>",
    "<< /Type /Annot /Subtype /Square /P 3 0 R /Rect [300 300 450 400] /C [1 0 0] /BS << /W 2 >> >>",
    "<< /Type /Annot /Subtype /Ink /P 3 0 R /Rect [100 100 250 200] /InkList [[100 100 150 180 200 120 250 200]] /C [0 0 1] >>",
    "<< /Type /Annot /Subtype /FreeText /P 3 0 R /Rect [300 500 500 540] /Contents (free text) /DA (/Helv 12 Tf 0 g) >>",
    "<< /Type /Annot /Subtype /StrikeOut /P 7 0 R /Rect [72 695 200 720] /QuadPoints [72 720 200 720 72 695 200 695] /C [1 0 0] >>",
  ]);
}

// a text field, a checkbox and a combo box on page 1; a calculated field on page 2
function formPdf(): string {
  const appearance = (word: string) => {
    const s = `BT /Helv 10 Tf 2 5 Td (${word}) Tj ET`;
    return `<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Resources << /Font << /Helv 7 0 R >> >> /Length ${s.length} >>\nstream\n${s}\nendstream`;
  };
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R 10 0 R 11 0 R] /CO [11 0 R] /DR << /Font << /Helv 7 0 R >> >> /DA (/Helv 0 Tf 0 g) >> >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [5 0 R 6 0 R 10 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [11 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (initial) /Rect [100 550 400 590] /P 3 0 R /F 4 /DA (/Helv 14 Tf 0 g) >>",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /T (check) /V /Off /AS /Off /Rect [100 480 120 500] /P 3 0 R /F 4 /AP << /N << /Yes 8 0 R /Off 9 0 R >> >> >>",
    kFont.replace("/Encoding /WinAnsiEncoding ", ""),
    appearance("X"),
    appearance(""),
    "<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (choice) /V (one) /Opt [(one) (two) (three)] /Rect [100 400 300 430] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) >>",
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (total) /V (initial) /Rect [100 550 400 590] /P 4 0 R /F 4 /DA (/Helv 14 Tf 0 g) /AA << /C << /S /JavaScript /JS (event.value = this.getField\\("name"\\).value;) >> >> >>',
  ]);
}

function writeFixtures(dir: string): void {
  writeFileSync(join(dir, "text.pdf"), textPdf(), "latin1");
  writeFileSync(join(dir, "annots.pdf"), annotsPdf(), "latin1");
  writeFileSync(join(dir, "form.pdf"), formPdf(), "latin1");
  writeFileSync(join(dir, "image.png"), makePng(320, 240, [40, 120, 200]));
}

//--- operations

type Answer = "discard" | "existing" | "new" | "cancel";
type Op =
  | { k: "cmd"; name: string; answer: Answer }
  | { k: "cmdAt"; name: string; fx: number; fy: number }
  | { k: "open"; fixture: Fixture }
  | { k: "tab"; n: number }
  | { k: "select"; page: number; start: number; end: number }
  | { k: "click"; fx: number; fy: number }
  | { k: "drag"; fx: number; fy: number; fx2: number; fy2: number; ink: boolean }
  | { k: "key"; vk: number }
  | { k: "form"; page: number; idx: number; value: string }
  | { k: "toggle"; page: number; idx: number }
  | { k: "save"; how: "existing" | "as" | "copy" }
  | { k: "query"; what: string; arg: string | number }
  | { k: "idle" };

const kNav = [
  "CmdGoToNextPage",
  "CmdGoToPrevPage",
  "CmdGoToFirstPage",
  "CmdGoToLastPage",
  "CmdScrollDown",
  "CmdScrollUp",
  "CmdScrollDownPage",
  "CmdScrollUpPage",
  "CmdScrollDownHalfPage",
  "CmdScrollLeft",
  "CmdScrollRight",
  "CmdNavigateBack",
  "CmdNavigateForward",
  "CmdGoToNextChapter",
  "CmdGoToPrevChapter",
  "CmdGoToNextFavorite",
  "CmdGoToPrevFavorite",
];
const kZoom = [
  "CmdZoomIn",
  "CmdZoomOut",
  "CmdZoomFitPage",
  "CmdZoomFitWidth",
  "CmdZoomFitContent",
  "CmdZoomActualSize",
  "CmdZoom400",
  "CmdZoom1600",
  "CmdZoom25",
  "CmdZoomFitHeight",
  "CmdZoomShrinkToFit",
  "CmdZoomFitWidthAndContinuous",
  "CmdZoomFitPageAndSinglePage",
  "CmdToggleZoom",
  "CmdZoomToSelection",
  "CmdRotateLeft",
  "CmdRotateRight",
];
const kView = [
  "CmdSinglePageView",
  "CmdFacingView",
  "CmdBookView",
  "CmdToggleContinuousView",
  "CmdToggleMangaMode",
  "CmdToggleMirror",
  "CmdToggleUniformPageWidth",
  "CmdToggleTrimEmptyMargins",
  "CmdToggleAutoRotateWidePages",
  "CmdToggleFacingStepOne",
  "CmdShowWholePages",
  "CmdTogglePageInfo",
  "CmdInvertColors",
  "CmdToggleGrayscale",
  "CmdToggleLinks",
  "CmdToggleHighlightFormFields",
  "CmdTogglePageBoxes",
  "CmdToggleTransparencyGrid",
  "CmdTogglePageGrid",
  "CmdToggleToolbar",
];
const kSidebar = [
  "CmdToggleBookmarks",
  "CmdToggleTableOfContents",
  "CmdFavoriteToggle",
  "CmdFavoriteAdd",
  "CmdFavoriteDel",
  "CmdToggleThumbnails",
  "CmdExpandAll",
  "CmdCollapseAll",
  "CmdTocExpandToLevel1",
  "CmdToggleLayers",
  "CmdShowSignatures",
  "CmdToggleSidebarAutoHide",
];
const kTheme = ["CmdToggleLightDarkTheme", "CmdNextTheme", "CmdPrevTheme", "CmdTogglePreservePdfImages"];
const kFind = ["CmdFindFirst", "CmdFindNext", "CmdFindPrev", "CmdFindToggleMatchCase", "CmdFindNextSel"];
const kTabs = [
  "CmdNextTab",
  "CmdPrevTab",
  "CmdNextTabSmart",
  "CmdMoveTabLeft",
  "CmdMoveTabRight",
  "CmdDuplicateInNewTab",
  "CmdReopenLastClosedFile",
];
// may show the "Unsaved changes" prompt
const kTabClose = [
  "CmdClose",
  "CmdClose",
  "CmdCloseOtherTabs",
  "CmdCloseTabsToTheRight",
  "CmdCloseTabsToTheLeft",
  "CmdCloseAllTabs",
  "CmdReloadDocument",
  "CmdReloadDocument",
  "CmdDiscardChanges",
];
const kEdit = [
  "CmdToggleEditPDF",
  "CmdUndo",
  "CmdUndo",
  "CmdRedo",
  "CmdDeleteAnnotation",
  "CmdCutAnnotation",
  "CmdCopyAnnotation",
  "CmdPasteAnnotation",
  "CmdApplyRedactions",
  "CmdToggleShowAnnotations",
  "CmdSaveAnnotations",
  "CmdSelectAll",
  "CmdCopySelection",
  "CmdSelectCurrentPage",
  "CmdAnnotationHighlightBrush",
];
const kMarkup = [
  "CmdCreateAnnotHighlight",
  "CmdCreateAnnotUnderline",
  "CmdCreateAnnotStrikeOut",
  "CmdCreateAnnotSquiggly",
  "CmdCreateAnnotRedact",
];
const kCreateAt = [
  "CmdCreateAnnotText",
  "CmdCreateAnnotSquare",
  "CmdCreateAnnotCircle",
  "CmdCreateAnnotLine",
  "CmdCreateAnnotFreeText",
  "CmdCreateAnnotStamp",
  "CmdCreateAnnotCaret",
  "CmdCreateAnnotPolygon",
  "CmdCreateAnnotPolyLine",
];
const kAnswers: Answer[] = ["discard", "discard", "existing", "new", "cancel"];
const kFormValues = ["alpha", "Ünïcödé 日本", "x".repeat(300), "0", "two"];
// TestCurrentPdf requests. Not "search-next": it calls TextSearch::FindNext without a prior term, which
// the UI never does (FindNext asserts); CmdFindNext covers the real path.
const kQueries = ["text-page", "text-page", "editor-text", "search-first", "set-annot-contents", "clone-page"];
const kSearchTerms = ["needle", "SECRETONE", "word1", "zzz", "page 3"];

// Weights favor tab lifetime and editor-triggering ops: that is where the fork's risk is.
const kGenerators: [number, (r: Rng) => Op][] = [
  [8, (r) => ({ k: "cmd", name: r.pick(kNav), answer: "discard" })],
  [6, (r) => ({ k: "cmd", name: r.pick(kZoom), answer: "discard" })],
  [4, (r) => ({ k: "cmd", name: r.pick(kView), answer: "discard" })],
  [4, (r) => ({ k: "cmd", name: r.pick(kSidebar), answer: "discard" })],
  [2, (r) => ({ k: "cmd", name: r.pick(kTheme), answer: "discard" })],
  [3, (r) => ({ k: "cmd", name: r.pick(kFind), answer: "discard" })],
  [6, (r) => ({ k: "open", fixture: r.pick(kFixtures) })],
  [4, (r) => ({ k: "cmd", name: r.pick(kTabs), answer: "discard" })],
  [3, (r) => ({ k: "tab", n: r.int(8) })],
  [7, (r) => ({ k: "cmd", name: r.pick(kTabClose), answer: r.pick(kAnswers) })],
  [8, (r) => ({ k: "cmd", name: r.pick(kEdit), answer: r.pick(kAnswers) })],
  [4, (r) => ({ k: "select", page: 1 + r.int(3), start: r.int(20), end: r.int(3) === 0 ? -1 : 20 + r.int(30) })],
  [5, (r) => ({ k: "cmd", name: r.pick(kMarkup), answer: "discard" })],
  [5, (r) => ({ k: "cmdAt", name: r.pick(kCreateAt), fx: r.frac(), fy: r.frac() })],
  [4, (r) => ({ k: "click", fx: r.frac(), fy: r.frac() })],
  [2, (r) => ({ k: "drag", fx: r.frac(), fy: r.frac(), fx2: r.frac(), fy2: r.frac(), ink: false })],
  [2, (r) => ({ k: "drag", fx: r.frac(), fy: r.frac(), fx2: r.frac(), fy2: r.frac(), ink: true })],
  [3, (r) => ({ k: "key", vk: r.pick([VK_ESCAPE, VK_ESCAPE, VK_DELETE]) })],
  [4, (r) => ({ k: "form", page: 1 + r.int(2), idx: r.int(3), value: r.pick(kFormValues) })],
  [2, (r) => ({ k: "toggle", page: 1, idx: r.int(2) })],
  [4, (r) => ({ k: "save", how: r.pick(["existing", "as", "copy"] as const) })],
  [
    4,
    (r) => {
      const what = r.pick(kQueries);
      if (what.startsWith("search")) return { k: "query", what, arg: r.pick(kSearchTerms) };
      if (what === "set-annot-contents") return { k: "query", what, arg: r.pick(kFormValues) };
      return { k: "query", what, arg: 1 + r.int(3) };
    },
  ],
  [3, () => ({ k: "idle" })],
];

function genOps(seed: number, n: number): Op[] {
  const rng = new Rng(seed);
  const total = kGenerators.reduce((s, [w]) => s + w, 0);
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    let w = rng.int(total);
    for (const [weight, gen] of kGenerators) {
      if (w < weight) {
        ops.push(gen(rng));
        break;
      }
      w -= weight;
    }
  }
  return ops;
}

// every command name must exist, so a renamed one fails here instead of silently doing nothing
function checkCommandNames(): void {
  for (const list of [kNav, kZoom, kView, kSidebar, kTheme, kFind, kTabs, kTabClose, kEdit, kMarkup, kCreateAt]) {
    for (const name of list) cmdId(name);
  }
  cmdId("CmdCreateAnnotInk");
}

//--- running a session

type Failure = { kind: string; detail: string; opIndex: number };

class RunError extends Error {
  constructor(
    readonly kind: string,
    msg: string,
  ) {
    super(msg);
  }
}

// stats: per request, how many succeeded of how many sent; shows the ops reach the code they mean to
type Session = Awaited<ReturnType<typeof launchControlled>> & {
  dir: string;
  log: string;
  notes: string[];
  stats: Map<string, [number, number]>;
};

function tally(s: Session, what: string, ok: boolean): void {
  const t = s.stats.get(what) ?? [0, 0];
  s.stats.set(what, [t[0] + (ok ? 1 : 0), t[1] + 1]);
}

function statsText(s: Session): string {
  return [...s.stats]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([what, [ok, n]]) => `${what} ${ok}/${n}`)
    .join(", ");
}

function withTimeout<T>(p: Promise<T>, what: string, ms = kRequestTimeoutMs): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RunError("hang", `${what} took over ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// a control round trip: a timeout is a hang, any other error means the app went away
async function guard<T>(s: Session, p: () => Promise<T>, what: string): Promise<T> {
  if (s.proc.exitCode !== null) throw new RunError("exit", `app exited before ${what}`);
  try {
    return await withTimeout(p(), what);
  } catch (e) {
    if (e instanceof RunError) throw e;
    throw new RunError("exit", `${what}: ${(e as Error).message}`);
  }
}

async function request(s: Session, cmd: ControlCommand, args: ControlArg[], what: string): Promise<ControlArg[]> {
  const res = await guard(s, () => s.client.request(cmd, args), what);
  if (cmd !== ControlCommand.Ping) tally(s, what, res[0] === 0);
  return res;
}

function dialogs(pid: number): number[] {
  const found: number[] = [];
  enumWindows((hwnd) => {
    if (getWindowPid(hwnd) === pid && getClassName(hwnd) === kDialogClass && isWindowVisible(hwnd)) found.push(hwnd);
    return true;
  });
  return found;
}

// Answers the "Unsaved changes" prompt with the op's choice; any other dialog is noted and cancelled.
async function handleDialogs(s: Session, answer: Answer, opIndex: number): Promise<void> {
  const seen = new Map<number, number>();
  for (let round = 0; round < kMaxDialogRounds; round++) {
    await request(s, ControlCommand.Ping, [], "ping");
    const open = dialogs(s.proc.pid);
    if (open.length === 0) return;
    for (const dlg of open) {
      seen.set(dlg, (seen.get(dlg) ?? 0) + 1);
      const title = getWindowText(dlg);
      if (title === kUnsavedTitle) {
        let button = kIdCancel;
        if (answer === "discard") button = kBtnDiscard;
        if (answer === "existing") button = kBtnSaveExisting;
        if (answer === "new") {
          await request(s, ControlCommand.TestSaveFileName, [join(s.dir, `prompt-${opIndex}.pdf`)], "save name");
          button = kBtnSaveNew;
        }
        postMessage(dlg, kClickButton, button, 0);
        tally(s, `prompt ${answer}`, true);
        continue;
      }
      s.notes.push(`op ${opIndex}: dialog '${title}'`);
      postMessage(dlg, WM_COMMAND, kIdCancel, 0);
      if ((seen.get(dlg) ?? 0) > 1) postMessage(dlg, WM_CLOSE, 0, 0);
    }
  }
  const left = dialogs(s.proc.pid);
  if (left.length > 0) throw new RunError("dialog", `dialog '${getWindowText(left[0]!)}' did not close`);
}

function canvasPoint(s: Session, fx: number, fy: number): { canvas: number; x: number; y: number } {
  const canvas = findCanvas(s.frame);
  const r = getClientRect(canvas);
  return { canvas, x: Math.floor(r.right * fx), y: Math.floor(r.bottom * fy) };
}

// posted mouse messages with the app's test cursor at the point, not injected input
async function mouse(s: Session, fx: number, fy: number, fx2: number, fy2: number): Promise<void> {
  const a = canvasPoint(s, fx, fy);
  const b = canvasPoint(s, fx2, fy2);
  if (!a.canvas) return;
  const sa = clientToScreen(a.canvas, a.x, a.y);
  await guard(s, () => moveTestCursor(sa.x, sa.y, s.client), "test cursor");
  postMessage(a.canvas, WM_MOUSEMOVE, 0, packCoords(a.x, a.y));
  postMessage(a.canvas, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(a.x, a.y));
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(a.x + ((b.x - a.x) * i) / steps);
    const y = Math.round(a.y + ((b.y - a.y) * i) / steps);
    postMessage(a.canvas, WM_MOUSEMOVE, MK_LBUTTON, packCoords(x, y));
  }
  const sb = clientToScreen(a.canvas, b.x, b.y);
  await guard(s, () => moveTestCursor(sb.x, sb.y, s.client), "test cursor");
  postMessage(a.canvas, WM_LBUTTONUP, 0, packCoords(b.x, b.y));
}

function postCommand(s: Session, name: string, lParam = 0): void {
  postMessage(s.frame, WM_COMMAND, cmdId(name), lParam);
}

async function tabCount(s: Session): Promise<number> {
  const res = await request(s, ControlCommand.TestSelectTab, [-1], "tab count");
  return Number(/count=(\d+)/.exec(String(res[1] ?? ""))?.[1] ?? 0);
}

let gLastSaved = "";
// form.pdf and the saved copies made from it: form ops act on one of these
const gFormPaths = new Set<string>();

const pathKey = (p: string) => p.replaceAll("/", "\\").toLowerCase();

// the selected tab index and each tab's file path, from TestSelectTab's per-tab lines
async function tabPaths(s: Session): Promise<{ idx: number; paths: string[] }> {
  const res = await request(s, ControlCommand.TestSelectTab, [-1], "tab paths");
  const text = String(res[1] ?? "");
  const idx = Number(/idx=(-?\d+)/.exec(text)?.[1] ?? -1);
  const paths = [...text.matchAll(/^tab=\d+ path=(.*)$/gm)].map((m) => pathKey(m[1]!));
  return { idx, paths };
}

function openPath(s: Session, path: string, what: string): void {
  try {
    sendCopyDataW(s.frame, kDdeCopyData, `[Open("${path}", 0, 1, 0)]`);
  } catch (e) {
    throw new RunError("hang", `open ${what}: ${(e as Error).message}`);
  }
}

// Makes a form document's tab current, opening form.pdf when no tab shows one.
async function selectFormTab(s: Session): Promise<void> {
  let t = await tabPaths(s);
  let at = t.paths.findIndex((p) => gFormPaths.has(p));
  if (at < 0) {
    openPath(s, join(s.dir, "form.pdf"), "form");
    t = await tabPaths(s);
    at = t.paths.findIndex((p) => gFormPaths.has(p));
  }
  if (at >= 0 && at !== t.idx) await request(s, ControlCommand.TestSelectTab, [at], "select form tab");
}

// a save from a form tab makes another form document
async function currentIsForm(s: Session): Promise<boolean> {
  const t = await tabPaths(s);
  return t.idx >= 0 && gFormPaths.has(t.paths[t.idx] ?? "");
}

async function runOp(s: Session, op: Op, i: number): Promise<void> {
  let answer: Answer = "discard";
  switch (op.k) {
    case "cmd":
      // closing the window's last tab-less page quits the app
      if (op.name === "CmdClose" && (await tabCount(s)) === 0) return;
      answer = op.answer;
      postCommand(s, op.name);
      break;
    case "cmdAt": {
      const p = canvasPoint(s, op.fx, op.fy);
      postCommand(s, op.name, packCoords(p.x, p.y));
      break;
    }
    case "open": {
      const path =
        op.fixture === "saved" ? gLastSaved : join(s.dir, `${op.fixture}.${op.fixture === "image" ? "png" : "pdf"}`);
      if (!path || !existsSync(path)) return;
      openPath(s, path, op.fixture);
      break;
    }
    case "tab": {
      const n = await tabCount(s);
      if (n > 0) await request(s, ControlCommand.TestSelectTab, [op.n % n], "select tab");
      break;
    }
    case "select":
      await request(s, ControlCommand.TestSeedTextSelection, [op.page, op.start, op.end], "seed selection");
      break;
    case "click":
      await mouse(s, op.fx, op.fy, op.fx, op.fy);
      break;
    case "drag":
      if (op.ink) postCommand(s, "CmdCreateAnnotInk");
      await mouse(s, op.fx, op.fy, op.fx2, op.fy2);
      if (op.ink) await request(s, ControlCommand.TestMarkupAnnots, ["finish-ink", 0, 0], "finish ink");
      break;
    case "key":
      postMessage(s.frame, WM_KEYDOWN, op.vk, 0);
      postMessage(s.frame, WM_KEYUP, op.vk, 0);
      break;
    case "form":
      await selectFormTab(s);
      await request(s, ControlCommand.TestSetFormField, [op.page, op.idx, op.value], "form field");
      break;
    case "toggle":
      await selectFormTab(s);
      await request(s, ControlCommand.TestToggleFormButton, [op.page, op.idx], "form button");
      break;
    case "save": {
      const dst = join(s.dir, `saved-${i}.pdf`);
      const fromForm = op.how !== "existing" && (await currentIsForm(s));
      if (op.how === "existing") {
        await request(s, ControlCommand.ResolveUnsavedChanges, ["save"], "save");
      } else if (op.how === "as") {
        const res = await request(s, ControlCommand.ResolveUnsavedChanges, ["save-as", dst], "save as");
        if (res[0] === 0) gLastSaved = dst;
        if (res[0] === 0 && fromForm) gFormPaths.add(pathKey(dst));
      } else {
        const res = await request(s, ControlCommand.TestSaveFileAs, [dst], "save copy");
        if (res[0] === 0 && existsSync(dst)) gLastSaved = dst;
        if (res[0] === 0 && fromForm) gFormPaths.add(pathKey(dst));
      }
      break;
    }
    case "query":
      await request(s, ControlCommand.TestCurrentPdf, [op.what, op.arg], op.what);
      break;
    case "idle": {
      // with no document WaitRenderIdle only waits out its timeout
      if ((await tabCount(s)) === 0) return;
      const res = await request(s, ControlCommand.WaitRenderIdle, [20000 * SLOW_BUILD_FACTOR], "wait render idle");
      // a render that never settles is noted, not fatal: a 1600% page may legitimately take long
      if (res[0] !== 0 && /timeout/.test(String(res[1]))) s.notes.push(`op ${i}: render not idle: ${String(res[1])}`);
      break;
    }
  }
  await handleDialogs(s, answer, i);
  if (s.proc.exitCode !== null) throw new RunError("exit", `app exited after op ${i}`);
}

function engine(): string {
  return process.env.SOLOKPDF_ENGINE === "mupdf" ? "mupdf" : "pdfium";
}

async function launch(dir: string): Promise<Session> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFixtures(dir);
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nRestoreSession = false\nCheckForUpdates = false\n");
  const log = join(dir, "app.log");
  const env: Record<string, string> = { SOLOKPDF_ENGINE: engine() };
  if (IS_ASAN && !process.env.ASAN_OPTIONS) {
    env.ASAN_OPTIONS = `windows_hook_legacy_allocators=0:suppressions="${join(ROOT, "asan.supp")}"`;
  }
  gLastSaved = "";
  gFormPaths.clear();
  gFormPaths.add(pathKey(join(dir, "form.pdf")));
  const args = ["-appdata", dir, "-log-to-file", log, join(dir, "text.pdf"), join(dir, "annots.pdf")];
  const s = await launchControlled(args, { env });
  const session: Session = { ...s, dir, log, notes: [], stats: new Map() };
  await request(session, ControlCommand.SetNotificationsEnabled, [0], "notifications off");
  return session;
}

// stderr only completes once the process exited
async function classify(s: Session, e: unknown): Promise<{ kind: string; detail: string }> {
  let kind = e instanceof RunError ? e.kind : "harness";
  let detail = String((e as Error)?.message ?? e);
  if (kind === "hang" || kind === "dialog") {
    if (kind === "hang") await captureStartupFailure(s.proc.pid, "hang", join(s.dir, "hang"));
    s.client.close();
    await killAndWait(s.proc);
    return { kind, detail };
  }
  const code = await withTimeout(s.proc.exited, "exit", 10000).catch(() => null);
  if (code === null) {
    s.client.close();
    await killAndWait(s.proc);
    return { kind, detail };
  }
  const stderr = await takeStderr(s.proc);
  if (/AddressSanitizer/.test(stderr)) kind = "asan";
  else if (code === DEBUG_REPORT_EXIT_CODE) kind = "assert";
  else if (code !== 0) kind = "crash";
  else if (kind === "exit") kind = "quit";
  detail += ` (exit code ${code}, 0x${(code >>> 0).toString(16)})`;
  return { kind, detail };
}

// Quit never prompts (E72); a dialog at shutdown is answered so the app can exit, and reported.
async function waitQuit(s: Session, shown: string[]): Promise<number | null> {
  const deadline = Date.now() + kQuitTimeoutMs;
  while (Date.now() < deadline) {
    const code = await withTimeout(s.proc.exited, "quit", 250).catch(() => null);
    if (code !== null) return code;
    for (const dlg of dialogs(s.proc.pid)) {
      const title = getWindowText(dlg);
      shown.push(title);
      if (title === kUnsavedTitle) postMessage(dlg, kClickButton, kBtnDiscard, 0);
      else postMessage(dlg, WM_COMMAND, kIdCancel, 0);
    }
  }
  return null;
}

type Outcome = { failure: Failure | null; notes: string[]; stderr: string; log: string; stats: string };

// Runs ops in one app session; the first failure ends it. logPath gets each op before it runs.
async function runSession(dir: string, ops: Op[], logPath?: string): Promise<Outcome> {
  let s: Session;
  try {
    s = await launch(dir);
  } catch (e) {
    return { failure: { kind: "startup", detail: String(e), opIndex: -1 }, notes: [], stderr: "", log: "", stats: "" };
  }
  let failure: Failure | null = null;
  for (const [i, op] of ops.entries()) {
    if (logPath) appendFileSync(logPath, `${JSON.stringify(op)}\n`);
    try {
      await runOp(s, op, i);
    } catch (e) {
      failure = { ...(await classify(s, e)), opIndex: i };
      break;
    }
  }
  if (!failure) {
    try {
      await request(s, ControlCommand.Quit, [], "quit");
    } catch {}
    s.client.close();
    const shown: string[] = [];
    const code = await waitQuit(s, shown);
    if (code === null) {
      await captureStartupFailure(s.proc.pid, "quit", join(s.dir, "hang"));
      await killAndWait(s.proc);
      failure = { kind: "hang", detail: "app did not exit after Quit", opIndex: ops.length };
    } else if (code !== 0) {
      const stderr = await takeStderr(s.proc);
      const kind = /AddressSanitizer/.test(stderr) ? "asan" : code === DEBUG_REPORT_EXIT_CODE ? "assert" : "crash";
      failure = { kind, detail: `exit code ${code} at shutdown`, opIndex: ops.length };
    } else if (shown.length > 0) {
      failure = { kind: "dialog", detail: `quit showed dialog '${shown[0]}'`, opIndex: ops.length };
    }
  }
  const stderr = await takeStderr(s.proc);
  if (!failure && /AddressSanitizer/.test(stderr))
    failure = { kind: "asan", detail: "report on stderr", opIndex: ops.length };
  const log = existsSync(s.log) ? readFileSync(s.log, "utf8") : "";
  return { failure, notes: s.notes, stderr, log, stats: statsText(s) };
}

//--- replay and shrink

function readOps(path: string): Op[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => JSON.parse(l) as Op);
}

function writeOps(path: string, header: string, ops: Op[]): void {
  writeFileSync(path, `# ${header}\n${ops.map((o) => JSON.stringify(o)).join("\n")}\n`);
}

// Drops chunks of ops while the same kind of failure still happens, within a bounded number of runs.
async function shrink(dir: string, ops: Op[], kind: string, maxAttempts: number): Promise<Op[]> {
  let cur = ops;
  let chunk = Math.ceil(cur.length / 2);
  let attempts = 0;
  while (chunk >= 1 && attempts < maxAttempts) {
    let removed = false;
    for (let start = 0; start < cur.length && attempts < maxAttempts; ) {
      const cand = [...cur.slice(0, start), ...cur.slice(start + chunk)];
      if (cand.length === 0) {
        start += chunk;
        continue;
      }
      attempts++;
      const out = await runSession(dir, cand);
      if (out.failure?.kind === kind) {
        cur = out.failure.opIndex < cand.length ? cand.slice(0, out.failure.opIndex + 1) : cand;
        removed = true;
        console.log(`  shrink: ${cur.length} ops still fail (${attempts}/${maxAttempts})`);
      } else {
        start += chunk;
      }
    }
    if (!removed) chunk = Math.floor(chunk / 2);
  }
  return cur;
}

async function record(
  name: string,
  header: string,
  ops: Op[],
  out: Outcome,
  dir: string,
  shrinkAttempts: number,
): Promise<string> {
  const f = out.failure!;
  const findingDir = join(kFindingsDir, `${name}-${f.kind}`);
  rmSync(findingDir, { recursive: true, force: true });
  mkdirSync(findingDir, { recursive: true });
  const failing = f.opIndex >= 0 && f.opIndex < ops.length ? ops.slice(0, f.opIndex + 1) : ops;
  writeOps(join(findingDir, "ops.jsonl"), header, failing);
  // the hung process's thread stacks (cdb) and minidump; replay wipes the run dir
  const hangDir = join(dir, "hang");
  if (existsSync(hangDir)) cpSync(hangDir, join(findingDir, "hang"), { recursive: true });
  writeFileSync(join(findingDir, "stderr.txt"), out.stderr);
  writeFileSync(join(findingDir, "app.log"), out.log);
  let summary = `${f.kind} at op ${f.opIndex}: ${f.detail}\nlast op: ${JSON.stringify(ops[f.opIndex] ?? null)}\n`;
  if (f.kind !== "startup" && shrinkAttempts > 0) {
    const again = await runSession(dir, failing);
    if (again.failure?.kind !== f.kind) {
      summary += `replay: did not reproduce (${again.failure?.kind ?? "passed"}); not shrunk\n`;
    } else {
      summary += `replay: reproduced at op ${again.failure.opIndex}\n`;
      const shrunk = await shrink(dir, failing, f.kind, shrinkAttempts);
      writeOps(join(findingDir, "shrunk.jsonl"), `${header} shrunk`, shrunk);
      summary += `shrunk: ${shrunk.length} ops in shrunk.jsonl\n`;
    }
  }
  writeFileSync(join(findingDir, "summary.txt"), summary);
  return `${findingDir}: ${summary.split("\n")[0]}`;
}

export async function testit(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: false,
    options: {
      seed: { type: "string" },
      ops: { type: "string" },
      runs: { type: "string" },
      replay: { type: "string" },
      "shrink-attempts": { type: "string" },
    },
  });
  checkCommandNames();
  const seed = Number(values.seed ?? 1);
  const nOps = Number(values.ops ?? 300);
  const runs = Number(values.runs ?? 1);
  const shrinkAttempts = Number(values["shrink-attempts"] ?? 30);
  const base = tmpPath("monkey");
  mkdirSync(base, { recursive: true });
  mkdirSync(kFindingsDir, { recursive: true });
  const exeKind = IS_ASAN ? "asan" : "dbg";

  const findings: string[] = [];
  const notes: string[] = [];
  const plan: { name: string; header: string; ops: Op[] }[] = [];
  if (typeof values.replay === "string") {
    const ops = readOps(values.replay);
    plan.push({ name: `replay-${engine()}-${exeKind}`, header: `replay of ${values.replay} engine=${engine()}`, ops });
  } else {
    for (let r = 0; r < runs; r++) {
      const runSeed = seed + r;
      const header = `seed=${runSeed} ops=${nOps} engine=${engine()} exe=${exeKind}`;
      plan.push({ name: `${engine()}-${exeKind}-seed${runSeed}`, header, ops: genOps(runSeed, nOps) });
    }
  }

  for (const { name, header, ops } of plan) {
    const dir = join(base, name);
    const opLog = join(base, `${name}.jsonl`);
    writeFileSync(opLog, `# ${header}\n`);
    const t0 = performance.now();
    const out = await runSession(dir, ops, opLog);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    for (const n of out.notes) notes.push(`${name} ${n}`);
    if (!out.failure) {
      console.log(`${name}: ${ops.length} ops passed in ${secs} s, ${out.notes.length} notes; succeeded: ${out.stats}`);
      continue;
    }
    console.log(
      `${name}: FAILED ${out.failure.kind} at op ${out.failure.opIndex} after ${secs} s: ${out.failure.detail}`,
    );
    findings.push(await record(name, header, ops, out, dir, shrinkAttempts));
    console.log(`FINDING ${findings[findings.length - 1]}`);
  }
  for (const n of notes) console.log(`NOTE ${n}`);
  console.log(`${plan.length} runs, ${findings.length} findings, ${notes.length} notes`);
  if (findings.length > 0) throw new Error(`monkey findings:\n${findings.join("\n")}`);
}

if (import.meta.main) await runStandalone(testit);
