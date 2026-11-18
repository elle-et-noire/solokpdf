import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getGitSha1, runLogged } from "../util";

function collectNotices(dir: string, files: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectNotices(path, files);
    } else if (
      /^(copying|licen[sc]e|copyright|notice)([._-\d].*)?$/i.test(entry.name) ||
      entry.name === "FTL.TXT" ||
      entry.name === "lzma.txt"
    ) {
      files.set(join("licenses/upstream", path), path);
    }
  }
}

async function portableReadme(): Promise<string> {
  const revision = existsSync(".git") ? await getGitSha1() : "";
  const repo = "https://github.com/elle-et-noire/solokpdf";
  const source = revision ? `${repo}/tree/${revision}` : repo;
  const docs = `${repo}/blob/${revision || "solokpdf-dev"}/docs/solokpdf`;
  return `SolokPDF experimental portable build for Windows x64

Extract the entire ZIP to a writable folder, then run SolokPDF.exe.
Press Ctrl+O to open a document. Keep the extracted DLLs beside SolokPDF.exe.
Outside Program Files, portable settings are saved in the same folder as
SolokPDF-settings.txt.

PDFs use PDFium by default and fall back to MuPDF when PDFium cannot open them.
XFA editing and GoToE links are unsupported. Upstream binary updates are disabled.
Installer behavior is unvalidated.

AUTHORS, COPYING, COPYING.BSD and licenses/ contain license notices.

Source code
  ${source}
Limitations
  ${docs}/limitations.md
Developer tests
  ${docs}/testing.md
`;
}

export async function packageSolokPdf(out: string, pdfium: string, portable: string, zip: string): Promise<void> {
  const pdfiumLicenses = join(pdfium, "licenses");
  const files = new Map<string, string>([
    ["SolokPDF.exe", join(out, "SumatraPDF.exe")],
    ["libsumatrapdf.dll", join(out, "libsumatrapdf.dll")],
    ["sumatrapdf-tool.exe", join(out, "sumatrapdf-tool.exe")],
    ["pdfium.dll", join(out, "pdfium.dll")],
    ["AUTHORS", "AUTHORS"],
    ["COPYING", "COPYING"],
    ["COPYING.BSD", "COPYING.BSD"],
    [join("licenses/upstream/ext/mupdf/COPYING"), "ext/mupdf/COPYING"],
    [join("licenses/pdfium/LICENSE"), join(pdfium, "LICENSE")],
    [join("licenses/pdfium/pdfium.txt"), join(pdfiumLicenses, "pdfium.txt")],
    [join("licenses/pdfium/solok-pin.json"), join(pdfium, "solok-pin.json")],
  ]);
  for (const source of files.values()) {
    const file = statSync(source, { throwIfNoEntry: false });
    if (!file?.isFile() || file.size === 0) throw new Error(`Required portable file is missing or empty: ${source}`);
  }

  if (existsSync("COPYING.AGPL")) files.set("COPYING.AGPL", "COPYING.AGPL");
  collectNotices("ext", files);
  for (const entry of readdirSync(pdfiumLicenses, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(join("licenses/pdfium", relative(pdfiumLicenses, path)), path);
  }

  const readme = await portableReadme();
  mkdirSync(portable, { recursive: true });
  for (const [dest, source] of files) {
    const target = join(portable, dest);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  // Keep symbols in the loose build for debugging.
  const pdb = join(out, "SumatraPDF.pdb");
  if (existsSync(pdb)) copyFileSync(pdb, join(portable, "SolokPDF.pdb"));
  writeFileSync(join(portable, "README.txt"), readme);
  const entries = [...files.keys(), "README.txt"].map((path) => path.replaceAll("\\", "/"));

  // Windows' bsdtar writes ZIPs. Git's GNU tar can't.
  const work = mkdtempSync(join(dirname(resolve(zip)), ".solok-portable-"));
  try {
    const list = join(work, "files.txt");
    writeFileSync(list, entries.join("\n") + "\n");
    const tmpZip = join(work, "portable.zip");
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await runLogged(tar, ["--format", "zip", "-c", "-f", tmpZip, "-C", portable, "-T", list]);
    renameSync(tmpZip, zip);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Portable ZIP: ${zip} (${entries.length} files)`);
}
