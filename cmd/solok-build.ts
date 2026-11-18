import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { packageSolokPdf } from "./helper/solok-portable";
import { fetchPdfium } from "./solok-fetch-pdfium";
import { detectVisualStudio2026, runLogged } from "./util";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["-dbg", "-rel", "-quick", "-asan"].includes(args[0]))) {
  throw new Error("usage: bun cmd/solok-build.ts [-dbg | -rel | -quick | -asan]");
}
const config = args[0] ?? "-dbg";
if (config === "-asan") {
  const { fetchAsanTools } = await import("./solok-fetch-asan");
  process.env.SUMATRA_ASAN_TOOLS = await fetchAsanTools();
}
const pdfium = await fetchPdfium();
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
const out = join("out", config === "-asan" ? "dbg64_asan" : config === "-rel" ? "rel64" : "dbg64");
copyFileSync(join(pdfium, "bin/pdfium.dll"), join(out, "pdfium.dll"));
if (config === "-asan") {
  console.log(`SolokPDF ASan build: ${out}/SumatraPDF-static.exe. Use -for-testing for ad-hoc launches.`);
  process.exit(0);
}

const portable = join("out", config === "-rel" ? "solokpdf-portable" : "solokpdf-dev");
const zip = join("out", config === "-rel" ? "SolokPDF-experimental-x64.zip" : "SolokPDF-experimental-debug-x64.zip");
await packageSolokPdf(out, pdfium, portable, zip);
console.log(`SolokPDF development build: ${portable}/SolokPDF.exe. Use -for-testing for ad-hoc launches.`);
