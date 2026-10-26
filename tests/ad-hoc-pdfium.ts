// Opt-in backend check. Build with cmd/solok-build.ts, then run with --no-build.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { EXE, assemblePdf, cmdId, runStandalone, tmpPath } from "./util.ts";
import { waitForFrame, sendCommand } from "./win-automation.ts";
import { captureWindowToPng, sendMessage, packCoords, setProcessDpiAware } from "./winapi.ts";

function fixture(): string {
  return assemblePdf(fixtureObjects());
}

function fixtureObjects(): string[] {
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  return [
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
  ];
}

// a comment line that grows the PDF past the engine's in-memory limit (32 MiB)
const kBigFileHeader = `%PDF-1.4\n%${"x".repeat(33 * 1024 * 1024)}\n`;

function rewrittenFixture(header?: string): string {
  const text = "BT /F1 18 Tf 40 200 Td (Rewritten by producer) Tj ET";
  return assemblePdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ],
    { header },
  );
}

// A LaTeX-style producer must be able to overwrite the open PDF, which then reloads.
// A big file is read on demand, so the engine keeps its handle open meanwhile.
async function expectOverwriteReload(size: "small" | "big"): Promise<void> {
  const header = size === "big" ? kBigFileHeader : undefined;
  const path = tmpPath(`pdfium/overwrite-${size}.pdf`);
  writeFileSync(path, assemblePdf(fixtureObjects(), { header }), "latin1");
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      writeFileSync(path, rewrittenFixture(header), "latin1");
      for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(50)) {
        const r = await client.request(ControlCommand.TestPageInfo);
        if (r[0] === 0 && String(r[1]).includes("pages=1 ")) {
          console.log(`Overwritten ${size} PDF reloaded`);
          return;
        }
      }
      throw new Error(`Overwritten ${size} PDF was not reloaded`);
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", tmpPath(`pdfium/overwrite-${size}.log`), path],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  rmSync(path, { force: true });
}

// pages labeled i, ii, 1, 2, 3; "-named-dest 2" falls back to the page labeled "2" (page 4)
async function expectPageLabels(): Promise<void> {
  const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>";
  const path = tmpPath("pdfium/labels.pdf");
  const pdf = assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /r >> 2 << /S /D >>] >> >>",
    "<< /Type /Pages /Count 5 /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R] >>",
    page,
    page,
    page,
    page,
    page,
  ]);
  writeFileSync(path, pdf, "latin1");
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      await expectPage(client, 4);
      for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(50)) {
        if ((await client.virtTree()).some((r) => r.text === " / 3 (4 / 5)")) {
          console.log("Page labels shown and resolved");
          return;
        }
      }
      throw new Error("Toolbar did not show page labels");
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", tmpPath("pdfium/labels.log"), "-named-dest", "2", path],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

// plain-text URL, wrapped URL (not joined, like MuPDF), DOI, and a URL covered by a link annotation
function autoLinksFixture(): string {
  // one text block with y steps, as in a typeset paragraph
  const lines: [number, string][] = [
    [250, "Visit https://example.com/solok-auto now."],
    [-20, "https://example.com/wrapped/"],
    [-14, "tail-part end"],
    [-26, "DOI 10.1109/WICSA.2015.29."],
    [-30, "https://arxiv.org/abs/1706.03762"],
  ];
  const moves = lines.map(([dy, s], i) => `${i ? 0 : 40} ${dy} Td (${s}) Tj`).join("\n");
  const text = `BT /F1 12 Tf\n${moves}\nET`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Annot /Subtype /Link /Rect [38 156 240 172] /Border [0 0 0] /A << /S /URI /URI (https://arxiv.org/abs/1706.03762) >> >>",
  ]);
}

function linkValues(links: string): string[] {
  return [...links.matchAll(/ value=(\S+)/g)].map((m) => m[1]!).sort();
}

const expectedAutoLinks = [
  "https://arxiv.org/abs/1706.03762",
  "https://doi.org/10.1109/WICSA.2015.29",
  "https://example.com/solok-auto",
  "https://example.com/wrapped/",
];

// with DisableAutoLinks only the annotation link remains
async function expectAutoLinksDisabled(path: string): Promise<void> {
  const settings = tmpPath("pdfium/noauto");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "SolokPDF-settings.txt"), "UiLanguage = en\nDisableAutoLinks = true\n");
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const links = await request(client, ControlCommand.TestPageLinks, [path, 1]);
      const got = linkValues(links).join(" ");
      if (got !== "https://arxiv.org/abs/1706.03762") throw new Error(`DisableAutoLinks links: ${got}`);
    },
    ["-appdata", settings, "-log-to-file", tmpPath("pdfium/noauto.log"), path],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

const destViews = [
  "/XYZ 60 300 1.5",
  "/XYZ null 300 0",
  "/Fit",
  "/FitH 250",
  "/FitH null",
  "/FitV 100",
  "/FitR 40 50 200 300",
  "/FitB",
  "/FitBH 200",
  "/FitBV 60",
];

// one outline entry and one link per view to a cropped page, plus a link tooltip, GoToR and Launch
function destsFixture(): string {
  const n = destViews.length;
  const outlines = destViews.map((v, i) => {
    const prev = i > 0 ? ` /Prev ${6 + i - 1} 0 R` : "";
    const next = i < n - 1 ? ` /Next ${6 + i + 1} 0 R` : "";
    return `<< /Title (view ${i + 1}) /Parent 5 0 R${prev}${next} /Dest [4 0 R ${v}] >>`;
  });
  const link = (y: number, rest: string) =>
    `<< /Type /Annot /Subtype /Link /Rect [10 ${y} 140 ${y + 15}] /Border [0 0 0] ${rest} >>`;
  const links = [
    ...destViews.map((v, i) => link(380 - 20 * i, `/Dest [4 0 R ${v}]`)),
    link(160, "/Contents (Go to the target) /Dest [4 0 R /Fit]"),
    link(140, "/A << /S /GoToR /F (other.pdf) /D (chapter) >>"),
    link(120, "/A << /S /Launch /F (sub/notes.txt) >>"),
    ...["NextPage", "PrevPage", "FirstPage", "LastPage"].map((n, i) =>
      link(100 - 20 * i, `/A << /S /Named /N /${n} >>`),
    ),
  ];
  const firstLink = 6 + n;
  const annots = links.map((_, i) => `${firstLink + i} 0 R`).join(" ");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Annots [${annots}] >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /CropBox [20 30 280 370] >>",
    `<< /Type /Outlines /First 6 0 R /Last ${5 + n} 0 R /Count ${n} >>`,
    ...outlines,
    ...links,
  ]);
}

// link and outline destinations as one engine reports them, numbers rounded and lines sorted
async function destsReport(path: string, engine: string): Promise<string> {
  return await withControlledSumatra(
    EXE,
    async (client) => {
      const lines = (await request(client, ControlCommand.TestPageLinks, [path, 1])).trim().split("\n");
      for (let i = 1; i <= destViews.length; i++) {
        lines.push((await request(client, ControlCommand.TestDest, [path, i])).trim());
      }
      // engine-specific kind names; a file link's dest rect is unused (MuPDF copies the link's)
      const normalize = (s: string) =>
        s
          .replace("kind=destinationMupdf", "kind=scrollTo")
          .replace(/^(kind=launchFile .*) dest=\S+/, "$1")
          .replace(/-?\d+(\.\d+)?/g, (m) => String(Math.round(Number(m) * 10) / 10));
      return lines.map(normalize).sort().join("\n");
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", tmpPath(`pdfium/dests-${engine}.log`)],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

// PDFium destinations, tooltips and file links match MuPDF's
async function expectDestsMatchMupdf(): Promise<void> {
  const path = tmpPath("pdfium/dests.pdf");
  writeFileSync(path, destsFixture(), "latin1");
  const pdfium = await destsReport(path, "pdfium");
  const mupdf = await destsReport(path, "mupdf");
  if (pdfium !== mupdf) throw new Error(`Destinations differ.\nPDFium:\n${pdfium}\nMuPDF:\n${mupdf}`);
  if (!pdfium.includes("value=Go to the target") || !pdfium.includes("kind=launchFile page=-1")) {
    throw new Error(`Link tooltip or file link missing:\n${pdfium}`);
  }
  if (!/page=2 src=10,285,130,15 /.test(pdfium)) throw new Error(`NextPage link missing:\n${pdfium}`);
  if (!readFileSync(tmpPath("pdfium/dests-pdfium.log"), "utf8").includes("PDFium 158.0.8111.0: opened")) {
    throw new Error("PDFium did not open the destinations fixture");
  }
  console.log("PDFium destinations match MuPDF");
}

// A NextPage link's rect comes from MuPDF; on a cropped, rotated page it must still land where
// PDFium puts a GoTo link with the same /Rect, or clicks would miss it.
async function expectNamedLinkRects(): Promise<void> {
  const rect = "/Rect [50 60 150 90] /Border [0 0 0]";
  const path = tmpPath("pdfium/named-rotated.pdf");
  writeFileSync(
    path,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /CropBox [20 30 280 370] /Rotate 90 /Annots [5 0 R 6 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
      `<< /Type /Annot /Subtype /Link ${rect} /Dest [4 0 R /Fit] >>`,
      `<< /Type /Annot /Subtype /Link ${rect} /A << /S /Named /N /NextPage >> >>`,
    ]),
    "latin1",
  );
  await withControlledSumatra(
    EXE,
    async (client) => {
      const lines = (await request(client, ControlCommand.TestPageLinks, [path, 1])).trim().split("\n");
      // PDFium's own rects carry its coordinate quantization (29.9999 for 30)
      const srcs = lines.map((l) => (/page=2 src=(\S+)/.exec(l)?.[1] ?? "").split(",").map(Number));
      const same =
        srcs.length === 2 && srcs[0]!.length === 4 && srcs[0]!.every((v, i) => Math.abs(v - srcs[1]![i]!) < 0.01);
      if (!same) throw new Error(`Named link rect differs:\n${lines.join("\n")}`);
      console.log("PDFium NextPage link rect matches its GoTo twin on a rotated page");
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", tmpPath("pdfium/named.log")],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

// Following a GoToR link with a named /D opens the target file at that destination, as with MuPDF.
async function expectRemoteNamedDest(engine: string): Promise<void> {
  const dir = tmpPath(`pdfium/remote-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>";
  writeFileSync(
    join(dir, "target.pdf"),
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(chapter) [5 0 R /Fit]] >> >> >>",
      "<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>",
      page,
      page,
      page,
    ]),
    "latin1",
  );
  const source = join(dir, "source.pdf");
  writeFileSync(
    source,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Annots [4 0 R] >>",
      "<< /Type /Annot /Subtype /Link /Rect [40 300 200 330] /A << /S /GoToR /F (target.pdf) /D (chapter) >> >>",
    ]),
    "latin1",
  );
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      await client.waitForRenderIdle();
      let dump = "";
      for (const deadline = Date.now() + 4000; Date.now() < deadline; await Bun.sleep(25)) {
        sendCommand(frame, cmdId("CmdToggleKeyboardLinkFollowing"));
        dump = String((await client.request(ControlCommand.TestKeyboardLinkFollow, []))[1] ?? "");
        if (/active=1 .*count=1/.test(dump)) break;
        await client.request(ControlCommand.TestKeyboardLinkFollow, ["stop"]);
      }
      const hint = / hint=([A-Z]+)$/m.exec(dump)?.[1];
      if (!hint) throw new Error(`${engine}: link following did not start:\n${dump}`);
      await client.request(ControlCommand.TestKeyboardLinkFollow, ["char", hint]);
      let tab = "";
      for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(50)) {
        tab = String((await client.request(ControlCommand.TestCurrentTab))[1] ?? "");
        if (tab.includes("target.pdf") && tab.endsWith("page=3")) break;
      }
      await client.waitForRenderIdle();
      if (!tab.includes("target.pdf") || !tab.endsWith("page=3")) {
        throw new Error(`${engine}: GoToR to named dest landed at '${tab}', want target.pdf page=3`);
      }
      console.log(`${engine}: GoToR opened target.pdf at its named destination`);
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", join(dir, "log.txt"), source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

// a first open honors /OpenAction, in its array and GoTo action forms
async function expectOpenAction(): Promise<void> {
  const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>";
  for (const [name, action] of [
    ["array", "[4 0 R /Fit]"],
    ["goto", "<< /S /GoTo /D [5 0 R /XYZ null null 0] >>"],
  ]) {
    const path = tmpPath(`pdfium/openaction-${name}.pdf`);
    const pdf = assemblePdf([
      `<< /Type /Catalog /Pages 2 0 R /OpenAction ${action} >>`,
      "<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>",
      page,
      page,
      page,
    ]);
    writeFileSync(path, pdf, "latin1");
    const log = tmpPath(`pdfium/openaction-${name}.log`);
    await withControlledSumatra(
      EXE,
      async (client) => {
        await client.waitForRenderIdle();
        await expectPage(client, name === "array" ? 2 : 3);
      },
      ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", log, path],
      { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
    );
    if (!readFileSync(log, "utf8").includes("PDFium 158.0.8111.0: opened")) throw new Error(`${name}: not PDFium`);
  }
  console.log("PDFium honors /OpenAction");
}

// encrypted PDFs open in PDFium with the right password; a wrong one doesn't fall back to MuPDF
async function expectPassword(source: string): Promise<void> {
  const password = "solok-pässword";
  const path = tmpPath("pdfium/encrypted.pdf");
  const clean = Bun.spawnSync({
    cmd: ["cmd.exe", "/c", EXE, "clean", "-E", "aes-256", "-U", password, "-O", "owner", source, path],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (clean.exitCode !== 0) throw new Error(`Cannot encrypt the fixture: ${clean.stderr}`);
  const log = tmpPath("pdfium/password.log");
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      await expectPage(client, 1);
      const found = await request(client, ControlCommand.TestSearch, [path, "Needle", password]);
      if (!found.includes("FOUND needle=Needle page=1")) throw new Error(`Search with password: ${found}`);
      const r = await client.request(ControlCommand.TestSearch, [path, "Needle", "wrong"]);
      if (!String(r[1]).includes("ERROR engine-create-failed")) throw new Error(`Wrong password opened: ${r[1]}`);
    },
    ["-appdata", tmpPath("pdfium/settings"), "-log-to-file", log, "-pwd", password, path],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
  const output = readFileSync(log, "utf8");
  const opened = output.split("\n").filter((l) => l.includes("PDFium 158.0.8111.0: opened") && l.includes("encrypted"));
  if (opened.length < 2 || output.includes("Using MuPDF fallback")) {
    throw new Error(`Encrypted PDF did not open in PDFium only. See ${log}`);
  }
  console.log("PDFium opens password-protected PDFs");
}

// unembedded fonts: localized family names (PDFium reads their PostScript names while enumerating) and others
const fontCacheFaces = [
  "MS-Gothic",
  "MS-Mincho",
  "MS-PGothic",
  "MS-UIGothic",
  "Meiryo",
  "YuGothic-Regular",
  "YuMincho-Regular",
  "BIZ-UDGothic",
  "Calibri",
  "Times-Roman",
];

function fontCacheFixture(): string {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "", ""];
  const fonts: string[] = [];
  const lines: string[] = [];
  for (const [i, face] of fontCacheFaces.entries()) {
    const latin = objects.length + 1;
    objects.push(
      `<< /Type /Font /Subtype /TrueType /BaseFont /${face} /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(600).join(" ")}] /FontDescriptor ${latin + 1} 0 R >>`,
      `<< /Type /FontDescriptor /FontName /${face} /Flags 32 /FontBBox [-100 -250 1100 1000] /ItalicAngle 0 /Ascent 900 /Descent -250 /CapHeight 700 /StemV 80 >>`,
      `<< /Type /Font /Subtype /Type0 /BaseFont /${face} /Encoding /UniJIS-UCS2-H /DescendantFonts [${latin + 3} 0 R] >>`,
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${face} /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor ${latin + 1} 0 R /DW 1000 >>`,
    );
    fonts.push(`/L${i} ${latin} 0 R /J${i} ${latin + 2} 0 R`);
    const y = 760 - i * 36;
    lines.push(`BT /L${i} 14 Tf 20 ${y} Td (${face}: ABC abc 0123) Tj ET`);
    lines.push(`BT /J${i} 14 Tf 300 ${y} Td <3042304430463048304A65E5672C8A9E6F225B57> Tj ET`);
  }
  const content = lines.join("\n");
  objects[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fonts.join(" ")} >> >> /Contents 4 0 R >>`;
  objects[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  return assemblePdf(objects);
}

// render page 1 to an image; returns its hash and what the font cache logged
async function renderWithFontCache(path: string, name: string, appdata: string, cache: string) {
  mkdirSync(appdata, { recursive: true });
  const log = tmpPath(`pdfium/fontcache-${name}.log`);
  const image = await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const r = await request(client, ControlCommand.TestConvertToImages, [join(appdata, `${name}-<N>.bmp`), "1", 96]);
      return /first=(.+)$/.exec(r.trim())![1]!;
    },
    ["-appdata", appdata, "-log-to-file", log, path],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_FONT_CACHE: cache } },
  );
  const hash = createHash("sha256").update(readFileSync(image)).digest("hex");
  const cacheLog = /PdfiumFontCache: (\w+) (\d+)/.exec(readFileSync(log, "utf8"));
  return { hash, mode: cacheLog?.[1] ?? "off", fonts: Number(cacheLog?.[2] ?? 0) };
}

// the system font cache changes no pixels: uncached, recording and replaying render alike
async function expectFontCacheSamePixels(): Promise<void> {
  const path = tmpPath("pdfium/fontcache.pdf");
  writeFileSync(path, fontCacheFixture(), "latin1");
  const appdata = tmpPath("pdfium/fontcache-appdata");
  rmSync(appdata, { recursive: true, force: true });
  const off = await renderWithFontCache(path, "off", tmpPath("pdfium/fontcache-off"), "0");
  const cold = await renderWithFontCache(path, "cold", appdata, "1");
  const warm = await renderWithFontCache(path, "warm", appdata, "1");
  console.log(`font cache: off=${off.mode} cold=${cold.mode}/${cold.fonts} warm=${warm.mode}/${warm.fonts}`);
  if (off.mode !== "off" || cold.mode !== "recorded" || warm.mode !== "replayed") {
    throw new Error("Font cache did not record, then replay");
  }
  if (cold.hash !== off.hash || warm.hash !== off.hash) {
    throw new Error(`Font cache changed pixels: off=${off.hash} cold=${cold.hash} warm=${warm.hash}`);
  }
  console.log("PDFium font cache renders the same pixels");
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
  const autoPdf = tmpPath("pdfium/autolinks.pdf");
  writeFileSync(autoPdf, autoLinksFixture(), "latin1");
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
      if (!(await client.virtTree()).some((r) => r.text === " / 2")) throw new Error("Unlabeled page total changed");
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
      const autoLinks = linkValues(await request(client, ControlCommand.TestPageLinks, [autoPdf, 1]));
      if (autoLinks.join(" ") !== expectedAutoLinks.join(" ")) throw new Error(`Auto links: ${autoLinks}`);
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
  await expectOverwriteReload("small");
  await expectOverwriteReload("big");
  await expectPageLabels();
  await expectAutoLinksDisabled(autoPdf);
  await expectDestsMatchMupdf();
  await expectNamedLinkRects();
  await expectRemoteNamedDest("mupdf");
  await expectRemoteNamedDest("pdfium");
  await expectOpenAction();
  await expectPassword(pdf);
  await expectFontCacheSamePixels();
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
