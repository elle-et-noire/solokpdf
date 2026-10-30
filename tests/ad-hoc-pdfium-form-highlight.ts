// Empty-field highlights on PDFium tabs come from PDFium (no MuPDF editor) and match MuPDF's (B46).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { findCanvas, FRAME_CLASS } from "./win-automation.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";
import { getClientRect, packCoords, postMessage, waitForTopWindow, WM_MOUSEMOVE } from "./winapi.ts";

const kWidget = "/Type /Annot /Subtype /Widget /F 4 /DA (/Helv 12 Tf 0 g)";
const kRadio = 49152; // Radio | NoToggleToOff

// Page 1 widgets in /Annots order; `hl` marks the ones MuPDF highlights.
const page1: { obj: string; hl: boolean }[] = [
  { obj: `<< ${kWidget} /P 3 0 R /FT /Tx /T (empty) /Rect [50 700 250 730] >>`, hl: true },
  { obj: `<< ${kWidget} /P 3 0 R /FT /Tx /T (filled) /V (hello) /Rect [300 700 500 730] >>`, hl: false },
  { obj: `<< ${kWidget} /P 3 0 R /FT /Tx /T (ro) /Ff 1 /Rect [50 650 250 680] >>`, hl: false },
  { obj: `<< /Type /Annot /Subtype /Widget /F 6 /P 3 0 R /FT /Tx /T (hidden) /Rect [300 650 500 680] >>`, hl: false },
  { obj: `<< ${kWidget} /P 3 0 R /FT /Tx /T (blank) /V (   ) /Rect [50 600 250 630] >>`, hl: true },
  {
    obj: `<< ${kWidget} /P 3 0 R /FT /Btn /T (cbOff) /AS /Off /AP << /N << /Yes 6 0 R /Off 7 0 R >> >> /Rect [50 550 70 570] >>`,
    hl: true,
  },
  {
    obj: `<< ${kWidget} /P 3 0 R /FT /Btn /T (cbOn) /V /Yes /AS /Yes /AP << /N << /Yes 6 0 R /Off 7 0 R >> >> /Rect [100 550 120 570] >>`,
    hl: false,
  },
  {
    obj: `<< ${kWidget} /P 3 0 R /Parent 99 0 R /AS /A /AP << /N << /A 6 0 R /Off 7 0 R >> >> /Rect [150 550 170 570] >>`,
    hl: false,
  },
  {
    obj: `<< ${kWidget} /P 3 0 R /Parent 99 0 R /AS /Off /AP << /N << /B 6 0 R /Off 7 0 R >> >> /Rect [200 550 220 570] >>`,
    hl: false,
  },
  {
    obj: `<< ${kWidget} /P 3 0 R /Parent 98 0 R /AS /Off /AP << /N << /C 6 0 R /Off 7 0 R >> >> /Rect [250 550 270 570] >>`,
    hl: true,
  },
  {
    obj: `<< ${kWidget} /P 3 0 R /Parent 98 0 R /AS /Off /AP << /N << /D 6 0 R /Off 7 0 R >> >> /Rect [300 550 320 570] >>`,
    hl: true,
  },
  {
    obj: `<< ${kWidget} /P 3 0 R /FT /Ch /Ff 131072 /T (combo) /Opt [(a) (b)] /Rect [50 500 250 530] >>`,
    hl: true,
  },
  { obj: `<< ${kWidget} /P 3 0 R /FT /Ch /T (list) /Opt [(a) (b)] /V (a) /Rect [300 450 500 530] >>`, hl: false },
  { obj: `<< ${kWidget} /P 3 0 R /FT /Sig /T (sig) /Rect [50 380 250 430] >>`, hl: true },
  { obj: `<< ${kWidget} /P 3 0 R /FT /Btn /Ff 65536 /T (push) /Rect [300 380 500 430] >>`, hl: false },
  {
    obj: `<< ${kWidget} /P 3 0 R /FT /Sig /T (signed) /V << /Type /Sig /Filter /Adobe.PPKLite >> /Rect [50 320 250 370] >>`,
    hl: false,
  },
];

function formPdf(): string {
  const first = 8;
  const page1Ids = page1.map((_, i) => first + i);
  const radioOn = first + page1.length;
  const radioOff = radioOn + 1;
  const rotated = radioOff + 1;
  const radioKids = (a: number) => `${page1Ids[a]} 0 R ${page1Ids[a + 1]} 0 R`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [FIELDS] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>`,
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Annots [${page1Ids.map((id) => `${id} 0 R`).join(" ")}] >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate 90 /Annots [${rotated} 0 R] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 15 >>\nstream\n0 0 20 20 re f\n\nendstream",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 0 >>\nstream\n\nendstream",
    ...page1.map((w) => w.obj.replace("99 0 R", `${radioOn} 0 R`).replace("98 0 R", `${radioOff} 0 R`)),
    `<< /FT /Btn /Ff ${kRadio} /T (radioOn) /V /A /Kids [${radioKids(7)}] >>`,
    `<< /FT /Btn /Ff ${kRadio} /T (radioOff) /Kids [${radioKids(9)}] >>`,
    `<< ${kWidget} /P 4 0 R /FT /Tx /T (rotated) /Rect [100 100 300 140] >>`,
  ];
  const fields = [...page1Ids.filter((_, i) => i < 7 || i > 10), radioOn, radioOff, rotated];
  objects[0] = objects[0].replace("FIELDS", fields.map((id) => `${id} 0 R`).join(" "));
  return assemblePdf(objects);
}

async function query(client: ControlClient, args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(`${args.join(" ")}: ${String(res[1])}`);
  return String(res[1]);
}

async function highlights(client: ControlClient, pageNo: number): Promise<string> {
  return query(client, ["form-highlights", pageNo]);
}

const WM_SETCURSOR = 0x0020;
const HTCLIENT = 1;

// A cursor resting over the window (the CI runner's window covers the screen) hovers the page (B49).
async function hoverPage(client: ControlClient, pid: number): Promise<void> {
  const canvas = findCanvas(await waitForTopWindow(pid, FRAME_CLASS, 5000));
  if (!canvas) throw new Error("no canvas");
  const rc = getClientRect(canvas);
  const kSteps = 24;
  for (let i = 0; i <= kSteps; i++) {
    for (let j = 0; j <= kSteps; j++) {
      const x = Math.round(rc.left + ((rc.right - rc.left - 1) * i) / kSteps);
      const y = Math.round(rc.top + ((rc.bottom - rc.top - 1) * j) / kSteps);
      postMessage(canvas, WM_MOUSEMOVE, 0, packCoords(x, y));
      postMessage(canvas, WM_SETCURSOR, canvas, HTCLIENT | (WM_MOUSEMOVE << 16));
    }
  }
  await client.waitForRenderIdle();
}

type State = { before: string[]; after: string[] };

async function run(engine: string): Promise<State> {
  const dir = tmpPath(`pdfium-form-highlight/${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  writeFileSync(source, formPdf(), "latin1");

  return withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      await hoverPage(client, proc.pid!);
      if (engine === "pdfium") {
        const editor = await query(client, ["editor"]);
        if (editor !== "editor=none")
          throw new Error(`pdfium: form paint or hover loaded the MuPDF editor (${editor})`);
      }
      const before = [await highlights(client, 1), await highlights(client, 2)];
      if (engine === "pdfium" && (await query(client, ["editor"])) !== "editor=none") {
        throw new Error("pdfium: highlight query loaded the MuPDF editor");
      }
      // selecting reads the full text: the filled field's text, which only MuPDF extracts
      await client.seedTextSelection(1);
      const res = await client.setFormField(1, 0, "typed");
      if (res[0] !== 0) throw new Error(`${engine}: fill: ${String(res[1])}`);
      const after = [await highlights(client, 1), await highlights(client, 2)];
      await client.resolveUnsavedChanges("discard");
      return { before, after };
    },
    ["-appdata", dir, "-view", "single page", source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

function count(s: string): number {
  const m = /^rects=(\d+)/.exec(s);
  if (!m) throw new Error(`bad highlight result: ${s}`);
  return Number(m[1]);
}

export async function testit(): Promise<void> {
  const mupdf = await run("mupdf");
  const pdfium = await run("pdfium");
  const want = page1.filter((w) => w.hl).length;
  console.log(`mupdf  before: ${mupdf.before.join(" | ")}`);
  console.log(`pdfium before: ${pdfium.before.join(" | ")}`);
  if (count(mupdf.before[0]) !== want || count(mupdf.before[1]) !== 1) {
    throw new Error(`mupdf fixture: want ${want}+1 rects, got ${mupdf.before.join(" | ")}`);
  }
  for (const key of ["before", "after"] as const) {
    for (let i = 0; i < 2; i++) {
      if (pdfium[key][i] !== mupdf[key][i]) {
        throw new Error(`page ${i + 1} ${key}: pdfium ${pdfium[key][i]} != mupdf ${mupdf[key][i]}`);
      }
    }
  }
  if (count(pdfium.after[0]) !== want - 1) throw new Error(`filled field still highlighted: ${pdfium.after[0]}`);
  console.log("form highlights match MuPDF without loading the editor");
}

if (import.meta.main) await runStandalone(testit);
