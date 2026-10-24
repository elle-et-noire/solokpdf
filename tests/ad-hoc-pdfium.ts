// Opt-in backend check. Build with cmd/solok-build.ts, then run with --no-build.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { EXE, assemblePdf, cmdId, runStandalone, tmpPath } from "./util.ts";
import { waitForFrame, sendCommand } from "./win-automation.ts";
import { captureWindowToPng, sendMessage, packCoords, setProcessDpiAware } from "./winapi.ts";

function fixture(): string {
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /Names << /Dests << /Names [(target) [4 0 R /XYZ 80 240 1.25]] >> >> >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /CropBox [20 30 280 370] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [10 0 R 11 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /CropBox [50 20 350 280] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 18 Tf 40 300 Td (Needle SolokPDF first page) Tj ET 0.5 w 40 280 m 240 280 l S"),
    stream("BT /F1 18 Tf 80 220 Td (Needle second page) Tj ET"),
    "<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>",
    "<< /Title (Second page) /Parent 8 0 R /Dest [4 0 R /XYZ 80 240 1.25] >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 250 160 270] /Border [0 0 1] /Dest (target) >>",
    "<< /Type /Annot /Subtype /Link /Rect [40 200 160 220] /Border [0 0 1] /A << /S /URI /URI (https://arxiv.org/abs/1706.03762) >> >>",
  ]);
}

async function request(client: ControlClient, cmd: ControlCommand, args: (string | number)[] = []): Promise<string> {
  const r = await client.request(cmd, args);
  const text = String(r[1] ?? "");
  if (r[0] !== 0) throw new Error(`command ${cmd}: ${text}`);
  console.log(text.trim());
  return text;
}

async function expectPage(client: ControlClient, page: number): Promise<void> {
  for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
    const r = await client.request(ControlCommand.TestCurrentTab);
    if (r[0] === 0 && String(r[1]).endsWith(`page=${page}`)) return;
    await Bun.sleep(20);
  }
  throw new Error(`Navigation did not reach page ${page}`);
}

async function clickVirtText(client: ControlClient, text: string): Promise<void> {
  for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
    const row = (await client.virtTree()).find((r) => r.text === text && r.kind === "virtCtrlButton");
    if (row) {
      const point = packCoords(row.rect.x + Math.floor(row.rect.dx / 2), row.rect.y + Math.floor(row.rect.dy / 2));
      const wmMouseMove = 0x0200,
        wmLeftDown = 0x0201,
        wmLeftUp = 0x0202;
      sendMessage(row.hwnd, wmMouseMove, 0, point);
      sendMessage(row.hwnd, wmLeftDown, 1, point);
      sendMessage(row.hwnd, wmLeftUp, 0, point);
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`No virtual button '${text}'`);
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const pdf = tmpPath("pdfium/fixture.pdf");
  mkdirSync(dirname(pdf), { recursive: true });
  mkdirSync(tmpPath("pdfium/settings"), { recursive: true });
  writeFileSync(tmpPath("pdfium/settings/SolokPDF-settings.txt"), "UiLanguage = en\nCheckForUpdates = false\n");
  const sentinel = tmpPath("pdfium/settings/SumatraPDF-settings.txt");
  writeFileSync(sentinel, "SumatraPDF settings sentinel\n");
  writeFileSync(pdf, fixture(), "latin1");
  const second = tmpPath("pdfium/second.pdf");
  copyFileSync(pdf, second);
  const log = tmpPath("pdfium/gui.log");
  const image = tmpPath("pdfium/gui.png");
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.setNotificationsEnabled(false);
      await client.waitForRenderIdle();
      const frame = await waitForFrame(proc.pid!);
      if (!frame || !captureWindowToPng(frame, image)) throw new Error("Cannot capture the Win32 window");
      const info = await request(client, ControlCommand.TestPageInfo);
      if (!info.includes("pages=2 widths=260,260")) throw new Error(`Crop/rotation geometry: ${info}`);
      const text = await request(client, ControlCommand.TestSearch, [pdf, "Needle"]);
      if (!text.includes("FOUND needle=Needle page=1")) throw new Error(`Search: ${text}`);
      const links = await request(client, ControlCommand.TestPageLinks, [pdf, 1]);
      const internal = /kind=scrollTo page=2 src=([^ ]+) dest=([^ ]+)/.exec(links);
      const coords = internal
        ? [...internal[1]!.split(",").map(Number), ...internal[2]!.split(",").slice(0, 2).map(Number)]
        : [];
      const expected = [20, 100, 120, 20, 220, 30];
      if (
        coords.length !== 6 ||
        coords.some((v, i) => Math.abs(v - expected[i]!) > 0.01) ||
        !links.includes("value=https://arxiv.org/abs/1706.03762")
      ) {
        throw new Error(`Link coordinates or URI: ${links}`);
      }
      const toc = await request(client, ControlCommand.TestGetToc, [pdf]);
      if (!toc.includes("Second page|page=2")) throw new Error(`TOC: ${toc}`);
      const render = await request(client, ControlCommand.TestRenderViewPrint, [pdf]);
      if (!render.includes("viewSize=260x340") || !/viewNonwhite=[1-9]\d{2,}/.test(render))
        throw new Error(`Render: ${render}`);
      await request(client, ControlCommand.TestSeedTextSelection, [1]);
      await request(client, ControlCommand.TestTocSidebarNav, [1]);
      await expectPage(client, 2);
      sendCommand(frame, cmdId("CmdNavigateBack"));
      await expectPage(client, 1);
      await request(client, ControlCommand.TestTocNavigate, [1]);
      await expectPage(client, 2);
      sendCommand(frame, cmdId("CmdNavigateBack"));
      await expectPage(client, 1);
      sendCommand(frame, cmdId("CmdNavigateForward"));
      await expectPage(client, 2);
      sendCommand(frame, cmdId("CmdRotateRight"));
      sendCommand(frame, cmdId("CmdZoomIn"));
      await client.waitForRenderIdle();
      await request(client, ControlCommand.TestPageInfo);
      const invalid = tmpPath("pdfium/invalid.pdf");
      writeFileSync(invalid, "this is not a PDF");
      const failure = await request(client, ControlCommand.TestSearch, [invalid, "Needle"]);
      if (!failure.includes("ERROR engine-create-failed")) throw new Error(`Malformed PDF was accepted: ${failure}`);
      sendCommand(frame, cmdId("CmdTabGroupSave"));
      await clickVirtText(client, "Save");
      sendCommand(frame, cmdId("CmdCloseAllTabs"));
      await client.request(ControlCommand.Ping);
      sendCommand(frame, cmdId("CmdTabGroupRestore"));
      const list = (await client.virtTree()).find((r) => r.kind === "virtCtrlListBox");
      if (!list) throw new Error("Tab Groups list was not shown");
      captureWindowToPng(list.hwnd, tmpPath("pdfium/group-restore.png"));
      const wmKeyDown = 0x0100,
        vkHome = 0x24;
      sendMessage(list.hwnd, wmKeyDown, vkHome, 0);
      await clickVirtText(client, "Restore");
      await client.waitForRenderIdle();
      const restored = new Set<string>();
      for (let i = 0; i < 4; i++) {
        const current = await client.request(ControlCommand.TestCurrentTab);
        if (current[0] === 0) restored.add(String(current[1]).replace(/ page=\d+$/, ""));
        sendCommand(frame, cmdId("CmdNextTab"));
      }
      if (restored.size !== 2) throw new Error(`Tab Groups restored ${restored.size} documents, expected 2`);
      console.log("Tab Groups saved and restored two PDFium documents");
      for (let i = 0; i < 12; i++) sendCommand(frame, cmdId("CmdZoomIn"));
      sendCommand(frame, cmdId("CmdCloseAllTabs"));
      await client.request(ControlCommand.Ping);
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", log, pdf, second],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  const output = readFileSync(log, "utf8");
  if (!output.includes("PDFium 158.0.8111.0: opened") || output.includes("Using MuPDF fallback")) {
    throw new Error(`PDFium backend was not used. See ${log}`);
  }
  if (readFileSync(sentinel, "utf8") !== "SumatraPDF settings sentinel\n") {
    throw new Error("SumatraPDF settings were modified");
  }
  const missingDir = tmpPath("pdfium/missing-dll");
  mkdirSync(missingDir, { recursive: true });
  const missingExe = join(missingDir, basename(EXE));
  copyFileSync(EXE, missingExe);
  copyFileSync(join(dirname(EXE), "libsumatrapdf.dll"), join(missingDir, "libsumatrapdf.dll"));
  const missingLog = tmpPath("pdfium/missing-dll.log");
  await withControlledSumatra(
    missingExe,
    async (client) => {
      await client.waitForRenderIdle();
      const text = await request(client, ControlCommand.TestSearch, [pdf, "Needle"]);
      if (!text.includes("FOUND")) throw new Error("Missing-DLL MuPDF fallback failed");
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", missingLog, pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  const missingOutput = readFileSync(missingLog, "utf8");
  if (!missingOutput.includes("Cannot load PDFium DLL") || !missingOutput.includes("Windows error")) {
    throw new Error("Missing DLL cause was not reported");
  }
  console.log(`PDFium Win32 checks passed. Screenshot: ${image}`);
}

if (import.meta.main) await runStandalone(testit);
