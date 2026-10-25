import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPdfium } from "./solok-fetch-pdfium";
import { runLogged } from "./util";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["-dbg", "-rel"].includes(args[0]))) {
  throw new Error("usage: bun cmd/solok-build.ts [-dbg | -rel]");
}
const config = args[0] ?? "-dbg";
const pdfium = await fetchPdfium();
if (!existsSync(join(pdfium, "include/fpdfview.h"))) throw new Error("PDFium headers are missing");
await runLogged(join("bin", "premake5.exe"), ["--with-pdfium", "vs2022"]);
await runLogged(process.execPath, ["cmd/build.ts", config]);
const out = join("out", config === "-rel" ? "rel64" : "dbg64");
copyFileSync(join(pdfium, "bin/pdfium.dll"), join(out, "pdfium.dll"));
const portable = join("out", config === "-rel" ? "solokpdf-portable" : "solokpdf-dev");
mkdirSync(portable, { recursive: true });
for (const name of ["SumatraPDF.exe", "SumatraPDF.pdb", "libsumatrapdf.dll", "sumatrapdf-tool.exe", "pdfium.dll"]) {
  const source = join(out, name);
  if (!existsSync(source)) continue;
  const dest = name.replace("SumatraPDF", "SolokPDF");
  copyFileSync(source, join(portable, dest));
}
for (const name of [
  "AUTHORS",
  "COPYING",
  "COPYING.BSD",
  "COPYING.AGPL",
  "readme.md",
  "docs/solokpdf-progress.md",
  "docs/solokpdf-benchmark-2026-10-24.json",
  "docs/solokpdf-benchmark-release-2026-10-25.json",
  "docs/solokpdf-benchmark-lazy-dest-2026-10-25.json",
  "docs/solokpdf-profile-2026-10-25.json",
  "docs/solokpdf-memory-2026-10-26.json",
]) {
  if (existsSync(name)) {
    mkdirSync(join(portable, name, ".."), { recursive: true });
    copyFileSync(name, join(portable, name));
  }
}
function copyNotices(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      copyNotices(path);
    } else if (
      /^(copying|licen[sc]e|copyright|notice)([._\-\d].*)?$/i.test(entry.name) ||
      entry.name === "FTL.TXT" ||
      entry.name === "lzma.txt"
    ) {
      const target = join(portable, "licenses/upstream", path);
      mkdirSync(join(target, ".."), { recursive: true });
      copyFileSync(path, target);
    }
  }
}
copyNotices("ext");
const notices = join(portable, "licenses/pdfium");
mkdirSync(notices, { recursive: true });
copyFileSync(join(pdfium, "LICENSE"), join(notices, "LICENSE"));
cpSync(join(pdfium, "licenses"), notices, { recursive: true });
copyFileSync(join(pdfium, "solok-pin.json"), join(notices, "solok-pin.json"));
writeFileSync(
  join(portable, "README-DEV.txt"),
  "SolokPDF experimental portable build, derived from SumatraPDF.\nPDFium is the default PDF backend. Set SOLOKPDF_ENGINE=mupdf for comparison.\nSee docs/solokpdf-progress.md in the source checkout for limitations and tests.\nUpstream binary updates are disabled. Installer/associations are unvalidated.\n",
);
console.log(`SolokPDF development build: ${portable}/SolokPDF.exe. Use -for-testing for ad-hoc launches.`);
