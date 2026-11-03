import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient, withControlledSumatra } from "./control.ts";
import { assemblePdf, cmdId, EXE, runStandalone, tmpPath, SETTINGS_FILE } from "./util.ts";
import { findCanvas, FRAME_CLASS } from "./win-automation.ts";
import { getWindowText, packCoords, sendMessage, sendCopyDataW, waitForTopWindow, WM_COMMAND } from "./winapi.ts";

const OPEN_DATA_ID = 0x44646557;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
).toString("latin1");

async function query(client: ControlClient, page: number, x: number, y: number): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["element", page, x, y]);
  if (res[0] !== 0) throw new Error(`element ${page} ${x},${y}: ${res[1]}`);
  return String(res[1]);
}

async function point(client: ControlClient, x: number, y: number): Promise<[number, number]> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["widget-cursor", 1, x, y]);
  const match = /pt=(-?\d+),(-?\d+)$/.exec(String(res[1]));
  if (!match) throw new Error(`screen point: ${res[1]}`);
  return [Number(match[1]), Number(match[2])];
}

export async function testit(): Promise<void> {
  const dir = tmpPath("ad-hoc-pdfium-review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "ShowAnnotationAuthorInTooltip = true\nAnnotations [\n DefaultAuthor = B63\n]\n",
  );
  const plain = join(dir, "plain.pdf");
  writeFileSync(
    plain,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]),
  );
  const annotated = join(dir, "annotated.pdf");
  writeFileSync(
    annotated,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R 6 0 R 9 0 R] >>",
      "<< /Type /Annot /Subtype /Link /Rect [100 680 180 720] /A << /S /URI /URI (https://example.com/) >> >>",
      "<< /Type /Annot /Subtype /Text /Rect [120 690 140 710] /Contents (overlap) >>",
      "<< /Type /Annot /Subtype /FileAttachment /P 3 0 R /Rect [200 400 400 600] /FS 7 0 R /Name /PushPin >>",
      "<< /Type /Filespec /F (image002.png) /UF (image002.png) /EF << /F 8 0 R >> >>",
      `<< /Type /EmbeddedFile /Length ${PNG.length} >>\nstream\n${PNG}\nendstream`,
      "<< /Type /Annot /Subtype /Text /Rect [450 700 470 720] /Contents (one\r\r\n two \r\n  ) >>",
    ]),
    "latin1",
  );

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.request(ControlCommand.TestCursorPosition, [0, 0]);
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS, 5000);
      const canvas = findCanvas(frame);
      if (!canvas) throw new Error("canvas missing");
      if (!sendCopyDataW(frame, OPEN_DATA_ID, `[Open("${plain}", 0, 1, 0)]`)) throw new Error("open plain failed");
      await client.waitForRenderIdle();
      if (!(await query(client, 1, 200, 200)).includes("kind=none")) throw new Error("plain page has a hover target");
      const before = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (before[1] !== "editor=none") throw new Error(`plain hover loaded editor: ${before[1]}`);
      const [px, py] = await point(client, 200, 200);
      sendMessage(frame, WM_COMMAND, cmdId("CmdCreateAnnotText"), packCoords(px, py));
      await client.waitForRenderIdle();
      const created = await query(client, 1, 200, 200);
      if (!created.includes("kind=comment") || !created.includes("value=Author: B63")) {
        throw new Error(`new comment invisible: ${created}`);
      }

      if (!sendCopyDataW(frame, OPEN_DATA_ID, `[Open("${annotated}", 0, 1, 0)]`))
        throw new Error("open annotated failed");
      await client.waitForRenderIdle();
      const overlap = await query(client, 1, 130, 92);
      if (!overlap.includes("kind=link")) throw new Error(`comment masks link: ${overlap}`);
      const normalized = await query(client, 1, 460, 82);
      if (!normalized.includes("value=one\n two") || normalized.includes("two \r")) {
        throw new Error(`comment newlines differ: ${JSON.stringify(normalized)}`);
      }
      const attachment = await query(client, 1, 210, 202);
      if (!attachment.includes("target=embedded")) throw new Error(`attachment has no hit target: ${attachment}`);
      const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
      if (editor[1] !== "editor=none") throw new Error(`attachment hover loaded editor: ${editor[1]}`);
      const followed = await client.request(ControlCommand.TestCurrentPdf, ["follow-element", 1, 210, 202]);
      if (followed[0] !== 0) throw new Error(`attachment click did not resolve: ${followed[1]}`);
      await client.waitForRenderIdle();
      if (!getWindowText(frame).includes("image002.png")) throw new Error("attachment click did not open image002.png");
    },
    ["-appdata", dir, "-view", "single page", "-zoom", "fit page"],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

if (import.meta.main) await runStandalone(testit);
