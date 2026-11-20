import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { goToPage, makePdf, pagePoint, selectedText } from "./ad-hoc-e123-busy-actions";
import { ControlCommand } from "./control";
import { getTestClipboardData, getTestClipboardText } from "./test-clipboard";
import {
  APP_NAME,
  cmdId,
  EXE,
  loadPng,
  pngPixel,
  pollUntil,
  runStandalone,
  SETTINGS_FILE,
  tmpPath,
  USE_NG,
} from "./util";
import {
  choosePopupCommand,
  clickAt,
  findCanvas,
  findChildByClass,
  killAndWait,
  launchControlled,
  moveTestCursor,
  openContextMenu,
  openPopupSubmenu,
  waitForContextMenu,
  waitForTitle,
} from "./win-automation";
import {
  clientToScreen,
  enumWindows,
  getControlText,
  getClientRect,
  getMenuItemChecked,
  getMenuItemCount,
  getMenuItemId,
  getMenuItemText,
  getPopupMenuHandle,
  getSubMenu,
  getWindowPid,
  getWindowRect,
  getWindowText,
  MK_LBUTTON,
  packCoords,
  postMessage,
  readMenuTree,
  sendMessage,
  sleep,
  VK_DOWN,
  VK_ESCAPE,
  WM_KEYDOWN,
  WM_CONTEXTMENU,
  WM_LBUTTONDBLCLK,
  WM_LBUTTONUP,
  waitForTopWindow,
} from "./winapi";

const WM_COMMAND = 0x0111;
const WM_SYSCOMMAND = 0x0112;
const SC_KEYMENU = 0xf100;
const firstMenu = 50000;
const ttsReadCurrentPage = 0x7200;
const ttsReadFromCursor = 0x7204;

function directIds(menu: bigint): number[] {
  return Array.from({ length: getMenuItemCount(menu) }, (_, i) => getMenuItemId(menu, i)).filter(
    (id) => id > 0 && id < firstMenu,
  );
}

function submenuWith(menu: bigint, id: number): number | undefined {
  return Array.from({ length: getMenuItemCount(menu) }, (_, pos) => pos).find((pos) =>
    directIds(getSubMenu(menu, pos)).includes(id),
  );
}

async function checkRestrictedMenu(dir: string, pdf: string): Promise<void> {
  const config = join(dirname(EXE), "sumatrapdfrestrict.ini");
  writeFileSync(config, "[Policies]\nDiskAccess = 1\nSavePreferences = 1\nCopySelection = 0\n", { flag: "wx" });
  try {
    const { proc, client, frame } = await launchControlled([
      "-appdata",
      dir,
      "-view",
      "single page",
      "-zoom",
      "fit page",
      pdf,
    ]);
    try {
      await client.waitForRenderIdle();
      const canvas = findCanvas(frame);
      const at = await pagePoint(client, { x: 150, y: 700 });
      const screen = clientToScreen(canvas, at.x, at.y);
      await moveTestCursor(screen.x, screen.y, client);
      openContextMenu(canvas, screen.x, screen.y);
      const popup = await waitForContextMenu(1500, frame);
      const menu = getPopupMenuHandle(popup);
      const ids = directIds(menu);
      if (!ids.includes(cmdId("CmdFavoriteAdd")) || ids.includes(cmdId("CmdCopyLinkTarget"))) {
        throw new Error("restricted canvas still offers link copy, or lost the page favorite");
      }
      postMessage(popup, WM_KEYDOWN, VK_ESCAPE, 0);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  } finally {
    rmSync(config);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") {
    console.log("solok-menu-layout: SolokPDF Win32 only");
    return;
  }
  const dir = tmpPath("solok-menu-layout");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "menu.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const language = process.env.SOLOK_MENU_LANGUAGE ?? "en";
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = ${language}\nCheckForUpdates = false\nRestoreSession = false\nHomePageViewMode = list\n` +
      "FilePicker = sumatrapdf\nZoomLevels = 75 100 137\n" +
      "SelectionHandlers [\n  [\n    Name = Menu Lookup\n    URL = https://example.invalid/?q=${selection}\n  ]\n]\n" +
      `FileStates [\n  [\n    FilePath = ${pdf}\n    OpenCount = 5\n  ]\n]\n`,
  );
  const width = process.env.SOLOK_MENU_NARROW ? "430" : "750";
  const { proc, client, frame } = await launchControlled([
    "-appdata",
    dir,
    "-window-pos",
    `${width}x640@100x100`,
    "-view",
    "single page",
    "-zoom",
    "fit page",
    pdf,
  ]);
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  try {
    await client.waitForRenderIdle();
    const frameRect = getWindowRect(frame);
    console.log("Frame width", frameRect.right - frameRect.left);
    const canvas = findCanvas(frame);
    const inspect = async (name: string, open: () => Promise<void>) => {
      await open();
      const popup = await waitForContextMenu(1500, frame);
      const menu = getPopupMenuHandle(popup);
      const items = readMenuTree(menu);
      console.log(name, JSON.stringify(items));
      return {
        ids: directIds(menu),
        items,
        menu,
        popup,
        dismiss: async () => {
          if (!popup) return;
          postMessage(popup, WM_KEYDOWN, VK_ESCAPE, 0);
          await sleep(150);
        },
        run: async (cmd: string) => {
          if (!choosePopupCommand(popup, cmdId(cmd))) {
            throw new Error(`${cmd} is missing from ${name}`);
          }
          await sleep(150);
        },
      };
    };
    const body = async (name: string, pt: { x: number; y: number }, ...expected: string[]) => {
      const menu = await inspect(name, async () => {
        const screen = clientToScreen(canvas, pt.x, pt.y);
        await moveTestCursor(screen.x, screen.y, client);
        openContextMenu(canvas, screen.x, screen.y);
      });
      check(
        expected.every((cmd, i) => menu.ids[i] === cmdId(cmd)),
        `${name} begins with ${expected.join(", ")}; got ${menu.ids}`,
      );
      check(!menu.ids.includes(cmdId("CmdToggleToolbar")), `${name} offers toolbar controls`);
      return menu;
    };
    await client.request(ControlCommand.TestClipboardText, ["enable"]);
    const margin = await body("PDF margin", await pagePoint(client, { x: 310, y: 350 }), "CmdFavoriteAdd");
    const speechPos = submenuWith(margin.menu, cmdId("CmdReadAloudFromTopPage"));
    if (speechPos !== undefined) {
      const speech = await openPopupSubmenu(margin.popup, speechPos);
      check(
        directIds(getPopupMenuHandle(speech)).includes(ttsReadFromCursor),
        "canvas Read Aloud offers the click position",
      );
      if (speech) postMessage(speech, WM_KEYDOWN, VK_ESCAPE, 0);
      await sleep(100);
    } else {
      console.log("SKIP canvas Read Aloud submenu");
    }
    await margin.dismiss();
    const outside = await body("outside the page", { x: 0, y: 0 });
    check(
      !outside.ids.includes(cmdId("CmdFavoriteAdd")) &&
        submenuWith(outside.menu, cmdId("CmdReadAloudFromTopPage")) === undefined,
      "page actions are hidden outside the page",
    );
    await outside.dismiss();
    const link = await body("web link", await pagePoint(client, { x: 150, y: 700 }), "CmdCopyLinkTarget");
    await link.run("CmdCopyLinkTarget");
    check((await getTestClipboardText(client)) === "https://example.com/e123", "link action copied its address");
    const internal = await body("internal link", await pagePoint(client, { x: 460, y: 700 }));
    check(!internal.ids.includes(cmdId("CmdCopyLinkTarget")), "internal link offers address copy");
    await internal.dismiss();
    const image = await body("PDF image", await pagePoint(client, { x: 173, y: 450 }), "CmdCopyImage", "CmdSaveImage");
    if (image.ids.includes(cmdId("CmdCopyImage"))) {
      await image.run("CmdCopyImage");
      const bitmap = Buffer.from(await getTestClipboardData(client, 2)); // CF_BITMAP
      check(
        bitmap.length >= 56 &&
          bitmap.readInt32LE(4) === 2 &&
          bitmap.readInt32LE(8) === -2 &&
          bitmap[40] === 0 &&
          bitmap[41] === 0 &&
          bitmap[42] === 255,
        "image action copied the 2x2 red bitmap",
      );
    } else {
      await image.dismiss();
    }
    const save = await body("save image", await pagePoint(client, { x: 173, y: 450 }), "CmdCopyImage", "CmdSaveImage");
    await save.run("CmdSaveImage");
    const imageWindow = await waitForTopWindow(proc.pid!, "SUMATRA_PDF_IMAGE_EDIT", 3000);
    const destination = findChildByClass(imageWindow, "Edit");
    const savedPath = getControlText(destination);
    check(savedPath.startsWith(join(dir, "menu_page_1")), "image editor targets the clicked page");
    const editRect = getWindowRect(destination);
    const imageRect = getClientRect(imageWindow);
    const imageOrigin = clientToScreen(imageWindow, 0, 0);
    const editHeight = editRect.bottom - editRect.top;
    // Save is on the destination row, at the right end of the button strip.
    await clickAt(
      imageWindow,
      imageRect.right - Math.round(editHeight * 4.5),
      editRect.top - imageOrigin.y + (editHeight >> 1),
    );
    await pollUntil(() => existsSync(savedPath), Boolean, {
      timeoutMs: 2500,
      error: "Save Image did not write its output",
    });
    await waitForTitle(frame, (title) => title.includes(basename(savedPath)));
    const png = loadPng(savedPath);
    check(
      png.w === 2 && png.h === 2 && pngPixel(png, 0, 0).join(",") === "255,0,0",
      "Save Image wrote the 2x2 red bitmap",
    );
    sendMessage(frame, WM_COMMAND, cmdId("CmdClose"), 0);
    await waitForTitle(frame, (title) => title.includes("menu.pdf"));
    sendMessage(frame, WM_COMMAND, cmdId("CmdSelectAll"), 0);
    const rect = await body(
      "rectangle over image",
      await pagePoint(client, { x: 173, y: 450 }),
      "CmdCopySelectionAsImage",
      "CmdSaveSelectionAsImage",
      "CmdCopyImage",
      "CmdSaveImage",
    );
    check(
      !rect.items.some((item) => item.items?.some((child) => child.text === "Menu Lookup")),
      "rectangle selection excludes text handlers",
    );
    await rect.dismiss();
    sendMessage(frame, WM_KEYDOWN, VK_ESCAPE, 0);
    await goToPage(client, 3);
    const at = await pagePoint(client, { x: 102, y: 410 }, 3);
    const screen = clientToScreen(canvas, at.x, at.y);
    await moveTestCursor(screen.x, screen.y, client);
    sendMessage(canvas, WM_LBUTTONDBLCLK, MK_LBUTTON, packCoords(at.x, at.y));
    sendMessage(canvas, WM_LBUTTONUP, 0, packCoords(at.x, at.y));
    await pollUntil(
      () => selectedText(client),
      (text) => text.trim() === "Select",
      { timeoutMs: 3000, error: "no text selection" },
    );
    const selection = await body("text selection", at, "CmdCopySelection", "CmdCreateAnnotHighlight");
    check(
      selection.items.some((item) => item.items?.some((child) => child.text === "Menu Lookup" && !child.disabled)),
      "Selection Actions contains the custom text handler",
    );
    if (selection.ids.includes(cmdId("CmdCopySelection"))) {
      await selection.run("CmdCopySelection");
      check((await getTestClipboardText(client)).trim() === "Select", "selection action copied its text");
      const markup = await body("text highlight", at, "CmdCopySelection", "CmdCreateAnnotHighlight");
      await markup.run("CmdCreateAnnotHighlight");
      const annots = await client.request(ControlCommand.TestMarkupAnnots, []);
      check(/type=Highlight page=3/.test(String(annots[1])), "highlight was created on page 3");
      sendMessage(frame, WM_COMMAND, cmdId("CmdDiscardChanges"), 0);
      await client.waitForRenderIdle();
    } else {
      await selection.dismiss();
    }

    for (const mode of ["CmdToggleFullscreen", "CmdTogglePresentationMode"]) {
      sendMessage(frame, WM_COMMAND, cmdId(mode), 0);
      const fullscreen = await body(mode, await pagePoint(client, { x: 310, y: 300 }, 3), "CmdToggleFullscreen");
      check(fullscreen.items[1]?.items?.length === 7 || fullscreen.items[1]?.items?.length === 8, `${mode} menu copy`);
      await fullscreen.run("CmdToggleFullscreen");
      const restored = await body("restored window", await pagePoint(client, { x: 310, y: 300 }, 3), "CmdFavoriteAdd");
      await restored.dismiss();
    }

    sendMessage(frame, WM_COMMAND, cmdId("CmdToggleMenuBar"), 0);
    for (let i = 0; i < 10; i++) {
      const { ids, menu, popup, dismiss, items } = await inspect(`menubar[${i}]`, async () => {
        postMessage(frame, WM_COMMAND, firstMenu + i, 0);
      });
      if (i === 0) check(ids[0] === cmdId("CmdOpenFile"), "File begins with Open");
      if (i === 1) {
        check(ids.includes(cmdId("CmdZoomFitWidth")), "View offers Fit Width directly");
        check(ids.includes(cmdId("CmdZoomFitPage")), "View offers Fit Page directly");
        const positions = Array.from({ length: getMenuItemCount(menu) }, (_, pos) => pos);
        const zoomPos = submenuWith(menu, cmdId("CmdZoomActualSize"));
        const fitPage = positions.find((pos) => getMenuItemId(menu, pos) === cmdId("CmdZoomFitPage"));
        check(fitPage !== undefined && getMenuItemChecked(menu, fitPage), "Fit Page is checked in View");
        const zoomPopup = zoomPos === undefined ? 0 : await openPopupSubmenu(popup, zoomPos);
        check(zoomPopup !== 0, "Zoom submenu opens with Right Arrow");
        if (zoomPopup) {
          const zoom = getPopupMenuHandle(zoomPopup);
          const levels = Array.from({ length: getMenuItemCount(zoom) }, (_, pos) => getMenuItemText(zoom, pos));
          const custom = levels.indexOf("137%");
          check(custom >= 0, "Zoom shows configured magnifications");
          if (custom >= 0 && choosePopupCommand(zoomPopup, getMenuItemId(zoom, custom))) {
            await sleep(550);
            const view = await inspect("View after custom zoom", async () => {
              postMessage(frame, WM_COMMAND, firstMenu + 1, 0);
            });
            const zoomPos = submenuWith(view.menu, cmdId("CmdZoomActualSize"));
            const currentZoom = zoomPos === undefined ? 0n : getSubMenu(view.menu, zoomPos);
            check(
              getMenuItemChecked(currentZoom, custom) &&
                fitPage !== undefined &&
                !getMenuItemChecked(view.menu, fitPage),
              "custom zoom is checked and Fit Page is cleared",
            );
            await view.dismiss();
          } else {
            postMessage(zoomPopup, WM_KEYDOWN, VK_ESCAPE, 0);
            await sleep(100);
          }
        }
      }
      if (i === 4) {
        check(ids[0] === cmdId("CmdCommandPalette"), "Tools begins with Command Palette");
        check(
          items.some((item) => item.items?.some((child) => child.text === "Menu Lookup" && child.disabled)),
          "Tools shows the custom handler disabled without a selection",
        );
        const speechPos = submenuWith(menu, cmdId("CmdReadAloudFromTopPage"));
        if (speechPos !== undefined) {
          const speech = await openPopupSubmenu(popup, speechPos);
          const speechIds = directIds(getPopupMenuHandle(speech));
          check(
            speechIds.includes(ttsReadCurrentPage) && !speechIds.includes(ttsReadFromCursor),
            "Tools Read Aloud uses the active page",
          );
          if (speech) postMessage(speech, WM_KEYDOWN, VK_ESCAPE, 0);
          await sleep(100);
        } else {
          console.log("SKIP Tools Read Aloud submenu");
        }
      }
      if (i === 3) check(ids.includes(cmdId("CmdFavoriteToggle")), "Favorites follows Go To");
      if (i === 5) check(ids[0] === cmdId("CmdOptions"), "Settings follows Tools");
      if (i === 6) check(ids.includes(cmdId("CmdHelpAbout")), "Help follows Settings");
      if (i === 7 && menu) check(ids.includes(cmdId("CmdToggleLinks")), "only Debug may follow Help");
      if (i > 7) check(!menu, `unexpected menubar item ${i}`);
      if (language === "ja" && i === 4)
        check(
          items.some((item) => item.text === "PDF操作"),
          "Japanese Tools labels",
        );
      await dismiss();
      if (!menu) break;
    }
    sendMessage(frame, WM_COMMAND, cmdId("CmdToggleMenuBar"), 0);
    const keyboard = await inspect("hidden menu via SC_KEYMENU", async () => {
      postMessage(frame, WM_SYSCOMMAND, SC_KEYMENU, 0);
    });
    const settings = getSubMenu(keyboard.menu, 5);
    check(directIds(settings).includes(cmdId("CmdOptions")), "keyboard menu reaches Settings with the bar hidden");
    await keyboard.dismiss();
    sendMessage(frame, WM_COMMAND, cmdId("CmdToggleMenuBar"), 0);
    sendMessage(frame, WM_COMMAND, cmdId("CmdGoToHomePage"), 0);
    await sleep(550);
    const home = await inspect("Home/File", async () => {
      postMessage(frame, WM_COMMAND, firstMenu, 0);
    });
    if (language === "en") {
      await home.run("CmdOpenFile");
      const picker = await pollUntil(
        () => {
          let found = 0;
          enumWindows((hwnd) => {
            if (getWindowPid(hwnd) === proc.pid && getWindowText(hwnd) === "Navigate Files in Folder") found = hwnd;
            return found === 0;
          });
          return found;
        },
        Boolean,
        { timeoutMs: 3000, error: "Open did not open the configured file picker" },
      );
      postMessage(picker, 0x0010 /* WM_CLOSE */, 0, 0);
    } else {
      await home.dismiss();
    }
    const homeCanvas = findCanvas(frame);
    postMessage(homeCanvas, WM_KEYDOWN, VK_DOWN, 0);
    await pollUntil(
      () => client.homeSelection(),
      (state) => state.path.startsWith(dir),
      { timeoutMs: 3000, error: "no Home selection" },
    );
    const entry = await inspect("Home entry", async () => {
      postMessage(homeCanvas, WM_CONTEXTMENU, homeCanvas, -1);
    });
    check(
      ["CmdOpenSelectedDocument", "CmdPinSelectedDocument", "CmdForgetSelectedDocument"].every(
        (cmd, i) => entry.ids[i] === cmdId(cmd),
      ),
      "Home entry starts with Open, Pin and Remove From History",
    );
    check(entry.ids.includes(cmdId("CmdDeleteFile")), "Home keeps a separate disk deletion command");
    await entry.dismiss();
  } finally {
    client.close();
    await killAndWait(proc);
  }
  if (failures.length) throw new Error(failures.join("\n"));
  await checkRestrictedMenu(dir, pdf);
}

if (import.meta.main) {
  await runStandalone(testit);
}
