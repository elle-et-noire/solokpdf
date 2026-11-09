import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control";
import { APP_NAME, assemblePdf, loadPng, pngPixel, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util";
import { findCanvas, killAndWait, launchControlled } from "./win-automation";
import { captureWindowToPng, repaintWindow, sleep } from "./winapi";

const line = "Selected X";
function stream(s: string): string {
  return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
}
function pdf(kind: string): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /ExtGState << /GS 6 0 R >> >> /Contents 4 0 R >>",
    stream(
      `${kind === "clip" ? "0 0 612 792 re W n " : ""}${kind === "alpha" ? "/GS gs " : ""}BT /F1 18 Tf 72 700 Td (${kind === "type3" ? "AAAAA" : line}) Tj ET${kind === "occlusion" ? " 0 g 75 702 4 4 re f" : ""}`,
    ),
    kind === "type3"
      ? "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 500 700] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /A 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /Resources << >> >>"
      : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /ExtGState /ca 0.5 >>",
    stream("600 0 0 0 500 700 d1 0 0 500 700 re f"),
  ];
  return assemblePdf(objects);
}

export async function runCases(names: string[]): Promise<void> {
  if (USE_NG || APP_NAME !== "SolokPDF") {
    console.log("SKIP selection-mupdf: SolokPDF original app only");
    return;
  }
  const cases = [
    { name: "smart-light", kind: "plain", mode: "smart", bg: "#ffffff", text: "#000000" },
    { name: "smart-dark", kind: "plain", mode: "smart", bg: "#202020", text: "#ffffff" },
    { name: "off", kind: "plain", mode: "off", bg: "#202020", text: "#ffffff" },
    { name: "cross-dark-off", kind: "plain", mode: "off", bg: "#202020", text: "#ffffff" },
    { name: "clip", kind: "clip", mode: "off", bg: "#ffffff", text: "#000000" },
    { name: "alpha", kind: "alpha", mode: "off", bg: "#ffffff", text: "#000000" },
    { name: "type3", kind: "type3", mode: "off", bg: "#ffffff", text: "#000000" },
    { name: "occlusion", kind: "occlusion", mode: "off", bg: "#ffffff", text: "#000000" },
  ];
  for (const c of cases) {
    if (!names.includes(c.name)) continue;
    const dir = tmpPath(`selection-mupdf-${c.name}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "page.pdf");
    writeFileSync(path, pdf(c.kind), "latin1");
    writeFileSync(
      join(dir, SETTINGS_FILE),
      `Theme = Selection Test\nRestoreSession = false\nCheckForUpdates = false\nSelectionToolbar = false\nDocumentColorsFollowTheme = ${c.mode}\nThemes [\n [\n Name = Selection Test\n TextColor = ${c.text}\n BackgroundColor = ${c.bg}\n ControlBackgroundColor = ${c.bg}\n LinkColor = ${c.text}\n ${c.name === "cross-dark-off" ? "" : "SelectionBackgroundColor = #0066cc\n "}SelectionTextColor = #ff0000\n TextSelectionColor = #800066cc\n ]\n]\n`,
    );
    const { proc, client, frame } = await launchControlled(["-appdata", dir, path], {
      env: { SOLOKPDF_ENGINE: "mupdf" },
    });
    try {
      await client.waitForRenderIdle();
      await client.setNotificationsEnabled(false);
      const canvas = findCanvas(frame);
      const shot = join(dir, "selected.png");
      if (!captureWindowToPng(canvas, shot)) throw new Error(`${c.name}: initial capture failed`);
      const before = loadPng(shot);
      const seeded = await client.seedTextSelection(1, 0, c.kind === "type3" ? 4 : 8);
      console.log(`${c.name}: parts=${seeded.parts} quads=${seeded.quads}`);
      const selection = String((await client.request(ControlCommand.TestSelectionVars, ["${selection}"]))[1] ?? "");
      const expected = c.kind === "type3" ? "AAAA" : "Selected";
      if (!selection.split("\n").includes(`expanded=${expected}`)) {
        throw new Error(`${c.name}: unexpected selection ${selection}`);
      }
      repaintWindow(canvas);
      let red = 0;
      let changed = 0;
      let blended = 0;
      const overlay = [0, 102, 204];
      const alpha = 128;
      for (let attempt = 0; attempt < 50; attempt++) {
        await sleep(100);
        if (!captureWindowToPng(canvas, shot)) throw new Error(`${c.name}: capture failed`);
        const image = loadPng(shot);
        red = 0;
        changed = 0;
        blended = 0;
        for (let y = 0; y < image.h; y++)
          for (let x = 0; x < image.w; x++) {
            const [r, g, b] = pngPixel(image, x, y);
            const [br, bg, bb] = pngPixel(before, x, y);
            if (r! > 180 && g! < 80 && b! < 80) red++;
            if (r === br && g === bg && b === bb) continue;
            changed++;
            if (
              overlay.every(
                (c, i) => Math.abs([r, g, b][i]! - ([br, bg, bb][i]! * (255 - alpha) + c * alpha) / 255) <= 2,
              )
            )
              blended++;
          }
        if (blended > 30) break;
      }
      if (red > 0) throw new Error(`${c.name}: ${red} UI selection-text pixels in the document`);
      if (blended < 30) throw new Error(`${c.name}: overlay missing: blended=${blended} changed=${changed}`);
      console.log(`${c.name}: ${blended} blended pixels`);
    } finally {
      client.close();
      await killAndWait(proc);
    }
  }
}
export async function testit(): Promise<void> {
  await runCases(["clip", "alpha", "type3", "occlusion"]);
}
if (import.meta.main) await runStandalone(testit);
