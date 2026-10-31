// Hovering form fields on PDFium tabs is answered by PDFium (no MuPDF editor) and matches MuPDF (B47).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { findCanvas, FRAME_CLASS } from "./win-automation.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";
import { packCoords, postMessage, waitForTopWindow, WM_MOUSEMOVE } from "./winapi.ts";

const kWidget = "/Type /Annot /Subtype /Widget /F 4 /P 3 0 R /DA (/Helv 12 Tf 0 g)";
const kCheckAp = "/AS /Off /AP << /N << /Yes 5 0 R /Off 6 0 R >> >>";

// widgets in /Annots order (PDF space, page 600x800)
const widgets = [
  `<< ${kWidget} /FT /Tx /T (name) /TU (Your name) /Rect [50 700 250 730] >>`,
  `<< ${kWidget} /FT /Tx /T (ro) /Ff 1 /Rect [300 700 500 730] >>`,
  `<< /Type /Annot /Subtype /Widget /F 6 /P 3 0 R /FT /Tx /T (hidden) /Rect [50 650 250 680] >>`,
  `<< ${kWidget} /FT /Btn /T (cb) ${kCheckAp} /Rect [50 600 70 620] >>`,
  `<< ${kWidget} /FT /Ch /Ff 131072 /T (combo) /Opt [(a) (b)] /Rect [100 600 300 630] >>`,
  `<< ${kWidget} /FT /Btn /Ff 65536 /T (push) /Rect [350 600 500 630] >>`,
  `<< ${kWidget} /FT /Sig /T (sig) /Rect [50 520 250 570] >>`,
  `<< ${kWidget} /FT /Tx /T (big) /TU (Big field) /Rect [300 450 550 570] >>`,
  `<< ${kWidget} /FT /Btn /T (inner) ${kCheckAp} /Rect [400 500 420 520] >>`,
  `<< ${kWidget} /FT /Btn /Ff 49152 /T (radio) ${kCheckAp.replace("/Yes", "/A")} /Rect [50 450 70 470] >>`,
];

// probes in page space (y down): name, read-only, hidden, checkbox, combo, push, signature,
// inner checkbox over a text field, the text field around it, radio, empty page
const probes: [string, number, number][] = [
  ["name", 150, 85],
  ["ro", 400, 85],
  ["hidden", 150, 135],
  ["cb", 60, 190],
  ["combo", 200, 185],
  ["push", 425, 185],
  ["sig", 150, 255],
  ["inner", 410, 290],
  ["big", 320, 240],
  ["radio", 60, 340],
  ["empty", 450, 700],
];

function formPdf(): string {
  const first = 7;
  const refs = widgets.map((_, i) => `${first + i} 0 R`).join(" ");
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${refs}] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >> >>`,
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Annots [${refs}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 15 >>\nstream\n0 0 20 20 re f\n\nendstream",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 0 >>\nstream\n\nendstream",
    ...widgets,
  ]);
}

async function query(client: ControlClient, args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(`${args.join(" ")}: ${String(res[1])}`);
  return String(res[1]);
}

// Hover gives up while a render holds the engine's lock and reports no field, so retry a miss.
async function widgetCursor(client: ControlClient, x: number, y: number): Promise<string> {
  let res = "";
  for (let i = 0; i < 4; i++) {
    res = await query(client, ["widget-cursor", 1, x, y]);
    if (!res.startsWith("cursor=none tip=- ")) break;
    await Bun.sleep(50);
  }
  return res;
}

async function expectEditor(client: ControlClient, engine: string, want: string, what: string): Promise<void> {
  if (engine !== "pdfium") return;
  const editor = await query(client, ["editor"]);
  if (editor !== want) throw new Error(`pdfium: ${what}: ${editor}, want ${want}`);
}

function count(s: string): number {
  const m = /^rects=(\d+)/.exec(s);
  if (!m) throw new Error(`bad highlight result: ${s}`);
  return Number(m[1]);
}

type Hit = { cursor: string; x: number; y: number };

async function run(engine: string): Promise<Map<string, string>> {
  const dir = tmpPath(`pdfium-form-hover/${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  writeFileSync(source, formPdf(), "latin1");

  return withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.setNotificationsEnabled(false);
      await client.waitForRenderIdle();
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS, 5000);
      const canvas = findCanvas(frame);
      if (!canvas) throw new Error("no canvas");

      const hits = new Map<string, Hit>();
      for (const [name, x, y] of probes) {
        const res = await widgetCursor(client, x, y);
        const m = /^cursor=(\w+) tip=(.*) pt=(-?\d+),(-?\d+)$/.exec(res);
        if (!m) throw new Error(`${name}: bad widget-cursor result: ${res}`);
        hits.set(name, { cursor: `${m[1]} tip=${m[2]}`, x: Number(m[3]), y: Number(m[4]) });
        postMessage(canvas, WM_MOUSEMOVE, 0, packCoords(Number(m[3]), Number(m[4])));
        await client.waitForRenderIdle();
      }
      await expectEditor(client, engine, "editor=none", "hovering fields loaded the MuPDF editor");

      // a click hit-tests like hover: empty space mustn't load the editor, a field must
      const hit = (n: string) => query(client, ["widget-hit", 1, ...probes.find((p) => p[0] === n)!.slice(1)]);
      if ((await hit("empty")) !== "widget=no") throw new Error(`${engine}: click on empty space hit a widget`);
      await expectEditor(client, engine, "editor=none", "clicking empty page space loaded the MuPDF editor");
      if ((await hit("name")) !== "widget=yes") throw new Error(`${engine}: click on a text field missed it`);
      await expectEditor(client, engine, "editor=loaded", "clicking a field");

      // editing works through the loaded editor: a toggled checkbox stops being highlighted as empty
      const before = await query(client, ["form-highlights", 1]);
      const toggled = await client.toggleFormButton(1, 0);
      const after = await query(client, ["form-highlights", 1]);
      if (!toggled.toggled || count(after) !== count(before) - 1) {
        throw new Error(`${engine}: checkbox toggle: ${before} -> ${after}`);
      }

      // once the editor is loaded it answers, and must agree
      for (const [n, x, y] of probes) {
        const m = /^cursor=(\w+) tip=(.*) pt=/.exec(await widgetCursor(client, x, y))!;
        const after = `${m[1]} tip=${m[2]}`;
        if (after !== hits.get(n)!.cursor) {
          throw new Error(`${engine} ${n}: ${after} after edit, ${hits.get(n)!.cursor} before`);
        }
      }
      await client.resolveUnsavedChanges("discard");
      return new Map([...hits].map(([n, h]) => [n, h.cursor]));
    },
    ["-appdata", dir, "-view", "single page", "-zoom", "fit page", source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  const mupdf = await run("mupdf");
  const pdfium = await run("pdfium");
  const show = (m: Map<string, string>) => [...m].map(([n, c]) => `${n}: ${c}`).join(", ");
  console.log(`mupdf : ${show(mupdf)}`);
  console.log(`pdfium: ${show(pdfium)}`);
  if (
    mupdf.get("name") !== "text tip=Your name" ||
    mupdf.get("cb") !== "button tip=-" ||
    mupdf.get("empty") !== "none tip=-"
  ) {
    throw new Error("mupdf fixture: unexpected cursors");
  }
  for (const [n, c] of mupdf) {
    if (pdfium.get(n) !== c) throw new Error(`${n}: pdfium ${pdfium.get(n)} != mupdf ${c}`);
  }
  console.log("form hover matches MuPDF without loading the editor");
}

if (import.meta.main) await runStandalone(testit);
