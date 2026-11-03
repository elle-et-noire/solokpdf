// Dragging a tab out of its window reloads the document by path in the new
// window. A tab opened from an embedded attachment has no path: the drag closed
// it and fired the empty-path debug report in CreateEngineFromFile()
// (crash 2026-10-13-12-51-c0c4). Such a tab now stays where it is.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlClient, ControlCommand } from "./control.ts";
import {
  assemblePdf,
  pollUntil,
  runStandalone,
  SETTINGS_FILE,
  SLOW_BUILD_FACTOR,
  TESTS_TMP_DIR,
  tmpPath,
  USE_NG,
} from "./util.ts";
import {
  enumWindows,
  getWindowPid,
  getWindowText,
  isWindowVisible,
  MK_LBUTTON,
  packCoords,
  sendMessage,
  sleep,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from "./winapi.ts";
import { clickAt, findChildByClass, killAndWait, launchControlled } from "./win-automation.ts";

const TABS_CLASS = "SumatraTabsCtrlClass";
const ATTACHMENT = "image002.png";
// how far below the tab bar the tab is dropped
const DROP_DY = 300;

// 1x1 red PNG
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function makePdfWithImageAttachment(): string {
  const png = Buffer.from(PNG_BASE64, "base64").toString("latin1");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /FileAttachment /P 3 0 R /Rect [200 400 400 600] /FS 5 0 R /Name /PushPin >>",
    `<< /Type /Filespec /F (${ATTACHMENT}) /UF (${ATTACHMENT}) /EF << /F 6 0 R >> >>`,
    `<< /Type /EmbeddedFile /Length ${png.length} /Params << /Size ${png.length} >> >>\nstream\n${png}\nendstream`,
  ]);
}

async function findTabBar(client: ControlClient, frame: number): Promise<{ tabs: number; x: number; y: number }> {
  const tabs = findChildByClass(frame, TABS_CLASS);
  if (!tabs) {
    throw new Error("drag-out-attachment-tab: no tab bar");
  }
  const rows = (await client.virtTree(TABS_CLASS)).filter((r) => r.kind === "tabCtrl");
  if (rows.length < 3)
    throw new Error(`drag-out-attachment-tab: expected Home, outer and attachment tabs, got ${rows.length}`);
  const attachment = rows[rows.length - 1]!.rect;
  const x = attachment.x + Math.min(30, Math.floor(attachment.dx / 3));
  const y = attachment.y + Math.floor(attachment.dy / 2);
  await clickAt(tabs, x, y, 50);
  return { tabs, x, y };
}

// press on the tab, pull it down past the drag threshold, drop below the bar
function dragOutOrig({ tabs, x, y }: { tabs: number; x: number; y: number }): void {
  const dropY = y + DROP_DY;
  // TabsCtrl takes the drag and release points from these window messages.
  sendMessage(tabs, WM_MOUSEMOVE, 0, packCoords(x, y));
  sendMessage(tabs, WM_LBUTTONDOWN, MK_LBUTTON, packCoords(x, y));
  sendMessage(tabs, WM_MOUSEMOVE, MK_LBUTTON, packCoords(x, y + 40));
  sendMessage(tabs, WM_MOUSEMOVE, MK_LBUTTON, packCoords(x, dropY));
  sendMessage(tabs, WM_LBUTTONUP, 0, packCoords(x, dropY));
}

function processWindowTitles(pid: number): string[] {
  const titles: string[] = [];
  enumWindows((h) => {
    if (getWindowPid(h) === pid && isWindowVisible(h)) {
      titles.push(getWindowText(h));
    }
    return true;
  });
  return titles;
}

// ng draws its tabs: the attachment's is the frame layout node labelled with it
async function dragOutNg(client: ControlClient): Promise<void> {
  const layout = String((await client.request(ControlCommand.TestToolWindow, ["layout", "frame"]))[1] ?? "");
  const re = new RegExp(`node rect=(-?\\d+),(-?\\d+),(\\d+),(\\d+) role=\\d+ label='[^']*${ATTACHMENT}`);
  const m = re.exec(layout);
  if (!m) {
    throw new Error(`drag-out-attachment-tab: no tab labelled ${ATTACHMENT}:\n${layout.slice(0, 2000)}`);
  }
  const x = Number(m[1]) + Math.floor(Number(m[3]) / 3);
  const y = Number(m[2]) + Math.floor(Number(m[4]) / 2);
  const input = async (...args: (string | number)[]) => client.request(ControlCommand.TestInput, args);
  await input("down", x, y, 0, 0);
  await input("move", x, y + 40, 1, 0);
  await input("move", x, y + DROP_DY, 1, 0);
  await input("up", x, y + DROP_DY, 0, 0);
}

export async function testit(): Promise<void> {
  const dir = tmpPath("drag-out-attachment-tab");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "outer.pdf");
  writeFileSync(pdf, makePdfWithImageAttachment(), "latin1");
  writeFileSync(join(dir, SETTINGS_FILE), "NoHomeTab = false\n");

  if (USE_NG) {
    // ng saves the attachment under a unique name; make it differ from the tab's
    const attachments = join(TESTS_TMP_DIR, "data", "attachments");
    mkdirSync(attachments, { recursive: true });
    writeFileSync(join(attachments, ATTACHMENT), "");
  }
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
    await client.setNotificationsEnabled(false);

    await pollUntil(
      async () => {
        const res = await client.request(ControlCommand.TestMarkupAnnots, ["open-embedded", 0, 0]);
        return { code: res[0], text: String(res[1] ?? "") };
      },
      (r) => r.code === 0 && /OK/.test(r.text),
      {
        timeoutMs: 8000 * SLOW_BUILD_FACTOR,
        error: (r) => `drag-out-attachment-tab: open-embedded failed: code=${r.code} ${r.text}`,
      },
    );
    await pollUntil(
      () => getWindowText(frame),
      (t) => t.includes(ATTACHMENT),
      {
        timeoutMs: 8000 * SLOW_BUILD_FACTOR,
        error: (t) => `drag-out-attachment-tab: expected tab ${ATTACHMENT}, title='${t}'`,
      },
    );
    await client.waitForRenderIdle();

    if (USE_NG) {
      await dragOutNg(client);
    } else {
      dragOutOrig(await findTabBar(client, frame));
    }
    await sleep(300 * SLOW_BUILD_FACTOR);

    // a debug report under -for-testing ends the process
    if (proc.exitCode !== null) {
      throw new Error(`drag-out-attachment-tab: the app exited with ${proc.exitCode} after the drag`);
    }
    await client.waitForRenderIdle();
    // ng saves an attachment to a file before opening it, so its tab has a
    // path and moves to a window of its own
    const titles = USE_NG ? processWindowTitles(proc.pid!) : [getWindowText(frame)];
    if (!titles.some((t) => t.includes(ATTACHMENT))) {
      throw new Error(`drag-out-attachment-tab: the attachment tab is gone, titles=${JSON.stringify(titles)}`);
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
  console.log("drag-out-attachment-tab: OK");
}

if (import.meta.main) {
  await runStandalone(testit);
}
