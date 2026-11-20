import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchPdfium, pdfiumPin } from "../cmd/solok-fetch-pdfium";
import { holdFileAgainstReplace } from "./winapi.ts";

const asset = "pdfium-win-x64.tgz";
const manifest = "solok-pin.json";
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

function archive(work: string, version: string) {
  const source = join(work, version);
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(join(source, "include"));
  writeFileSync(join(source, "bin/pdfium.dll"), version);
  writeFileSync(join(source, "include/fpdfview.h"), version);
  writeFileSync(join(source, "LICENSE"), version);
  mkdirSync(join(source, "licenses"));
  writeFileSync(join(source, "licenses/pdfium.txt"), version);
  const path = join(work, `${version}.tgz`);
  const pack = Bun.spawnSync([tar, "-czf", path, "-C", source, "."]);
  assert.equal(pack.exitCode, 0, pack.stderr.toString());
  const bytes = readFileSync(path);
  const pin = {
    version,
    tag: `chromium/${version.split(".")[2]}`,
    url: `https://example.invalid/${version}/${asset}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { pin, bytes };
}

mkdirSync(".work", { recursive: true });
const work = mkdtempSync(join(resolve(".work"), "test-pdfium-pin-"));
const cacheDir = join(work, ".work/pdfium");
const originalFetch = globalThis.fetch;
try {
  const old = archive(work, "1.0.100.0");
  const next = archive(work, "2.0.200.0");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, asset), old.bytes);
  mkdirSync(join(cacheDir, "include"));
  writeFileSync(join(cacheDir, "include/removed-header.h"), "stale extracted file");

  let downloads = 0;
  let response = old.bytes;
  let downloadUrl = pdfiumPin.url;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL) => {
      assert.equal(url, downloadUrl);
      downloads++;
      return new Response(Uint8Array.from(response));
    },
    { preconnect: originalFetch.preconnect },
  );

  await assert.rejects(fetchPdfium({ cacheDir }), /SHA-256 mismatch/);
  assert.equal(downloads, 1, "a stale flat archive must trigger a download for the active pin");

  downloads = 0;
  downloadUrl = next.pin.url;
  const legacy = await fetchPdfium({ pin: old.pin, cacheDir });
  assert.equal(downloads, 0, "matching legacy archive must work offline");
  assert.equal(readFileSync(join(legacy, "bin/pdfium.dll"), "utf8"), old.pin.version);
  assert.deepEqual(JSON.parse(readFileSync(join(legacy, manifest), "utf8")), old.pin);

  await assert.rejects(fetchPdfium({ pin: next.pin, cacheDir }), /SHA-256 mismatch/);
  assert.equal(downloads, 1, "a stale flat archive must trigger a download for the new pin");

  response = next.bytes;
  const [upgraded, other] = await Promise.all([
    fetchPdfium({ pin: next.pin, cacheDir }),
    fetchPdfium({ pin: next.pin, cacheDir }),
  ]);
  assert.notEqual(upgraded, legacy);
  assert.equal(other, upgraded);
  assert.deepEqual(JSON.parse(readFileSync(join(upgraded, manifest), "utf8")), next.pin);
  assert.equal(readFileSync(join(upgraded, "bin/pdfium.dll"), "utf8"), next.pin.version);
  assert.equal(readFileSync(join(upgraded, "include/fpdfview.h"), "utf8"), next.pin.version);
  assert.equal(
    readFileSync(join(upgraded, "include/solok_pdfium_version.h"), "utf8"),
    `#define SOLOKPDF_PDFIUM_VERSION "${next.pin.version}"\n`,
  );
  assert.equal(existsSync(join(upgraded, "include/removed-header.h")), false);
  assert.deepEqual(readFileSync(join(cacheDir, asset)), old.bytes);

  const nextDll = join(upgraded, "bin/pdfium.dll");
  const nextHeader = join(upgraded, "include/fpdfview.h");
  const modified = statSync(nextHeader).mtimeMs;
  const before = downloads;
  assert.equal(await fetchPdfium({ pin: next.pin, cacheDir }), upgraded);
  assert.equal(downloads, before, "published archive must work offline");
  assert.equal(statSync(nextHeader).mtimeMs, modified, "cached headers should keep their timestamps");

  writeFileSync(nextDll, "damaged PDFium DLL");
  rmSync(nextHeader);
  const unchangedHeader = join(upgraded, "include/solok_pdfium_version.h");
  const unchangedMtime = statSync(unchangedHeader).mtimeMs;
  const fetchModule = pathToFileURL(resolve(import.meta.dir, "../cmd/solok-fetch-pdfium.ts")).href;
  const repairScript = `
    import { fetchPdfium } from ${JSON.stringify(fetchModule)};
    globalThis.fetch = () => { throw new Error("unexpected network during cache repair"); };
    await fetchPdfium(${JSON.stringify({ pin: next.pin, cacheDir })});
  `;
  const repair = () => Bun.spawn([process.execPath, "-e", repairScript], { stdout: "inherit", stderr: "inherit" });
  const release = holdFileAgainstReplace(nextDll);
  const repairs = [repair(), repair()];
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && repairs.every((proc) => proc.exitCode === null)) {
      const ready = readdirSync(cacheDir).filter(
        (name) => name.startsWith(".extract-") && existsSync(join(cacheDir, name, "package", manifest)),
      );
      if (ready.length === repairs.length) break;
      await Bun.sleep(10);
    }
    await Bun.sleep(100);
  } finally {
    release();
  }
  assert.deepEqual(
    await Promise.all(repairs.map((proc) => proc.exited)),
    [0, 0],
    "parallel builds must repair extraction offline",
  );
  assert.equal(readFileSync(nextDll, "utf8"), next.pin.version);
  assert.equal(readFileSync(nextHeader, "utf8"), next.pin.version);
  assert.equal(statSync(unchangedHeader).mtimeMs, unchangedMtime, "repair must keep unchanged header timestamps");

  const pinnedArchive = readdirSync(cacheDir).find((name) => name.includes(next.pin.sha256) && name.endsWith(asset));
  assert(pinnedArchive, "expected a verified archive cached by digest");
  const archivePath = join(cacheDir, pinnedArchive);
  writeFileSync(archivePath, old.bytes);
  assert.equal(await fetchPdfium({ pin: next.pin, cacheDir }), upgraded);
  assert.equal(downloads, before + 1, "damaged pinned archive must trigger a verified replacement");
  assert.deepEqual(readFileSync(archivePath), next.bytes);
  console.log("PDFium pin migration, verification, parallel publication, and offline repair passed");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(work, { recursive: true, force: true });
}
