import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { EXE, runStandalone, tmpPath } from "./util.ts";

const dir = join(import.meta.dir, "ad-hoc-pdfium-synctex-data");
const pdf = join(dir, "main.pdf");
const src = join(dir, "main.tex");

type Match = { page: number; rect: number[]; line: number };

async function check(engine: "mupdf" | "pdfium"): Promise<Match[]> {
  const appdata = tmpPath(`pdfium-synctex-${engine}`);
  return withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const sync = await client.request(ControlCommand.TestCurrentPdf, ["sync"]);
      if (sync[0] !== 0 || sync[1] !== "sync=loaded") throw new Error(`${engine}: ${sync[1]}`);
      if (engine === "pdfium") {
        const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
        if (editor[0] !== 0 || editor[1] !== "editor=none") throw new Error(`${engine}: ${editor[1]}`);
      }

      const tab = await client.request(ControlCommand.TestCurrentTab);
      if (!/page=2\b/.test(String(tab[1]))) throw new Error(`${engine}: forward search: ${tab[1]}`);

      const matches: Match[] = [];
      for (const line of [3, 5]) {
        const forward = String((await client.request(ControlCommand.TestSynctex, [pdf, src, line]))[1]);
        const m =
          /ret=0 page=(\d+) nrects=([1-9]\d*) .*rect_x=(-?\d+) rect_y=(-?\d+) rect_dx=(-?\d+) rect_dy=(-?\d+)/.exec(
            forward,
          );
        if (!m) throw new Error(`${engine}: forward line ${line}: ${forward}`);
        const page = Number(m[1]);
        const rect = m.slice(3, 7).map(Number);
        const inverse = String(
          (await client.request(ControlCommand.TestInverseSearch, [pdf, page, rect[0]! + 1, rect[1]! + 1]))[1],
        );
        if (!inverse.includes(`srcfile=${src}`) || !inverse.includes(`line=${line}`)) {
          throw new Error(`${engine}: inverse line ${line}: ${inverse}`);
        }
        matches.push({ page, rect, line });
      }
      return matches;
    },
    ["-appdata", appdata, "-forward-search", src, "5", pdf],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  const mupdf = await check("mupdf");
  const pdfium = await check("pdfium");
  if (JSON.stringify(mupdf) !== JSON.stringify(pdfium)) {
    throw new Error(`SyncTeX geometry differs: MuPDF ${JSON.stringify(mupdf)}, PDFium ${JSON.stringify(pdfium)}`);
  }
  console.log(`SyncTeX matches on both engines: ${JSON.stringify(pdfium)}`);
}

if (import.meta.main) await runStandalone(testit);
