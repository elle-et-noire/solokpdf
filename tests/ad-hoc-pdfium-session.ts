// Opt-in PDFium session check: build with solok-build.ts, then use --no-build.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { cmdId, runStandalone, tmpPath } from "./util.ts";
import { launchControlled, sendCommandSync } from "./win-automation.ts";
import { killAndWait, packCoords, sendMessage, setProcessDpiAware } from "./winapi.ts";

const WM_KEYDOWN = 0x0100;
const VK_HOME = 0x24;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;

async function clickButton(client: ControlClient, text: string): Promise<void> {
  const button = (await client.virtTree()).find((r) => r.kind === "virtCtrlButton" && r.text === text);
  if (!button) throw new Error(`No ${text} button`);
  const point = packCoords(
    button.rect.x + Math.floor(button.rect.dx / 2),
    button.rect.y + Math.floor(button.rect.dy / 2),
  );
  sendMessage(button.hwnd, WM_MOUSEMOVE, 0, point);
  sendMessage(button.hwnd, WM_LBUTTONDOWN, 1, point);
  sendMessage(button.hwnd, WM_LBUTTONUP, 0, point);
  await client.request(ControlCommand.Ping);
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath(`pdfium-session-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const settings = join(dir, "SolokPDF-settings.txt");
  writeFileSync(settings, "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nReuseInstance = false\n");
  const sentinel = join(dir, "SumatraPDF-settings.txt");
  writeFileSync(sentinel, "untouched\n");
  const pdfs = [join(dir, "first.pdf"), join(dir, "second.pdf")];
  for (const pdf of pdfs) copyFileSync("tests/issue-6101.pdf", pdf);

  const checkTabs = async (client: ControlClient, frame: number) => {
    const seen = new Set<string>();
    for (let i = 0; i < pdfs.length * 2; i++) {
      const current = await client.request(ControlCommand.TestCurrentTab);
      if (current[0] === 0) {
        await client.waitForRenderIdle();
        const path = /^path=(.*) page=\d+$/.exec(String(current[1]))?.[1];
        if (!path || !pdfs.includes(path)) throw new Error(`Unexpected tab: ${current}`);
        seen.add(path);
      }
      sendCommandSync(frame, cmdId("CmdNextTab"));
    }
    if (seen.size !== pdfs.length) throw new Error(`Restored ${seen.size} tabs`);
  };

  for (const stage of ["save", "group", "session"] as const) {
    const log = join(dir, `${stage}.log`);
    // Saving and restoring sessions requires normal launches with isolated appdata.
    const { proc, client, frame } = await launchControlled(
      ["-appdata", dir, "-log-to-file", log, ...(stage === "save" ? pdfs : [])],
      { saveSettings: true, env: { SOLOKPDF_ENGINE: "pdfium" } },
    );
    let exited = false;
    try {
      await client.setNotificationsEnabled(false);
      if (stage === "save") {
        await client.waitForRenderIdle();
        sendCommandSync(frame, cmdId("CmdTabGroupSave"));
        await clickButton(client, "Save");
      } else if (stage === "group") {
        sendCommandSync(frame, cmdId("CmdTabGroupRestore"));
        const list = (await client.virtTree()).find((r) => r.kind === "virtCtrlListBox");
        if (!list) throw new Error("No saved group");
        sendMessage(list.hwnd, WM_KEYDOWN, VK_HOME, 0);
        await clickButton(client, "Restore");
      }
      await checkTabs(client, frame);
      await client.quit();
      const exitCode = await Promise.race([proc.exited, Bun.sleep(10000).then(() => "timeout")]);
      if (exitCode !== 0) throw new Error(`Shutdown: ${exitCode}`);
      exited = true;
    } finally {
      client.close();
      if (!exited) await killAndWait(proc);
    }
    const saved = readFileSync(settings, "utf8");
    if (!saved.includes("TabGroups [") || pdfs.some((pdf) => !saved.includes(pdf)))
      throw new Error("Group not persisted");
    if (readFileSync(sentinel, "utf8") !== "untouched\n") throw new Error("SumatraPDF settings changed");
    const output = readFileSync(log, "utf8");
    if (!output.includes("PDFium 158.0.8111.0: opened") || output.includes("Using MuPDF fallback")) {
      throw new Error(`PDFium not used: ${log}`);
    }
    if (stage === "group") writeFileSync(settings, saved.replace(/^RestoreSession = false$/m, "RestoreSession = true"));
  }
  console.log(`PDFium disk group/session restore passed: ${dir}`);
}

if (import.meta.main) await runStandalone(testit);
