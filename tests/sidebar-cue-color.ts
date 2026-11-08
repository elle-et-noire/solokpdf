import { writeFileSync } from "node:fs";
import { assemblePdf, cmdId, runStandalone, tmpPath, USE_NG, writeAppdata } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { captureWindowPixels, findVisibleChildWindow, getParentWindow, sendText, sleep } from "./winapi.ts";

function hasColor(hwnd: number, r: number, g: number, b: number): boolean {
  const img = captureWindowPixels(hwnd);
  if (!img) throw new Error("could not capture search field");
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === b && img.data[i + 1] === g && img.data[i + 2] === r) n++;
  }
  return n >= 4;
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const pdf = tmpPath("sidebar-cue-color.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
      "<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 1 >>",
      "<< /Title (Chapter) /Parent 4 0 R /Dest [3 0 R /Fit] >>",
    ]),
    "latin1",
  );
  const dir = writeAppdata(
    "sidebar-cue-color",
    "ShowToc = true\nRestoreSession = false\nTheme = Cue Test\nThemes [\n [\n Name = Cue Test\n TextColor = #ffffff\n DisabledTextColor = #00ff00\n BackgroundColor = #202020\n ControlBackgroundColor = #202020\n ]\n]\n",
  );
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    const tree = findVisibleChildWindow(frame, "SysTreeView32");
    const edit = tree && findVisibleChildWindow(getParentWindow(tree), "Edit");
    if (!edit) throw new Error("bookmark search field not found");
    await sleep(200);
    if (!hasColor(edit, 0, 255, 0)) throw new Error("bookmark placeholder does not use the muted theme color");
    sendText(edit, "Chapter");
    await sleep(100);
    if (!hasColor(edit, 255, 255, 255)) throw new Error("entered text does not use the normal theme color");
    sendText(edit, "");
    sendCommandSync(frame, cmdId("CmdNextTheme"));
    sendCommandSync(frame, cmdId("CmdPrevTheme"));
    await sleep(100);
    if (!hasColor(edit, 0, 255, 0)) throw new Error("placeholder color not restored after theme change");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}
if (import.meta.main) await runStandalone(testit);
