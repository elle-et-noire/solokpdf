// Opt-in PDFium check: a restored session tab and a reopened history file keep
// their page, zoom and scroll position, as with MuPDF. Build with solok-build.ts, then use --no-build.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

const kPages = 12;

// pages alternate letter / landscape A5 so a scroll position depends on page geometry
function makePdf(): string {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids: string[] = [];
  for (let i = 0; i < kPages; i++) kids.push(`${4 + i * 2} 0 R`);
  objs.push(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kPages} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < kPages; i++) {
    const box = i % 2 === 0 ? "[0 0 612 792]" : "[0 0 595 420]";
    const text = `BT /F1 24 Tf 72 300 Td (Page ${i + 1}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  return assemblePdf(objs);
}

type View = { mode: string; page: string; zoom: string; scroll: string };
const kWant: View = { mode: "continuous", page: "7", zoom: "175", scroll: "37 211" };

function viewLines(v: View): string {
  return `DisplayMode = ${v.mode}\n        PageNo = ${v.page}\n        Zoom = ${v.zoom}\n        Rotation = 0\n        ScrollPos = ${v.scroll}`;
}

// The session tab and the history entry are the only record of how the file was viewed.
function seedSettings(path: string, pdf: string, where: "session" | "history"): void {
  const head = `UiLanguage = en
CheckForUpdates = false
RestoreSession = ${where === "session"}
RememberOpenedFiles = true
RememberStatePerDocument = true
LazyLoading = false
ReuseInstance = false
UseTabs = true
ShowStartPage = false
`;
  const session = `SessionData [
  [
    TabStates [
      [
        FilePath = ${pdf}
        ${viewLines(kWant)}
        ShowToc = false
      ]
    ]
    TabIndex = 1
    WindowState = 1
    WindowPos = 100 100 900 700
  ]
]
`;
  const history = `FileStates [
  [
    FilePath = ${pdf}
    ${viewLines(kWant).replaceAll("\n        ", "\n    ")}
    ShowToc = false
    UseDefaultState = false
  ]
]
`;
  writeFileSync(path, head + (where === "session" ? session : history));
}

function savedView(text: string, where: "session" | "history"): View {
  const section = where === "session" ? /TabStates \[([\s\S]*?)\]\s*\]/ : /FileStates \[([\s\S]*?)\]\s*\]/;
  const body = section.exec(text)?.[1] ?? "";
  const get = (key: string) => new RegExp(`^\\s*${key} = ([^\\r\\n]+)`, "m").exec(body)?.[1]?.trim() ?? "?";
  return { mode: get("DisplayMode"), page: get("PageNo"), zoom: get("Zoom"), scroll: get("ScrollPos") };
}

async function roundTrip(engine: string, where: "session" | "history"): Promise<View> {
  const dir = tmpPath(`pdfium-view-state/${engine}-${where}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "pages.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const settings = join(dir, "SolokPDF-settings.txt");
  seedSettings(settings, pdf, where);

  const log = join(dir, "log.txt");
  const args = ["-appdata", dir, "-log-to-file", log, ...(where === "history" ? [pdf] : [])];
  const { proc, client } = await launchControlled(args, { saveSettings: true, env: { SOLOKPDF_ENGINE: engine } });
  try {
    if (where === "session") await client.waitForSessionRestored(30000);
    await client.waitForRenderIdle(30000);
    await client.quit();
  } catch (e) {
    await killAndWait(proc);
    throw e;
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${engine}/${where}: exit code ${exitCode}`);

  const opened = readFileSync(log, "utf8").includes("PDFium 158.0.8111.0: opened");
  if (opened !== (engine === "pdfium")) throw new Error(`${engine}/${where}: wrong engine, see ${log}`);
  return savedView(readFileSync(settings, "utf8"), where);
}

// The scroll position goes through device pixels, so it may come back a fraction of a point off.
const kMaxScrollDrift = 0.5;

function sameView(got: View, want: View): boolean {
  const a = got.scroll.split(" ").map(Number);
  const b = want.scroll.split(" ").map(Number);
  const scrollOk = a.length === 2 && a.every((v, i) => Math.abs(v - b[i]!) <= kMaxScrollDrift);
  return got.mode === want.mode && got.page === want.page && got.zoom === want.zoom && scrollOk;
}

export async function testit(): Promise<void> {
  const failures: string[] = [];
  for (const where of ["session", "history"] as const) {
    const views: Record<string, View> = {};
    for (const engine of ["pdfium", "mupdf"]) {
      const got = await roundTrip(engine, where);
      views[engine] = got;
      const line = `${engine}/${where}: ${got.mode} / page ${got.page} / zoom ${got.zoom} / scroll ${got.scroll}`;
      console.log(line);
      if (!sameView(got, kWant)) failures.push(line);
    }
    if (JSON.stringify(views.pdfium) !== JSON.stringify(views.mupdf))
      failures.push(`${where}: PDFium differs from MuPDF`);
  }
  if (failures.length > 0) {
    const want = `${kWant.mode} / page ${kWant.page} / zoom ${kWant.zoom} / scroll ${kWant.scroll}`;
    throw new Error(`view state not kept (want ${want}):\n${failures.join("\n")}`);
  }
}

if (import.meta.main) await runStandalone(testit);
