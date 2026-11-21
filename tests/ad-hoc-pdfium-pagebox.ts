// Opt-in PDFium geometry check. Build with solok-build.ts, then run with --no-build.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
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

function fixture(selected = cases, header?: string): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${selected.map((_, i) => `${4 + i} 0 R`).join(" ")}] /Count ${selected.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i]!;
    const streamNo = 4 + selected.length + i;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [${c.media.join(" ")}] ` +
        `${c.crop ? `/CropBox [${c.crop.join(" ")}] ` : ""}` +
        `${c.rotate === undefined ? "" : `/Rotate ${c.rotate} `}` +
        `${c.unit === undefined ? "" : `/UserUnit ${c.unit} `}` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamNo} 0 R /Annots [${4 + 2 * selected.length + i} 0 R] >>`,
    );
  }
  for (let i = 0; i < selected.length; i++) {
    const content =
      "1 0 0 rg 110 160 40 30 re f\n" +
      "0 0 1 rg 170 240 30 30 re f\n" +
      `0 g BT /F1 12 Tf 115 220 Td (Needle${i}) Tj ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  for (let i = 0; i < selected.length; i++) {
    objects.push(
      "<< /Type /Annot /Subtype /Link /Rect [115 205 170 225] /Border [0 0 0] " +
        "/A << /S /URI /URI (https://example.com/pagebox) >> >>",
    );
  }
  return assemblePdf(objects, { header });
}

function compressedFixture(c: Case, order: "type-first" | "filter-first" = "type-first"): Buffer {
  const page =
    `<< /Type /Page /Parent 2 0 R /MediaBox [${c.media.join(" ")}] /CropBox [${c.crop!.join(" ")}] ` +
    `${c.rotate === undefined ? "" : `/Rotate ${c.rotate} `}` +
    `${c.unit === undefined ? "" : `/UserUnit ${c.unit} `}` +
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>";
  const content =
    "1 0 0 rg 110 160 40 30 re f\n0 0 1 rg 170 240 30 30 re f\n0 g BT /F1 12 Tf 115 220 Td (Needle0) Tj ET";
  const compressed = deflateSync(Buffer.from(`3 0 ${page}`, "latin1"));
  const chunks: Buffer[] = [];
  const offsets = new Array<number>(9).fill(0);
  let length = 0;
  function add(data: string | Buffer): void {
    const buf = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    chunks.push(buf);
    length += buf.length;
  }
  function object(id: number, data: string | Buffer): void {
    offsets[id] = length;
    add(`${id} 0 obj\n`);
    add(data);
    add("\nendobj\n");
  }
  add("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  object(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  object(
    6,
    "<< /Type /Annot /Subtype /Link /Rect [115 205 170 225] /Border [0 0 0] /A << /S /URI /URI (https://example.com/pagebox) >> >>",
  );
  object(
    7,
    Buffer.concat([
      Buffer.from(
        order === "filter-first"
          ? `<</Filter/FlateDecode/First 4/Length ${compressed.length}/N 1/Type/ObjStm>>stream\r\n`
          : `<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
      ),
      compressed,
      Buffer.from("\nendstream"),
    ]),
  );
  const xrefStart = length;
  offsets[8] = xrefStart;
  const xref = Buffer.alloc(9 * 7);
  for (let i = 0; i < 9; i++) {
    const at = i * 7;
    xref[at] = i === 0 ? 0 : i === 3 ? 2 : 1;
    xref.writeUInt32BE(i === 3 ? 7 : offsets[i]!, at + 1);
    xref.writeUInt16BE(i === 0 ? 65535 : 0, at + 5);
  }
  object(
    8,
    Buffer.concat([
      Buffer.from(`<< /Type /XRef /Size 9 /Root 1 0 R /W [1 4 2] /Length ${xref.length} >>\nstream\n`),
      xref,
      Buffer.from("\nendstream"),
    ]),
  );
  add(`startxref\n${xrefStart}\n%%EOF\n`);
  return Buffer.concat(chunks);
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
  const compressedUnit: Case = { name: "compressed-unit", media, crop, unit: 2 };
  const compressedRotate: Case = { name: "compressed-rotate", media, crop, rotate: 46 };
  const largeUnit: Case = { name: "large-unit", media, crop, unit: 2 };
  const fixtures = [
    { name: "plain", data: fixture(), cases },
    { name: "compressed-unit", data: compressedFixture(compressedUnit), cases: [compressedUnit] },
    { name: "compressed-rotate", data: compressedFixture(compressedRotate, "filter-first"), cases: [compressedRotate] },
    {
      name: "large-unit",
      data: fixture([largeUnit], `%PDF-1.4\n%${"x".repeat(33 * 1024 * 1024)}\n`),
      cases: [largeUnit],
    },
  ];
  const failures: string[] = [];
  for (const item of fixtures) {
    const pdf = tmpPath(`pdfium-pagebox-${item.name}.pdf`);
    writeFileSync(pdf, item.data, "latin1");
    failures.push(...(await compareFixture(pdf, item.cases)));
  }
  if (failures.length) throw new Error(`page geometry differs:\n${failures.join("\n")}`);
  console.log(
    `${fixtures.reduce((n, item) => n + item.cases.length, 0)} page-box cases match at ${zooms.join("% and ")}%`,
  );
}

async function compareFixture(pdf: string, selected: Case[]): Promise<string[]> {
  const reports = new Map<string, Report[]>();
  for (const engine of ["mupdf", "pdfium"]) {
    reports.set(
      engine,
      await withControlledSumatra(
        EXE,
        async (client) => {
          await client.waitForRenderIdle();
          const result: Report[] = [];
          for (let page = 1; page <= selected.length; page++) result.push(await inspect(client, pdf, page));
          return result;
        },
        [pdf],
        { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
      ),
    );
  }
  const failures: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i]!;
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
  return failures;
}

if (import.meta.main) await runStandalone(testit);
