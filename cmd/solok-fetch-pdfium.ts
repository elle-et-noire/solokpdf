import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import pin from "./solok-pdfium-pin.json";

const asset = "pdfium-win-x64.tgz";
const manifest = "solok-pin.json";
const dll = "bin/pdfium.dll";
const headers = "include/fpdfview.h";
const versionHeader = "include/solok_pdfium_version.h";
const publishTimeoutMs = 4000;
const publishRetryMs = 50;
export const pdfiumPin = {
  ...pin,
  url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${pin.tag}/${asset}`,
};
export const pdfiumOpenLog = `PDFium ${pdfiumPin.version}: opened`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCached(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

async function pdfiumArchive(legacy: string, pin: typeof pdfiumPin): Promise<Buffer> {
  // Migrate a matching flat cache without changing it or requiring the network.
  const previous = readCached(legacy);
  if (previous && sha256(previous) === pin.sha256) return previous;
  const response = await fetch(pin.url);
  if (!response.ok) throw new Error(`PDFium download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== pin.sha256) throw new Error(`PDFium SHA-256 mismatch: ${digest}`);
  return bytes;
}

async function publishFile(source: string, target: string, bytes: Buffer): Promise<void> {
  const deadline = performance.now() + publishTimeoutMs;
  while (true) {
    try {
      // Another repair may have published the same pinned bytes while we waited.
      if (readCached(target)?.equals(bytes)) return;
      renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const sharingError = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!sharingError || performance.now() >= deadline) throw error;
    }
    await Bun.sleep(publishRetryMs);
  }
}

function packageFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

async function publishPackage(staging: string, dir: string): Promise<void> {
  try {
    renameSync(staging, dir);
    return;
  } catch (error) {
    if (!existsSync(dir)) throw error;
  }
  // Repair only changed files so unchanged headers retain their timestamps.
  // Parallel repairs publish the same verified bytes one file at a time.
  const files = new Set(packageFiles(staging));
  for (const file of files) {
    const source = join(staging, file);
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    await publishFile(source, target, readFileSync(source));
  }
  for (const file of packageFiles(dir)) {
    if (!files.has(file)) rmSync(join(dir, file), { force: true });
  }
}

export async function fetchPdfium({
  cacheDir = resolve(import.meta.dir, "../.work/pdfium"),
  pin = pdfiumPin,
} = {}): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The pinned PDFium package requires native Windows x64.");
  }
  // Keep this location in sync with engines_files() in premake5.files.lua.
  const dir = join(cacheDir, `${pin.tag.replaceAll("/", "-")}-${pin.version}-${pin.sha256}`);
  const archive = join(cacheDir, `${pin.sha256}-${asset}`);
  const cached = readCached(archive);
  const verified = cached && sha256(cached) === pin.sha256;
  const bytes = verified ? cached : await pdfiumArchive(join(cacheDir, asset), pin);
  mkdirSync(cacheDir, { recursive: true });
  const work = mkdtempSync(join(cacheDir, ".extract-"));
  try {
    if (!verified) {
      // Retain the verified archive even if extraction is interrupted.
      const incoming = join(work, asset);
      writeFileSync(incoming, bytes);
      await publishFile(incoming, archive, bytes);
    }
    const staging = join(work, "package");
    mkdirSync(staging);
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const unpack = Bun.spawn([tar, "-xzf", "-", "-C", staging], {
      stdin: bytes,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await unpack.exited) !== 0) throw new Error("PDFium archive extraction failed");
    for (const file of [headers, dll]) {
      if (!existsSync(join(staging, file))) throw new Error(`PDFium archive is missing ${file}`);
    }
    writeFileSync(join(staging, versionHeader), `#define SOLOKPDF_PDFIUM_VERSION "${pin.version}"\n`);
    writeFileSync(join(staging, manifest), JSON.stringify(pin, null, 2) + "\n");
    await publishPackage(staging, dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Verified ${pin.version}, no V8: ${pin.sha256}`);
  return dir;
}

if (import.meta.main) await fetchPdfium();
