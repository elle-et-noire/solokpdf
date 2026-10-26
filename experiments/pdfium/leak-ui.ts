// Leak check for what PDFium documents allocate per open, render and link query: form widgets
// (form handle, per-page form views), Named/GoToR links (MuPDF queries), rotated-text quads.
// One Release process repeats rounds until --minutes elapse: open the inputs in tabs, zoom and
// page through each, select text, read links and search, close all tabs. Counters are sampled
// after each close; the report fits their growth per round after a warm-up.
// Usage: bun experiments/pdfium/leak-ui.ts [--exe path] [--minutes 40] [--output dir] [pdf...]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { assemblePdf, cmdId } from "../../tests/util.ts";
import { sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import { processGuiResources, processMemory, sendCopyDataW, setProcessDpiAware } from "../../tests/winapi.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    exe: { type: "string", default: "out/solokpdf-portable/SolokPDF.exe" },
    minutes: { type: "string", default: "40" },
    output: { type: "string", default: "out/solok-leak" },
  },
});
const minutes = Number(values.minutes);
const out = resolve(values.output);
mkdirSync(out, { recursive: true });
setProcessDpiAware();

const kCopyDataDdeW = 0x44646557;
const kSettleMs = 500;
// rounds before the fit: caches (fonts, thumbnails, history) fill during the first opens
const kWarmupRounds = 5;
const kZoomSteps = ["CmdZoom200", "CmdZoom400", "CmdZoom800", "CmdZoomFitWidth", "CmdZoom100"];

const xobject = (bbox: string, s: string) =>
  `<< /Type /XObject /Subtype /Form /BBox ${bbox} /Length ${s.length} >>\nstream\n${s}\nendstream`;
const content = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;

// three pages of fields: text with and without an appearance, checkboxes, a combo box
function formPdf(): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /NeedAppearances true /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 3 0 R >> >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    xobject("[0 0 18 18]", "0 G 1 w 0.5 0.5 17 17 re S 4 9 m 8 4 l 14 14 l S"),
    xobject("[0 0 18 18]", "0 G 1 w 0.5 0.5 17 17 re S"),
    xobject("[0 0 200 20]", "0 0 0 rg BT /Helv 12 Tf 2 5 Td (with appearance) Tj ET"),
  ];
  const kids: string[] = [];
  const fields: string[] = [];
  for (let p = 0; p < 3; p++) {
    const pageNo = objs.length + 1;
    const annots: string[] = [];
    const label = `BT /F1 12 Tf 40 740 Td (Form page ${p + 1}) Tj ET`;
    objs.push("");
    objs.push(content(label));
    for (let i = 0; i < 8; i++) {
      const y = 680 - i * 70;
      const n = objs.length + 1;
      const common = `/P ${pageNo} 0 R /F 4 /T (f${p}_${i})`;
      if (i % 4 === 0)
        objs.push(
          `<< /Type /Annot /Subtype /Widget /FT /Tx ${common} /V (value ${p} ${i}) /DA (/Helv 12 Tf 0 g) /Rect [100 ${y} 400 ${y + 22}] /MK << /BC [0 0 0] >> >>`,
        );
      else if (i % 4 === 1)
        objs.push(
          `<< /Type /Annot /Subtype /Widget /FT /Btn ${common} /V /Yes /AS /Yes /Rect [100 ${y} 118 ${y + 18}] /MK << /CA (4) >> /AP << /N << /Yes 4 0 R /Off 5 0 R >> >> >>`,
        );
      else if (i % 4 === 2)
        objs.push(
          `<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 ${common} /Opt [(A) (B)] /V (A) /DA (/Helv 12 Tf 0 g) /Rect [100 ${y} 300 ${y + 22}] /MK << /BC [0 0 0] >> >>`,
        );
      else
        objs.push(
          `<< /Type /Annot /Subtype /Widget /FT /Tx ${common} /V (ap) /Rect [100 ${y} 300 ${y + 20}] /AP << /N 6 0 R >> >>`,
        );
      annots.push(`${n} 0 R`);
      fields.push(`${n} 0 R`);
    }
    objs[pageNo - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNo + 1} 0 R /Annots [${annots.join(" ")}] >>`;
    kids.push(`${pageNo} 0 R`);
  }
  objs[0] = objs[0]!.replace("/Fields []", `/Fields [${fields.join(" ")}]`);
  objs[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(" ")}] >>`;
  return assemblePdf(objs);
}

// three pages with Named and GoToR links and 45-degree text
function linksPdf(): string {
  const text = (p: number) =>
    `BT /F1 14 Tf 60 700 Td (Links page ${p}) Tj ET BT /F1 18 Tf 0.7071 0.7071 -0.7071 0.7071 200 300 Tm (ROTATED TEXT ${p}) Tj ET`;
  const link = (y: number, a: string) =>
    `<< /Type /Annot /Subtype /Link /Rect [60 ${y} 260 ${y + 20}] /Border [0 0 0] /A ${a} >>`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 3 /Kids [3 0 R 8 0 R 13 0 R] >>"];
  for (let p = 1; p <= 3; p++) {
    const n = objs.length + 1;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 18 0 R >> >> /Contents ${n + 1} 0 R /Annots [${n + 2} 0 R ${n + 3} 0 R ${n + 4} 0 R] >>`,
    );
    objs.push(content(text(p)));
    objs.push(link(600, "<< /S /Named /N /NextPage >>"));
    objs.push(link(560, "<< /S /Named /N /PrevPage >>"));
    objs.push(link(520, "<< /S /GoToR /F (other.pdf) /D (chapter) >>"));
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  return assemblePdf(objs);
}

const inputs = [join(out, "form.pdf"), join(out, "links.pdf"), ...positionals.map((p) => resolve(p))];
writeFileSync(inputs[0]!, formPdf(), "latin1");
writeFileSync(inputs[1]!, linksPdf(), "latin1");

type Sample = {
  round: number;
  ms: number;
  privateBytes: number;
  workingSet: number;
  handles: number;
  gdi: number;
  user: number;
};
const samples: Sample[] = [];

// least-squares growth per round
function slope(ys: number[]): number {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, i) => {
    num += (i - mx) * (y - my);
    den += (i - mx) * (i - mx);
  });
  return den > 0 ? num / den : 0;
}

const save = (status: string) => {
  const fit = samples.slice(kWarmupRounds);
  const report =
    fit.length >= 3
      ? {
          rounds: fit.length,
          privateBytesPerRound: slope(fit.map((s) => s.privateBytes)),
          workingSetPerRound: slope(fit.map((s) => s.workingSet)),
          handlesPerRound: slope(fit.map((s) => s.handles)),
          gdiPerRound: slope(fit.map((s) => s.gdi)),
          userPerRound: slope(fit.map((s) => s.user)),
        }
      : null;
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify({ status, exe: values.exe, inputs, minutes, report, samples }, null, 2) + "\n",
  );
  return report;
};

const settings = join(out, "settings");
mkdirSync(settings, { recursive: true });
writeFileSync(
  join(settings, "SolokPDF-settings.txt"),
  "UiLanguage = en\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\nCheckForUpdates = false\n",
);

await withControlledSumatra(
  resolve(values.exe),
  async (client, proc) => {
    await client.setNotificationsEnabled(false);
    const frame = await waitForFrame(proc.pid!);
    const start = performance.now();
    for (let round = 1; performance.now() - start < minutes * 60000; round++) {
      for (const input of inputs) {
        if (!sendCopyDataW(frame, kCopyDataDdeW, `[Open("${input}",0,1,0)]`)) throw new Error("DDE open failed");
        await client.waitForRenderIdle(30000);
        for (const cmd of kZoomSteps) {
          sendCommandSync(frame, cmdId(cmd));
          await client.waitForRenderIdle(30000);
        }
        for (let i = 0; i < 3; i++) {
          sendCommandSync(frame, cmdId("CmdGoToNextPage"));
          await client.waitForRenderIdle(30000);
        }
        await client.request(ControlCommand.TestSeedTextSelection, [1]);
        await client.request(ControlCommand.TestPageLinks, [input, 1]);
        await client.request(ControlCommand.TestSearch, [input, "e"]);
      }
      sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
      await Bun.sleep(kSettleMs);
      const m = processMemory(proc.pid!);
      const r = processGuiResources(proc.pid!);
      samples.push({
        round,
        ms: performance.now() - start,
        privateBytes: m.privateBytes,
        workingSet: m.workingSetBytes,
        handles: r.handles,
        gdi: r.gdi,
        user: r.user,
      });
      save("running");
      if (round % 10 === 0) {
        const mib = (m.privateBytes / 1048576).toFixed(1);
        console.log(`round ${round}: private ${mib} MiB, handles ${r.handles}, gdi ${r.gdi}, user ${r.user}`);
      }
    }
  },
  ["-appdata", settings, "-window-pos", "900x1000@0x0", "-log-to-file", join(out, "log.txt")],
  { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" }, connectTimeoutMs: 30000 },
);
const report = save("completed");
console.log(JSON.stringify(report));
