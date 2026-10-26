// Opt-in check: themes change from the keyboard alone. The command palette finds a theme by name
// ("solarized dark", Enter), and the Change Theme dialog previews with Down and applies with Enter.
// Uses SolokPDF's settings file; build with solok-build.ts, then use --no-build.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, cmdId, loadPng, runStandalone, tmpPath } from "./util.ts";
import {
  findCanvas,
  killAndWait,
  launchControlled,
  paletteState,
  paletteSetText,
  sendCommand,
  waitForPalette,
} from "./win-automation.ts";
import { captureWindowToPng, enumWindows, getWindowText, postMessage, setProcessDpiAware, sleep } from "./winapi.ts";

const WM_KEYDOWN = 0x0100;
const VK_RETURN = 0x0d;
const VK_DOWN = 0x28;

// canvas backgrounds: Solarized Dark, then Dracula, the theme listed after it
const kSolarizedDarkBg = [0x00, 0x2b, 0x36];
const kDraculaBg = [0x28, 0x2a, 0x36];

function plainPdf(): string {
  const text = "BT /F1 24 Tf 72 700 Td (Hello) Tj ET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

// color of the canvas's bottom-left corner, outside the page
async function canvasCorner(frame: number, dir: string, name: string): Promise<number[]> {
  const png = join(dir, `${name}.png`);
  if (!captureWindowToPng(findCanvas(frame), png)) throw new Error(`${name}: capture failed`);
  const img = loadPng(png);
  const p = ((img.h - 3) * img.w + 3) * img.nComp;
  return [img.data[p]!, img.data[p + 1]!, img.data[p + 2]!];
}

// polls until the corner turns `want` (theme changes rebuild the window asynchronously)
async function expectCorner(frame: number, dir: string, name: string, want: number[]): Promise<string> {
  let got: number[] = [];
  for (let i = 0; i < 40; i++) {
    got = await canvasCorner(frame, dir, name);
    if (got.every((v, c) => Math.abs(v - want[c]!) <= 2)) return "";
    await sleep(100);
  }
  return `${name}: canvas corner ${got.join(",")}, want ${want.join(",")} (${join(dir, `${name}.png`)})`;
}

function findDialog(title: string): number {
  let found = 0;
  enumWindows((h: number) => {
    if (getWindowText(h) === title) found = h;
    return true;
  });
  return found;
}

export async function testit(): Promise<void> {
  setProcessDpiAware();
  const dir = tmpPath("theme-keyboard");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "plain.pdf");
  writeFileSync(pdf, plainPdf(), "latin1");
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nTheme = Light\nDefaultZoom = 50\n",
  );

  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  const failures: string[] = [];
  try {
    await client.setNotificationsEnabled(false);
    await client.waitForRenderIdle(30000);

    // palette: type the theme's name, Enter runs the first match
    sendCommand(frame, cmdId("CmdCommandPalette"));
    const handles = await waitForPalette(client, frame);
    if (!handles.edit) throw new Error("palette did not open");
    const query = "solarized dark";
    await paletteSetText(client, handles, query);
    let st = await paletteState(client);
    for (let i = 0; i < 50 && st.queryLen !== query.length; i++) {
      await sleep(40);
      st = await paletteState(client);
    }
    console.log(`palette: items=${st.items} selText=${st.selText}`);
    if (!st.selText.includes("Solarized Dark")) {
      failures.push(`palette: "${query}" selects "${st.selText}", not the Solarized Dark theme`);
    } else {
      postMessage(handles.edit, WM_KEYDOWN, VK_RETURN, 0);
      const f = await expectCorner(frame, dir, "palette", kSolarizedDarkBg);
      if (f) failures.push(f);
    }

    // dialog: the theme list has the focus; Down previews the next theme, Enter keeps it
    sendCommand(frame, cmdId("CmdChangeTheme"));
    let dlg = 0;
    for (let i = 0; i < 50 && !dlg; i++) {
      await sleep(100);
      dlg = findDialog("Change Theme");
    }
    if (!dlg) throw new Error("Change Theme dialog did not open");
    postMessage(dlg, WM_KEYDOWN, VK_DOWN, 0);
    let f = await expectCorner(frame, dir, "dialog-preview", kDraculaBg);
    if (f) failures.push(f);
    postMessage(dlg, WM_KEYDOWN, VK_RETURN, 0);
    for (let i = 0; i < 30 && findDialog("Change Theme"); i++) await sleep(100);
    if (findDialog("Change Theme")) failures.push("dialog: Enter did not close it");
    f = await expectCorner(frame, dir, "dialog-applied", kDraculaBg);
    if (f) failures.push(f);

    await client.quit();
    await proc.exited;
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
