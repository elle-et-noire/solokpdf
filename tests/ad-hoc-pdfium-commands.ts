import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

// Every command's menu and palette visibility, PDFium vs MuPDF, on the same PDFs.

const userPassword = "user-password";
const surfaces = ["menu", "palette"] as const;

// "<fixture>|<surface>|<command>" (fixture and surface may be "*") -> reason
const allowed: Record<string, string> = {
  "*|*|CmdToggleEngineeringDrawingEnhance": "CAD enhance is MuPDF rendering; hidden on PDFium (B5)",
};

const page =
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>";
const content = (() => {
  const s = "BT /F1 18 Tf 30 200 Td (Hello command visibility) Tj ET";
  return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
})();
const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

function fixtures(): Record<string, string> {
  return {
    plain: assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `${page} >>`,
      content,
      font,
    ]),
    outline: assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `${page} >>`,
      content,
      font,
      "<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>",
      "<< /Title (Start) /Parent 6 0 R /Dest [3 0 R /Fit] >>",
    ]),
    annots: assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `${page} /Annots [6 0 R 7 0 R] >>`,
      content,
      font,
      "<< /Type /Annot /Subtype /Text /Rect [20 20 40 40] /Contents (note) /T (author) >>",
      "<< /Type /Annot /Subtype /Highlight /Rect [28 195 200 220] /QuadPoints [28 220 200 220 28 195 200 195] /C [1 1 0] >>",
    ]),
    form: assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `${page} /Annots [6 0 R] >>`,
      content,
      font,
      "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [20 20 180 50] /P 3 0 R >>",
    ]),
  };
}

type Report = Map<string, string>; // "<surface> <command>" -> vis

async function visibility(path: string, appdata: string, engine: string, args: string[]): Promise<Report> {
  return withControlledSumatra(
    EXE,
    async (client) => {
      const deadline = Date.now() + 15_000;
      while ((await client.request(ControlCommand.TestCurrentPdf, ["pages"]))[0] !== 0) {
        if (Date.now() > deadline) throw new Error(`${engine}: ${path} did not open`);
        await Bun.sleep(100);
      }
      await client.waitForRenderIdle();
      const editor = async () => String((await client.request(ControlCommand.TestCurrentPdf, ["editor"]))[1]);
      const editorBefore = await editor();
      const report: Report = new Map();
      for (const surface of surfaces) {
        const res = await client.request(ControlCommand.TestAllCommandVisibility, [surface]);
        if (res[0] !== 0) throw new Error(`${engine}: ${String(res[1])}`);
        for (const line of String(res[1]).split("\n")) {
          const [cmd, vis] = line.trim().split(" ");
          if (cmd && vis) report.set(`${surface} ${cmd}`, vis);
        }
      }
      // computing visibility must not load the hidden MuPDF editor
      report.set("editor", `${editorBefore} -> ${await editor()}`);
      return report;
    },
    ["-appdata", appdata, ...args, path],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

function allowReason(fixture: string, surface: string, cmd: string): string | undefined {
  for (const f of [fixture, "*"]) {
    for (const s of [surface, "*"]) {
      const reason = allowed[`${f}|${s}|${cmd}`];
      if (reason) return reason;
    }
  }
  return undefined;
}

export async function testit(): Promise<void> {
  const dir = tmpPath("pdfium-commands");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const runs: [string, string, string[]][] = [];
  for (const [name, pdf] of Object.entries(fixtures())) {
    const path = join(dir, `${name}.pdf`);
    writeFileSync(path, pdf, "latin1");
    runs.push([name, path, []]);
  }
  const encrypted = join(dir, "encrypted.pdf");
  const clean = Bun.spawnSync([
    EXE,
    "clean",
    "-E",
    "aes-256",
    "-U",
    userPassword,
    "-O",
    "owner",
    join(dir, "plain.pdf"),
    encrypted,
  ]);
  if (clean.exitCode !== 0) throw new Error(`Cannot encrypt: ${clean.stderr.toString()}`);
  runs.push(["encrypted", encrypted, ["-pwd", userPassword]]);

  const problems: string[] = [];
  let compared = 0;
  for (const [name, path, args] of runs) {
    const reports: Report[] = [];
    for (const engine of ["pdfium", "mupdf"]) {
      const appdata = join(dir, `${name}-${engine}`);
      mkdirSync(appdata, { recursive: true });
      reports.push(await visibility(path, appdata, engine, args));
    }
    const [pdfium, mupdf] = reports;
    const editor = pdfium.get("editor") ?? "";
    // pages with annotations or fields may load the editor on their own (hover, B13/B47), which can
    // land inside the query window, so only documents without them must stay editor-free
    const mayLoadEditor = name === "annots" || name === "form";
    if (!mayLoadEditor && editor === "editor=none -> editor=loaded") {
      problems.push(`${name}: visibility loaded the editor`);
    }
    for (const [key, mupdfVis] of mupdf) {
      if (key === "editor") continue;
      const pdfiumVis = pdfium.get(key) ?? "missing";
      compared++;
      if (pdfiumVis === mupdfVis) continue;
      const [surface, cmd] = key.split(" ");
      if (allowReason(name, surface, cmd)) continue;
      problems.push(`${name} ${surface} ${cmd}: pdfium=${pdfiumVis} mupdf=${mupdfVis}`);
    }
  }
  if (compared < 500) throw new Error(`only ${compared} visibility states compared`);
  if (problems.length > 0) throw new Error(`command visibility differs:\n${problems.join("\n")}`);
}

if (import.meta.main) await runStandalone(testit);
