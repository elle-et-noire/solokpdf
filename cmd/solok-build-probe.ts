import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectVisualStudio, runLogged } from "./util";
import { fetchPdfium } from "./solok-fetch-pdfium";

const pdfium = await fetchPdfium();
const { vsRoot } = detectVisualStudio();
const versions = readdirSync(join(vsRoot, "VC/Tools/MSVC")).sort().reverse();
const compilerDir = join(vsRoot, "VC/Tools/MSVC", versions[0], "bin/Hostx64/x64");
const sdkRoot = String.raw`C:\Program Files (x86)\Windows Kits\10`;
const sdkVersions = readdirSync(join(sdkRoot, "Include"))
  .filter((v) => existsSync(join(sdkRoot, "Lib", v, "um/x64")))
  .sort()
  .reverse();
const sdk = sdkVersions[0];
if (!sdk) throw new Error("No Windows SDK with x64 libraries found");
const out = resolve("out/pdfium-probe");
mkdirSync(out, { recursive: true });
const toolRoot = join(vsRoot, "VC/Tools/MSVC", versions[0]);
process.env.PATH = compilerDir + ";" + process.env.PATH;
process.env.INCLUDE = [
  join(toolRoot, "include"),
  ...["ucrt", "shared", "um", "winrt"].map((d) => join(sdkRoot, "Include", sdk, d)),
].join(";");
process.env.LIB = [join(toolRoot, "lib/x64"), ...["ucrt", "um"].map((d) => join(sdkRoot, "Lib", sdk, d, "x64"))].join(
  ";",
);
await runLogged(join(compilerDir, "cl.exe"), [
  "/nologo",
  "/std:c++17",
  "/W4",
  "/WX",
  "/O2",
  "/MT",
  "/EHsc",
  "/utf-8",
  "/I" + join(toolRoot, "include"),
  ...["ucrt", "shared", "um", "winrt"].map((d) => "/I" + join(sdkRoot, "Include", sdk, d)),
  "/I" + join(pdfium, "include"),
  resolve("experiments/pdfium/render.cpp"),
  "/Fo" + join(out, "render.obj"),
  "/Fe" + join(out, "pdfium-render.exe"),
  "/link",
  "/LIBPATH:" + join(toolRoot, "lib/x64"),
  ...["ucrt", "um"].map((d) => "/LIBPATH:" + join(sdkRoot, "Lib", sdk, d, "x64")),
  "ole32.lib",
  "windowscodecs.lib",
  "psapi.lib",
  "gdi32.lib",
  "user32.lib",
]);
await runLogged(join(compilerDir, "cl.exe"), [
  "/nologo",
  "/std:c++17",
  "/W4",
  "/WX",
  "/O2",
  "/MT",
  "/EHsc",
  "/utf-8",
  "/I" + join(toolRoot, "include"),
  ...["ucrt", "shared", "um", "winrt"].map((d) => "/I" + join(sdkRoot, "Include", sdk, d)),
  "/I" + join(pdfium, "include"),
  resolve("experiments/pdfium/multi-alloc.cpp"),
  "/Fo" + join(out, "multi-alloc.obj"),
  "/Fe" + join(out, "pdfium-multi-alloc.exe"),
  "/link",
  "/LIBPATH:" + join(toolRoot, "lib/x64"),
  ...["ucrt", "um"].map((d) => "/LIBPATH:" + join(sdkRoot, "Lib", sdk, d, "x64")),
  "psapi.lib",
]);
copyFileSync(join(pdfium, "bin/pdfium.dll"), join(out, "pdfium.dll"));
console.log(join(out, "pdfium-render.exe"));
