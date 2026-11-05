import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_MAC } from "./host.ts";
import { ControlCommand } from "./control.ts";
import { assemblePdf, loadPng, makeZip, ROOT, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, waitToolWindow } from "./win-automation.ts";
import { captureWindowToPng, findChildWindow, postMessage, sendText, VK_RETURN, WM_KEYDOWN } from "./winapi.ts";

function makeXps(): Buffer {
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/><Default Extension="fdoc" ContentType="application/vnd.ms-package.xps-fixeddocument+xml"/><Default Extension="fpage" ContentType="application/vnd.ms-package.xps-fixedpage+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/FixedDocSeq.fdseq"/></Relationships>',
    "FixedDocSeq.fdseq":
      '<FixedDocumentSequence xmlns="http://schemas.microsoft.com/xps/2005/06"><DocumentReference Source="/Documents/1/FixedDoc.fdoc"/></FixedDocumentSequence>',
    "Documents/1/FixedDoc.fdoc":
      '<FixedDocument xmlns="http://schemas.microsoft.com/xps/2005/06"><PageContent Source="/Documents/1/Pages/1.fpage" Width="200" Height="400"/></FixedDocument>',
    "Documents/1/Pages/1.fpage":
      '<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="200" Height="400"><Path Fill="#FF0000" Data="M 20,20 L 80,20 80,80 20,80 Z"/></FixedPage>',
  };
  return makeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));
}

async function check(path: string, show: boolean): Promise<void> {
  const dir = tmpPath(
    `theme-background-command-${path.endsWith(".pdf") ? "pdf" : path.endsWith(".xps") ? "xps" : "djvu"}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, path]);
  try {
    await client.waitForRenderIdle();
    for (const surface of ["menu", "palette"]) {
      const result = await client.request(ControlCommand.TestCommandVisibility, ["CmdChangeBackgroundColor", surface]);
      const visibility = /vis=(\w+)/.exec(String(result[1] ?? ""))?.[1];
      if (visibility !== (show ? "show" : "hide")) throw new Error(`${path}/${surface}: ${JSON.stringify(result)}`);
    }
    if (show && !USE_NG) {
      await client.request(ControlCommand.TestInvokeCommand, ["CmdChangeBackgroundColor"]);
      const dialog = await waitToolWindow(client, proc.pid!, "color", { title: "Change Background Color" });
      if (!dialog) throw new Error(`${path}: background dialog did not open`);
      const edit = findChildWindow(dialog, "Edit");
      if (!edit) throw new Error(`${path}: color edit missing`);
      sendText(edit, "#3167a1");
      postMessage(dialog, WM_KEYDOWN, VK_RETURN, 0);
      const deadline = Date.now() + 5000;
      let actual = "";
      while (Date.now() < deadline) {
        const capture = join(dir, "canvas.png");
        if (!captureWindowToPng(findCanvas(frame), capture)) throw new Error("capture failed");
        const img = loadPng(capture);
        const at = (Math.floor(img.h / 2) * img.w + 4) * img.nComp;
        actual = Array.from(img.data.subarray(at, at + 3)).join(",");
        if (actual === "49,103,161") break;
        await Bun.sleep(50);
      }
      if (actual !== "49,103,161") throw new Error(`${path}: background was not applied (${actual})`);
    }
    await client.quit();
    await proc.exited;
  } finally {
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  if (IS_MAC) return;
  const dir = tmpPath("theme-background-fixtures");
  mkdirSync(dir, { recursive: true });
  const xps = join(dir, "page.xps");
  const pdf = join(dir, "page.pdf");
  writeFileSync(xps, makeXps());
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] >>",
    ]),
    "latin1",
  );
  const failures: string[] = [];
  for (const [path, show] of [
    [join(ROOT, "tests", "issue-6312.djvu"), true],
    [xps, true],
    [pdf, false],
  ] as const) {
    try {
      await check(path, show);
    } catch (e) {
      failures.push(String(e));
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
