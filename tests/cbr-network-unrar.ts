// A cbx under 32 MB on a network drive is read into memory and opened by
// libarchive. libarchive only decompresses RAR 2.9+ (and RAR5), so an older
// comic (RAR 2.0, common for 2005-era .cbr) listed its pages but every page
// failed to load. RAR must go through unrar.dll, which needs a path: the
// network copy path.
//
// Builds a stored RAR with two PNG pages (no rar tool is needed; stored
// entries are just headers + bytes) and opens it through the drive's
// administrative share (\\localhost\c$\...), which counts as a network path.
// The fixture is one both libraries can read, so the test checks the route,
// not the decompression. Skips where the share is not reachable.
//
// Run: bun tests/cbr-network-unrar.ts [--no-build]
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { crc32, EXE, makeStoredZip, pollUntil, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { captureWindowPixels } from "./winapi.ts";
import { findCanvas, waitForFrame } from "./win-automation.ts";

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeAndData = concat([new TextEncoder().encode(type), data]);
  return concat([u32be(data.length), typeAndData, u32be(crc32(typeAndData))]);
}

// 16x16 RGB PNG filled with one color
function makePng(r: number, g: number, b: number): Uint8Array {
  const size = 16;
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) {
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const ihdr = concat([u32be(size), u32be(size), new Uint8Array([8, 2, 0, 0, 0])]);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 0 }))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

const kRarMarker = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const kBlockMain = 0x73;
const kBlockFile = 0x74;
const kBlockEnd = 0x7b;
const kFlagLongBlock = 0x8000;
const kHostWin32 = 2;
const kUnpVer29 = 29;
const kMethodStore = 0x30;

// a RAR 1.5-4.x block: HEAD_CRC is the low 16 bits of the crc32 of the rest
function rarBlock(type: number, flags: number, body: Uint8Array): Uint8Array {
  const size = 7 + body.length;
  const rest = concat([new Uint8Array([type, flags & 0xff, flags >> 8, size & 0xff, size >> 8]), body]);
  const crc = crc32(rest) & 0xffff;
  return concat([new Uint8Array([crc & 0xff, crc >> 8]), rest]);
}

function rarStoredFile(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const body = new Uint8Array(25 + nameBytes.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, data.length, true); // PACK_SIZE
  dv.setUint32(4, data.length, true); // UNP_SIZE
  body[8] = kHostWin32;
  dv.setUint32(9, crc32(data), true); // FILE_CRC
  dv.setUint32(13, 0, true); // FTIME
  body[17] = kUnpVer29;
  body[18] = kMethodStore;
  dv.setUint16(19, nameBytes.length, true);
  dv.setUint32(21, 0x20, true); // ATTR
  body.set(nameBytes, 25);
  return concat([rarBlock(kBlockFile, kFlagLongBlock, body), data]);
}

function makeStoredRar(files: [string, Uint8Array][]): Uint8Array {
  return concat([
    kRarMarker,
    rarBlock(kBlockMain, 0, new Uint8Array(6)),
    ...files.map(([name, data]) => rarStoredFile(name, data)),
    rarBlock(kBlockEnd, 0x4000, new Uint8Array(0)),
  ]);
}

// C:\dir\file.cbr => \\localhost\c$\dir\file.cbr
function toUncPath(path: string): string {
  return `\\\\localhost\\${path[0].toLowerCase()}$${path.slice(2)}`;
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP cbr-network-unrar: Windows control protocol required");
    return;
  }
  const cbr = tmpPath("cbr-network-unrar.cbr");
  const log = tmpPath("cbr-network-unrar.log");
  const freshLog = tmpPath("cbr-network-fresh.log");
  rmSync(log, { force: true });
  rmSync(freshLog, { force: true });
  const appdata = tmpPath("cbr-network-settings");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), "ReloadModifiedDocuments = false\n");
  writeFileSync(
    cbr,
    makeStoredRar([
      ["001.png", makePng(200, 40, 40)],
      ["002.png", makePng(40, 40, 200)],
    ]),
  );
  const unc = toUncPath(cbr);
  if (!existsSync(unc)) {
    console.log(`\nSKIP cbr-network-unrar: '${unc}' is not reachable (needs the administrative share)`);
    return;
  }

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid);
      await client.waitForRenderIdle();
      await client.setNotificationsEnabled(false);
      // page 1 is solid red; a failed render leaves the page white
      const canvas = findCanvas(frame);
      await pollUntil(
        () => countRedPixels(canvas),
        (n) => n > 500,
        { timeoutMs: 10_000, error: "cbr-network-unrar: page 1 did not render" },
      );
      const original = await clonePage(client);
      if (!original.includes("ink=256")) throw new Error(`original clone: ${original}`);
      const oldTime = statSync(cbr).mtime;
      const replacement = makeStoredRar([
        ["001.png", makePng(255, 255, 255)],
        ["002.png", makePng(255, 255, 255)],
      ]);
      if (replacement.length !== statSync(cbr).size) throw new Error("fixture sizes differ");
      await withControlledSumatra(
        EXE,
        async (fresh) => {
          await fresh.waitForRenderIdle();
          if ((await clonePage(fresh)) !== original) throw new Error("second opener lost original input");
          writeFileSync(cbr, replacement);
          utimesSync(cbr, oldTime, new Date(oldTime.getTime() + 10_000));
          await fresh.request(ControlCommand.TestInvokeCommand, ["CmdReloadDocument"]);
          await fresh.waitForRenderIdle();
          const result = await clonePage(fresh);
          if (!result.includes("ink=0 ")) throw new Error(`same-size replacement retained stale pixels: ${result}`);
          const retained = await clonePage(client);
          if (retained !== original) throw new Error(`old clone changed: ${original} -> ${retained}`);
        },
        ["-appdata", appdata, "-log-to-file", freshLog, unc],
      );

      await withControlledSumatra(
        EXE,
        async (hit) => {
          await hit.waitForRenderIdle();
          const result = await clonePage(hit);
          if (!result.includes("ink=0 ")) throw new Error(`cache hit retained stale pixels: ${result}`);
        },
        ["-log-to-file", freshLog, unc],
      );
      await copyRaces(client, replacement);
    },
    ["-appdata", appdata, "-log-to-file", log, unc],
  );

  const text = readFileSync(log, "utf8");
  if (text.includes("MaybeCreateCbxFromMemory: loaded")) {
    throw new Error("cbr-network-unrar: a RAR on a network drive was opened in memory by libarchive");
  }
  if (!text.includes("EngineCbx::CreateFromFile")) {
    throw new Error("cbr-network-unrar: the RAR was not opened from a file (unrar.dll)");
  }
  if (!readFileSync(freshLog, "utf8").includes("MaybeCopyCbxToLocalCache: cache hit")) {
    throw new Error("unchanged source did not reuse its cache");
  }
  await largeCbz();
}

async function largeCbz(): Promise<void> {
  const source = tmpPath("cbz-network-large.cbz");
  const log = tmpPath("cbz-network-large.log");
  const padding = { name: "padding.bin", data: Buffer.alloc(33 * 1024 * 1024) };
  const archive = (color: number) =>
    makeStoredZip([{ name: "001.png", data: Buffer.from(makePng(color, color, color)) }, padding]);
  const original = archive(40);
  const replacement = archive(255);
  if (original.length !== replacement.length) throw new Error("CBZ fixture sizes differ");
  writeFileSync(source, original);
  rmSync(log, { force: true });
  await withControlledSumatra(
    EXE,
    async (old) => {
      await old.waitForRenderIdle();
      const before = await clonePage(old);
      if (!before.includes("ink=256")) throw new Error(`large CBZ original: ${before}`);
      const time = statSync(source).mtime;
      writeFileSync(source, replacement);
      utimesSync(source, time, new Date(time.getTime() + 10_000));
      await withControlledSumatra(
        EXE,
        async (fresh) => {
          await fresh.waitForRenderIdle();
          if (!(await clonePage(fresh)).includes("ink=0 ")) throw new Error("large CBZ replacement is stale");
          if ((await clonePage(old)) !== before) throw new Error("large CBZ old clone changed");
        },
        [toUncPath(source)],
      );
    },
    ["-appdata", tmpPath("cbr-network-settings"), "-log-to-file", log, toUncPath(source)],
  );
  if (!readFileSync(log, "utf8").includes("MaybeCopyCbxToLocalCache: copied"))
    throw new Error("large CBZ bypassed cache");
  console.log("cbr-network-unrar: large CBZ passed");
}

async function copyRaces(client: ControlClient, data: Uint8Array): Promise<void> {
  const missing = await client.request(ControlCommand.TestCurrentPdf, [
    "cbx-copy",
    toUncPath(tmpPath("missing.cbr")),
    "",
  ]);
  if (missing[1] === "unsupported") {
    console.log("cbr-network-unrar: copy barriers require Debug");
    return;
  }
  if (missing[0] !== 0 || missing[1] !== "path= timeout=0") throw new Error(`metadata failure: ${missing}`);
  for (const mode of ["changed", "race", "publish-failed"] as const) {
    const sourceDir = tmpPath(`cbr-network-${mode}`);
    mkdirSync(sourceDir, { recursive: true });
    const source = join(sourceDir, "comic.cbr");
    const signal = tmpPath(`cbr-network-${mode}.signal`);
    rmSync(signal, { force: true });
    rmSync(`${signal}.go`, { force: true });
    writeFileSync(source, data);
    const request = client.request(ControlCommand.TestCurrentPdf, ["cbx-copy", toUncPath(source), signal]);
    let cachePath = "";
    let result;
    try {
      await pollUntil(() => existsSync(signal), Boolean, { timeoutMs: 10_000, error: `${mode}: copy did not pause` });
      cachePath = readFileSync(signal, "utf8");
      if (!cachePath || existsSync(cachePath)) throw new Error(`${mode}: incomplete copy was published`);
      if (mode === "changed") {
        const time = statSync(source).mtime;
        utimesSync(source, time, new Date(time.getTime() + 10_000));
      } else if (mode === "race") {
        await withControlledSumatra(
          EXE,
          async (other) => {
            await other.waitForRenderIdle();
            if (!(await clonePage(other)).includes("ink=0 ")) throw new Error("racing opener lost pixels");
          },
          [toUncPath(source)],
        );
        if (!readFileSync(cachePath).equals(Buffer.from(data))) throw new Error("racing copy is incomplete");
      } else {
        mkdirSync(cachePath);
      }
    } finally {
      writeFileSync(`${signal}.go`, "");
      result = await request;
    }
    if (result[0] !== 0 || String(result[1]).includes("timeout=1")) throw new Error(`${mode}: ${result}`);
    const expected = mode === "race" ? cachePath : "";
    if (result[1] !== `path=${expected} timeout=0`) throw new Error(`${mode}: ${result}`);
    const leftovers = readdirSync(dirname(cachePath)).filter((name) => name.startsWith(`${basename(cachePath)}.`));
    if (leftovers.length) throw new Error(`${mode}: temporary copies remain: ${leftovers}`);
    if (mode === "publish-failed") {
      await withControlledSumatra(
        EXE,
        async (fallback) => {
          await fallback.waitForRenderIdle();
          if (!(await clonePage(fallback)).includes("ink=0 ")) throw new Error("fallback lost pixels");
        },
        [toUncPath(source)],
      );
      rmdirSync(cachePath);
    }
    console.log(`cbr-network-unrar: ${mode} passed`);
  }
}

async function clonePage(client: ControlClient): Promise<string> {
  const result = await client.request(ControlCommand.TestCurrentPdf, ["clone-page", 1]);
  if (result[0] !== 0) throw new Error(`clone failed: ${result}`);
  return String(result[1]);
}

// GDI gives BGRA; red is the one channel over 150 with the other two under 90
function countRedPixels(hwnd: number): number {
  const px = captureWindowPixels(hwnd);
  if (!px) {
    return 0;
  }
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    const [b, g, r] = [px.data[i], px.data[i + 1], px.data[i + 2]];
    if (r > 150 && g < 90 && b < 90) {
      n++;
    }
  }
  return n;
}

if (import.meta.main) {
  await runStandalone(testit);
}
