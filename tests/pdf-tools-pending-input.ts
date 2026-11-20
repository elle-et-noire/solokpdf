import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { annotFixture, fixture, startAnnotInput, startInput } from "./pending-document-input.ts";
import {
  APP_NAME,
  cmdId,
  EXE,
  extractPageText,
  pollUntil,
  runStandalone,
  SETTINGS_FILE,
  tmpPath,
  USE_NG,
} from "./util.ts";
import {
  activateTestFrame,
  choosePopupCommand,
  findCanvas,
  FRAME_CLASS,
  killAndWait,
  launchControlled,
  openPopupSubmenu,
  pressEnter,
  pressVKey,
  sendCommand,
  sendCommandSync,
  waitForContextMenu,
  waitToolWindow,
} from "./win-automation.ts";
import {
  enumChildWindows,
  enumWindows,
  getClassName,
  getControlText,
  getFocusedHwnd,
  getMenuItemCount,
  getMenuItemText,
  getPopupMenuHandle,
  getWindowPid,
  isWindowVisible,
  sendText,
} from "./winapi.ts";

const kOriginal = "ORIGINAL";
const kEdited = "EDITED";
const kF8 = 0x77;
const kToolsMenu = 50004;
type Input = "text" | "choice" | "FreeText" | "Square";

async function choosePdfTool(frame: number, command: string) {
  sendCommand(frame, kToolsMenu);
  const popup = await waitForContextMenu(1500, frame);
  assert.ok(popup, "Tools menu did not open");
  const menu = getPopupMenuHandle(popup);
  const pos = Array.from({ length: getMenuItemCount(menu) }, (_, i) => i).find(
    (i) => getMenuItemText(menu, i) === "PDF Operations",
  );
  assert.ok(pos !== undefined, "Missing PDF Operations submenu");
  const tools = await openPopupSubmenu(popup, pos);
  assert.ok(tools && choosePopupCommand(tools, cmdId(command)), `${command} is missing from PDF Operations`);
}

async function checkTool(engine: string, input: Input, tool: "bake" | "extract", entry: "menu" | "shortcut") {
  const title = tool === "bake" ? "Bake PDF" : "Extract Pages";
  const command = tool === "bake" ? "CmdPdfBake" : "CmdPdfExtractPages";
  const dir = mkdtempSync(tmpPath("pdf-tools-pending-input-"));
  const source = join(dir, "source.pdf");
  const output = join(dir, "output.pdf");
  const form = input === "text" || input === "choice";
  const pdf = form ? fixture(kOriginal, input === "choice" ? "combo" : input, 2) : annotFixture(kOriginal, input, 2);
  writeFileSync(source, pdf, "latin1");
  writeFileSync(
    join(dir, SETTINGS_FILE),
    `UiLanguage = en\nShowMenubar = true\nShowMenubarWithTabs = true\nShortcuts [\n [\n  Cmd = ${command}\n  Key = F8\n ]\n]\n`,
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, source], {
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    await client.waitForRenderIdle();
    await activateTestFrame(client);
    const [status, info] = await client.request(ControlCommand.TestCurrentPdf);
    const kind = engine === "pdfium" ? "enginePdfium" : "enginePdf";
    assert.equal(status, 0, String(info));
    assert.ok(String(info).startsWith(`engine=${kind} `), `Unexpected engine: ${info}`);
    const canvas = findCanvas(frame);
    if (!form) sendCommandSync(frame, cmdId("CmdToggleEditPDF"));
    const editor = form
      ? await startInput(client, canvas, input)
      : await startAnnotInput(client, canvas, proc.pid, input);
    assert.equal(getFocusedHwnd(frame), editor, "The source edit must have focus when the tool is invoked");
    if (entry === "shortcut") pressVKey(editor, kF8);
    else await choosePdfTool(frame, command);

    const dlg = await waitToolWindow(client, proc.pid, "pdftool", { title });
    assert.ok(dlg, `Missing ${title} dialog`);
    let dest = 0;
    enumChildWindows(dlg, (hwnd) => {
      if (getClassName(hwnd) === "Edit" && getControlText(hwnd).endsWith(".pdf")) dest = hwnd;
      return !dest;
    });
    assert.ok(dest, "Missing destination edit");
    sendText(dest, output);
    await pressEnter(dest);
    await pollUntil(() => existsSync(output) && !isWindowVisible(dlg), Boolean, {
      error: `Missing output from ${title}`,
    });
    assert.deepEqual(readFileSync(source), Buffer.from(pdf, "latin1"), "The tool modified the source file");

    if (tool === "bake") {
      assert.match(extractPageText(output, 1), new RegExp(kEdited), "Baked page lost the pending edit");
    } else if (form) {
      const decoded = join(dir, "decoded.pdf");
      const clean = Bun.spawnSync([EXE, "clean", "-d", output, decoded]);
      assert.equal(clean.exitCode, 0, clean.stderr.toString());
      const value = /\/V\s*\(([^)]*)\)/.exec(readFileSync(decoded, "latin1"))?.[1];
      assert.equal(value, kEdited, "Extracted field lost the pending edit");
    } else {
      await pollUntil(
        async () => String((await client.request(ControlCommand.TestCurrentTab))[1]),
        (tab) => tab.includes("output.pdf page=1"),
      );
      await client.waitForRenderIdle();
      const result = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", kEdited]);
      assert.equal(result[0], 0, String(result[1]));
      assert.ok(
        String(result[1]).includes(`before='${kEdited}'`),
        `Extracted page lost the pending edit: ${result[1]}`,
      );
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

async function checkClosedSource(engine: string) {
  const dir = mkdtempSync(tmpPath("pdf-tools-close-on-commit-"));
  const source = join(dir, "source.pdf");
  const other = join(dir, "other.pdf");
  writeFileSync(source, fixture(kOriginal, "combo"));
  writeFileSync(other, fixture(kOriginal));
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\n");
  const { proc, client, frame } = await launchControlled(["-appdata", dir, other, source], {
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    await client.waitForRenderIdle();
    await activateTestFrame(client);
    assert.match(String((await client.request(ControlCommand.TestCurrentTab))[1]), /source\.pdf page=1$/);
    await startInput(client, findCanvas(frame), "choice");
    const [status, message] = await client.request(ControlCommand.TestFocusState, ["close-tab-on-edit-destroy"]);
    assert.equal(status, 0, String(message));
    sendCommandSync(frame, cmdId("CmdPdfBake"));
    assert.equal((await client.selectTab()).count, 1, "The source tab stayed open during input commit");
    assert.match(String((await client.request(ControlCommand.TestCurrentTab))[1]), /other\.pdf page=1$/);
    const dlg = await waitToolWindow(client, proc.pid, "pdftool", { title: "Bake PDF", timeoutMs: 300 });
    assert.equal(dlg, 0, "Bake PDF opened after its source closed during input commit");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

async function checkOtherWindow(engine: string) {
  const dir = mkdtempSync(tmpPath("pdf-tools-other-window-"));
  const source = join(dir, "source.pdf");
  writeFileSync(source, fixture(kOriginal, "combo"));
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\n");
  const { proc, client, frame } = await launchControlled(["-appdata", dir, source], {
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    sendCommand(frame, cmdId("CmdDuplicateInNewWindow"));
    const other = await pollUntil(() => {
      let otherFrame = 0;
      enumWindows((hwnd) => {
        if (hwnd !== frame && getWindowPid(hwnd) === proc.pid && getClassName(hwnd) === FRAME_CLASS) otherFrame = hwnd;
        return !otherFrame;
      });
      return otherFrame;
    }, Boolean);
    await client.waitForRenderIdle();
    await activateTestFrame(client);
    const editor = await startInput(client, findCanvas(frame), "choice");
    assert.equal(getFocusedHwnd(frame), editor);
    sendCommand(other, cmdId("CmdPdfBake"));
    assert.ok(await waitToolWindow(client, proc.pid, "pdftool", { title: "Bake PDF" }));
    const [status, state] = await client.request(ControlCommand.TestMarkupAnnots);
    assert.equal(status, 0, String(state));
    assert.match(String(state), /modified=0/, "Bake committed an edit from another window");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") return;
  const failures: string[] = [];
  for (const engine of ["mupdf", "pdfium"]) {
    for (const [input, tool, entry] of [
      ["text", "bake", "menu"],
      ["choice", "bake", "shortcut"],
      ["FreeText", "bake", "shortcut"],
      ["choice", "extract", "menu"],
      ["choice", "extract", "shortcut"],
      ["Square", "extract", "shortcut"],
    ] as const) {
      const label = `${engine}-${input}-${tool}-${entry}`;
      try {
        await checkTool(engine, input, tool, entry);
        console.log(`${label}: pending input exported`);
      } catch (error) {
        failures.push(`${label}: ${error}`);
      }
    }
    try {
      await checkClosedSource(engine);
      console.log(`${engine}: no tool after source closed during input commit`);
    } catch (error) {
      failures.push(`${engine}-closed-source: ${error}`);
    }
    try {
      await checkOtherWindow(engine);
      console.log(`${engine}: another window's input was not committed`);
    } catch (error) {
      failures.push(`${engine}-other-window: ${error}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
