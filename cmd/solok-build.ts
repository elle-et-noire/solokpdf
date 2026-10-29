import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fetchPdfium } from "./solok-fetch-pdfium";
import { detectVisualStudio2026, runLogged } from "./util";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["-dbg", "-rel", "-quick"].includes(args[0]))) {
  throw new Error("usage: bun cmd/solok-build.ts [-dbg | -rel | -quick]");
}
const config = args[0] ?? "-dbg";
const pdfium = await fetchPdfium();
if (!existsSync(join(pdfium, "include/fpdfview.h"))) throw new Error("PDFium headers are missing");
// vs2022/ stays upstream's; the PDFium projects go to the ignored vs2026/
await runLogged(join("bin", "premake5.exe"), ["--with-pdfium", "vs2026"]);

// -quick: rebuild only the debug app for out/dbg64/SumatraPDF.exe (what tests run);
// skips the shell DLLs, the tool, the portable folder and the ZIP
if (config === "-quick") {
  const { msbuildPath } = detectVisualStudio2026();
  const sln = join("vs2026", "SumatraPDF.slnx");
  await runLogged(msbuildPath, [sln, "/t:SumatraPDF", "/p:Configuration=Debug;Platform=x64", "/m"]);
  copyFileSync(join(pdfium, "bin/pdfium.dll"), join("out", "dbg64", "pdfium.dll"));
  console.log("SolokPDF quick build: out/dbg64/SumatraPDF.exe");
  process.exit(0);
}
console.log(`> bun cmd/build.ts ${config}`);
const build = Bun.spawn([process.execPath, "cmd/build.ts", config], {
  env: { ...process.env, SUMATRA_SLN: join("vs2026", "SumatraPDF.slnx") },
  stdio: ["inherit", "inherit", "inherit"],
});
if ((await build.exited) !== 0) throw new Error("cmd/build.ts failed");
const out = join("out", config === "-rel" ? "rel64" : "dbg64");
copyFileSync(join(pdfium, "bin/pdfium.dll"), join(out, "pdfium.dll"));
const portable = join("out", config === "-rel" ? "solokpdf-portable" : "solokpdf-dev");
const zip = join("out", config === "-rel" ? "SolokPDF-experimental-x64.zip" : "SolokPDF-experimental-debug-x64.zip");
mkdirSync(portable, { recursive: true });

// paths relative to the portable folder; the ZIP holds exactly these
const packaged: string[] = [];
function copyIn(source: string, dest: string): void {
  const target = join(portable, dest);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  packaged.push(dest);
}

// the PDB stays next to the exe for debugging but is too big to ship
if (existsSync(join(out, "SumatraPDF.pdb"))) copyFileSync(join(out, "SumatraPDF.pdb"), join(portable, "SolokPDF.pdb"));
for (const name of ["SumatraPDF.exe", "libsumatrapdf.dll", "sumatrapdf-tool.exe", "pdfium.dll"]) {
  const source = join(out, name);
  if (!existsSync(source)) continue;
  copyIn(source, name.replace("SumatraPDF", "SolokPDF"));
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
  if (existsSync(name)) copyIn(name, name);
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
      copyIn(path, join("licenses/upstream", path));
    }
  }
}
copyNotices("ext");
copyIn(join(pdfium, "LICENSE"), "licenses/pdfium/LICENSE");
for (const entry of readdirSync(join(pdfium, "licenses"), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  copyIn(path, join("licenses/pdfium", relative(join(pdfium, "licenses"), path)));
}
copyIn(join(pdfium, "solok-pin.json"), "licenses/pdfium/solok-pin.json");
writeFileSync(
  join(portable, "README-DEV.txt"),
  "SolokPDF experimental portable build, derived from SumatraPDF.\nPDFium is the default PDF backend. Set SOLOKPDF_ENGINE=mupdf for comparison.\nSee docs/solokpdf-progress.md in the source checkout for limitations and tests.\nUpstream binary updates are disabled. Installer/associations are unvalidated.\n",
);
packaged.push("README-DEV.txt");

// Windows' bsdtar writes ZIPs; Git's GNU tar can't
const list = join("out", "solokpdf-zip-files.txt");
writeFileSync(list, packaged.map((p) => p.replaceAll("\\", "/")).join("\n") + "\n");
const tmpZip = `${zip}.new`;
rmSync(tmpZip, { force: true });
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
await runLogged(tar, ["--format", "zip", "-c", "-f", resolve(tmpZip), "-C", portable, "-T", resolve(list)]);
renameSync(tmpZip, zip);
rmSync(list);

console.log(`SolokPDF development build: ${portable}/SolokPDF.exe. Use -for-testing for ad-hoc launches.`);
console.log(`Portable ZIP: ${zip} (${packaged.length} files)`);
