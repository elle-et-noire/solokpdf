// Opt-in PDFium geometry check. Build with solok-build.ts, then run with --no-build.
import { writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

type Case = { name: string; media: number[]; crop?: number[]; rotate?: number; unit?: number };
type Rect = number[];
type Report = { media: Rect; link: Rect; screen: Rect; text: Rect; renders: Map<number, Render> };
type Render = { size: number[]; redBox: Rect; blueBox: Rect; red: number; blue: number };

const media = [40, 60, 280, 380];
const crop = [70, 90, 250, 350];
const cases: Case[] = [
  { name: "ordinary", media: [0, 0, 240, 320] },
  { name: "media-origin", media },
  { name: "crop-inside", media, crop },
  { name: "crop-outside", media, crop: [0, 0, 350, 450] },
  { name: "rotate-90", media, crop, rotate: 90 },
  { name: "rotate-180", media, crop, rotate: 180 },
  { name: "rotate-270", media, crop, rotate: 270 },
  { name: "rotate-46", media, crop, rotate: 46 },
  { name: "rotate-minus-87", media, crop, rotate: -87 },
  { name: "unit-half", media, crop, unit: 0.5 },
  { name: "unit-two", media, crop, unit: 2 },
  { name: "unit-3.7", media, crop, unit: 3.7 },
  { name: "combined", media, crop: [0, 0, 350, 450], rotate: 270, unit: 3.7 },
  { name: "combined-half", media, crop, rotate: 180, unit: 0.5 },
];
const zooms = [100, 175];

function fixture(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${cases.map((_, i) => `${4 + i} 0 R`).join(" ")}] /Count ${cases.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const streamNo = 4 + cases.length + i;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [${c.media.join(" ")}] ` +
        `${c.crop ? `/CropBox [${c.crop.join(" ")}] ` : ""}` +
        `${c.rotate === undefined ? "" : `/Rotate ${c.rotate} `}` +
        `${c.unit === undefined ? "" : `/UserUnit ${c.unit} `}` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamNo} 0 R /Annots [${4 + 2 * cases.length + i} 0 R] >>`,
    );
  }
  for (let i = 0; i < cases.length; i++) {
    const content =
      "1 0 0 rg 110 160 40 30 re f\n" +
      "0 0 1 rg 170 240 30 30 re f\n" +
      `0 g BT /F1 12 Tf 115 220 Td (Needle${i}) Tj ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  for (let i = 0; i < cases.length; i++) {
    objects.push(
      "<< /Type /Annot /Subtype /Link /Rect [115 205 170 225] /Border [0 0 0] " +
        "/A << /S /URI /URI (https://example.com/pagebox) >> >>",
    );
  }
  return assemblePdf(objects);
}

function field(raw: string, name: string, count: number): number[] {
  const match = new RegExp(`(?:^| )${name}=(-?[\\d.,]+)`).exec(raw);
  if (!match) throw new Error(`missing ${name}: ${raw}`);
  const values = match[1]!.split(",").map(Number);
  if (values.length !== count || values.some((v) => !Number.isFinite(v))) throw new Error(`bad ${name}: ${raw}`);
  return values;
}

async function request(client: ControlClient, cmd: ControlCommand, args: (string | number)[]): Promise<string> {
  const [code, raw] = await client.request(cmd, args);
  if (code !== 0) throw new Error(`${ControlCommand[cmd]}: ${raw}`);
  return String(raw);
}

async function inspect(client: ControlClient, pdf: string, page: number): Promise<Report> {
  const boxes = await request(client, ControlCommand.TestPageBoxes, [page]);
  const links = await request(client, ControlCommand.TestPageLinks, [pdf, page]);
  const search = await request(client, ControlCommand.TestSearch, [pdf, `Needle${page - 1}`]);
  if (!search.includes(`page=${page} `)) throw new Error(`wrong search page: ${search}`);
  const renders = new Map<number, Render>();
  for (const zoom of zooms) {
    const raw = await request(client, ControlCommand.TestRenderPageColors, [pdf, page, zoom]);
    const size = /size=(\d+)x(\d+)/.exec(raw);
    if (!size) throw new Error(`missing render size on page ${page} at ${zoom}%: ${JSON.stringify(raw)}`);
    renders.set(zoom, {
      size: [+size[1]!, +size[2]!],
      redBox: field(raw, "redBox", 4),
      blueBox: field(raw, "blueBox", 4),
      red: field(raw, "red", 1)[0]!,
      blue: field(raw, "blue", 1)[0]!,
    });
  }
  return {
    media: field(boxes, "engineMedia", 4),
    link: field(links, "src", 4),
    screen: field(links, "screen", 4),
    text: field(search, "rect", 4),
    renders,
  };
}

function compare(name: string, a: number[], b: number[], tolerance: number, failures: string[]): void {
  if (a.some((v, i) => Math.abs(v - b[i]!) > tolerance)) {
    failures.push(`${name}: MuPDF ${a.join(",")} PDFium ${b.join(",")}`);
  }
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("pdfium-pagebox.pdf");
  writeFileSync(pdf, fixture(), "latin1");
  const reports = new Map<string, Report[]>();
  for (const engine of ["mupdf", "pdfium"]) {
    reports.set(
      engine,
      await withControlledSumatra(
        EXE,
        async (client) => {
          await client.waitForRenderIdle();
          const result: Report[] = [];
          for (let page = 1; page <= cases.length; page++) result.push(await inspect(client, pdf, page));
          return result;
        },
        [pdf],
        { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
      ),
    );
  }
  const failures: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const a = reports.get("mupdf")![i]!;
    const b = reports.get("pdfium")![i]!;
    compare(`${c.name} size`, a.media, b.media, 0.05, failures);
    compare(`${c.name} link`, a.link, b.link, 0.1, failures);
    compare(`${c.name} link screen`, a.screen, b.screen, 0.2, failures);
    compare(`${c.name} search`, a.text, b.text, 8 * (c.unit ?? 1), failures);
    for (const zoom of zooms) {
      const ar = a.renders.get(zoom)!;
      const br = b.renders.get(zoom)!;
      const pixelTolerance = c.unit !== undefined && c.unit < 1 ? 0.12 : 0.05;
      compare(`${c.name} ${zoom}% size`, ar.size, br.size, 1, failures);
      compare(`${c.name} ${zoom}% red pixels`, ar.redBox, br.redBox, 2, failures);
      compare(`${c.name} ${zoom}% blue pixels`, ar.blueBox, br.blueBox, 2, failures);
      if (Math.abs(ar.red - br.red) > Math.max(20, ar.red * pixelTolerance))
        failures.push(`${c.name} ${zoom}% red count ${ar.red} vs ${br.red}`);
      if (Math.abs(ar.blue - br.blue) > Math.max(20, ar.blue * pixelTolerance))
        failures.push(`${c.name} ${zoom}% blue count ${ar.blue} vs ${br.blue}`);
    }
  }
  if (failures.length) throw new Error(`page geometry differs:\n${failures.join("\n")}`);
  console.log(`${cases.length} page-box cases match at ${zooms.join("% and ")}%`);
}

if (import.meta.main) await runStandalone(testit);
