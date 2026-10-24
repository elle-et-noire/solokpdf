import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// GitHub release asset digest, not a hash obtained from the downloaded archive.
export const pdfiumPin = {
  tag: "chromium/8111",
  version: "158.0.8111.0",
  url: "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8111/pdfium-win-x64.tgz",
  sha256: "3452d11031050ec65e57f180215b57b9e6d465e3fbedafa8a77ad90885c7d23e",
};

export async function fetchPdfium(): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This experiment requires native Windows x64.");
  }
  const dir = resolve(".work/pdfium");
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "pdfium-win-x64.tgz");
  let bytes: Uint8Array;
  if (existsSync(archive)) {
    bytes = readFileSync(archive);
  } else {
    const response = await fetch(pdfiumPin.url);
    if (!response.ok) throw new Error(`PDFium download failed: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== pdfiumPin.sha256) throw new Error(`PDFium SHA-256 mismatch: ${digest}`);
  writeFileSync(archive, bytes);
  const unpack = Bun.spawnSync(["tar.exe", "-xzf", archive, "-C", dir], { stdout: "inherit", stderr: "inherit" });
  if (unpack.exitCode !== 0) throw new Error("PDFium archive extraction failed");
  for (const file of ["include/fpdfview.h", "bin/pdfium.dll"]) {
    if (!existsSync(join(dir, file))) throw new Error(`PDFium archive is missing ${file}`);
  }
  writeFileSync(join(dir, "solok-pin.json"), JSON.stringify(pdfiumPin, null, 2) + "\n");
  console.log(`Verified ${pdfiumPin.version}, no V8: ${digest}`);
  return dir;
}

if (import.meta.main) await fetchPdfium();
