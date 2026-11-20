// The canvas context menu's Document submenu offered the PDF-only commands
// (Show PDF Info, Encrypt PDF, Compress PDF, Extract/Delete Pages From PDF, ...)
// for every document the mupdf engine renders, so an epub got the whole list.
// The gate used CouldBePDFDoc(), which is true for epub/mobi/fb2/xps/svg too;
// it now asks the engine whether there is really a pdf_document behind the tab.
// Extract Pages stays: MuPDF draws an epub's pages into a new PDF (#6509).

import { ControlCommand, withControlledSumatra } from "./control.ts";
import { APP_NAME, cmdId, EXE, runStandalone, USE_NG } from "./util.ts";
import { sendCommand, sendCommandSync, waitForContextMenu, waitForFrame } from "./win-automation.ts";
import {
  getMenuItemCount,
  getMenuItemId,
  getPopupMenuHandle,
  getSubMenu,
  postMessage,
  sleep,
  VK_ESCAPE,
  WM_KEYDOWN,
} from "./winapi.ts";

const kPdfCmds = ["CmdPdfShowInfo", "CmdPdfCompress", "CmdPdfExtractPages", "CmdPdfEncrypt"];
const kEpubCmds = ["CmdPdfExtractPages"];
const kToolsMenu = 50004;

async function checkToolsMenu(frame: number, type: string, expected: string[]): Promise<void> {
  sendCommand(frame, kToolsMenu);
  const popup = await waitForContextMenu(1500, frame);
  if (!popup) throw new Error("pdf-only-menu-items: Tools menu did not open");
  const tools = getPopupMenuHandle(popup);
  const pdfIds = kPdfCmds.map(cmdId);
  const docs = Array.from({ length: getMenuItemCount(tools) }, (_, i) => getSubMenu(tools, i)).find((menu) =>
    Array.from({ length: getMenuItemCount(menu) }, (_, i) => getMenuItemId(menu, i)).some((id) => pdfIds.includes(id)),
  );
  const ids = Array.from({ length: getMenuItemCount(docs ?? 0n) }, (_, i) => getMenuItemId(docs ?? 0n, i));
  postMessage(popup, WM_KEYDOWN, VK_ESCAPE, 0);
  for (const cmd of kPdfCmds) {
    if (ids.includes(cmdId(cmd)) !== expected.includes(cmd)) {
      throw new Error(
        `pdf-only-menu-items: ${type} ${cmd} present=${ids.includes(cmdId(cmd))}, expected=${expected.join(", ")}; got ${ids}`,
      );
    }
  }
  await sleep(525);
}

async function vis(client: { request: Function }, cmd: string): Promise<string> {
  const res = await client.request(ControlCommand.TestCommandVisibility, [cmd, "menu"]);
  const raw = String(res[1] ?? "");
  if (res[0] !== 0) {
    throw new Error(`pdf-only-menu-items: ${cmd}: ${raw.trim()}`);
  }
  const m = /vis=(\w+)/.exec(raw);
  return m?.[1] ?? "";
}

export async function testit(): Promise<void> {
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      const checkNativeTools = !USE_NG && APP_NAME === "SolokPDF";
      if (checkNativeTools) sendCommandSync(frame, cmdId("CmdToggleMenuBar"));
      for (const type of ["pdf", "epub"]) {
        await client.waitForRenderIdle();
        const shown = [];
        for (const cmd of kPdfCmds) {
          const v = await vis(client, cmd);
          if (v === "show") {
            shown.push(cmd);
          }
          const want = kEpubCmds.includes(cmd) ? "show" : "hide";
          if (type === "epub" && v !== want) {
            throw new Error(`pdf-only-menu-items: epub ${cmd} vis=${v}, want ${want}`);
          }
        }
        if (type === "pdf" && shown.length === 0) {
          throw new Error("pdf-only-menu-items: pdf hid every PDF command");
        }
        if (checkNativeTools) await checkToolsMenu(frame, type, shown);
        if (type === "pdf") {
          sendCommandSync(frame, cmdId("CmdPrevTab"));
        }
      }
    },
    ["tests/issue-5846.epub", "tests/issue-1189.pdf"],
  );
}

if (import.meta.main) {
  await runStandalone(testit);
}
