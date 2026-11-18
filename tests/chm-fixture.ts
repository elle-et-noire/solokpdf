// A minimal CHM written by a test: its files stored uncompressed in one directory chunk
// (as tests/issue-2737-make.ts does), #SYSTEM naming the contents file, home page and title.

const enc = new TextEncoder();
const BLOCK_SIZE = 0x800;
const ITSF_SIZE = 0x60;
const ITSP_SIZE = 0x54;
const PMGL_HEADER_SIZE = 0x14;
// #SYSTEM record types
const SYSTEM_TOC = 0;
const SYSTEM_HOME = 2;
const SYSTEM_TITLE = 3;

export type ChmEntry = { path: string; data: string };
export type ChmInfo = { title: string; home: string; toc: string };

function u16le(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}

function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

// the directory's variable-length number: 7 bits a byte, most significant first
function cword(v: number): Uint8Array {
  const chunks: number[] = [];
  do {
    chunks.push(v & 0x7f);
    v >>= 7;
  } while (v > 0);
  const out: number[] = [];
  for (let i = chunks.length - 1; i > 0; i--) out.push(chunks[i]! | 0x80);
  out.push(chunks[0]!);
  return new Uint8Array(out);
}

// a file in section 0 (uncompressed) at `start` of the content
function pmglEntry(path: string, start: number, size: number): Uint8Array {
  const name = enc.encode(path);
  return cat(cword(name.length), name, cword(0), cword(start), cword(size));
}

function systemRecord(type: number, value: string): Uint8Array {
  const data = cat(enc.encode(value), new Uint8Array([0]));
  return cat(u16le(type), u16le(data.length), data);
}

// paths start with "/"; directory entries are sorted by name
export function makeChm(info: ChmInfo, files: ChmEntry[]): Uint8Array {
  const version = u32le(3);
  const system = cat(
    version,
    systemRecord(SYSTEM_TOC, info.toc),
    systemRecord(SYSTEM_HOME, info.home),
    systemRecord(SYSTEM_TITLE, info.title),
  );
  const all = [{ path: "/#SYSTEM", bytes: system }, ...files.map((f) => ({ path: f.path, bytes: enc.encode(f.data) }))];
  all.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1));
  const entries: Uint8Array[] = [];
  let start = 0;
  for (const f of all) {
    entries.push(pmglEntry(f.path, start, f.bytes.length));
    start += f.bytes.length;
  }
  const listing = cat(...entries);
  const used = PMGL_HEADER_SIZE + listing.length;
  if (used > BLOCK_SIZE) throw new Error("makeChm: too many files for one directory chunk");

  const pmgl = new Uint8Array(BLOCK_SIZE);
  pmgl.set(enc.encode("PMGL"), 0);
  const pmglView = new DataView(pmgl.buffer);
  pmglView.setUint32(4, BLOCK_SIZE - used, true);
  pmglView.setInt32(12, -1, true);
  pmglView.setInt32(16, -1, true);
  pmgl.set(listing, PMGL_HEADER_SIZE);

  const itsp = new Uint8Array(ITSP_SIZE);
  itsp.set(enc.encode("ITSP"), 0);
  const itspView = new DataView(itsp.buffer);
  itspView.setInt32(4, 1, true);
  itspView.setInt32(8, ITSP_SIZE, true);
  itspView.setUint32(0x10, BLOCK_SIZE, true);
  itspView.setInt32(0x1c, -1, true);
  itspView.setUint32(0x28, 1, true);

  const directory = cat(itsp, pmgl);
  const itsf = new Uint8Array(ITSF_SIZE);
  itsf.set(enc.encode("ITSF"), 0);
  const itsfView = new DataView(itsf.buffer);
  itsfView.setInt32(4, 3, true);
  itsfView.setInt32(8, ITSF_SIZE, true);
  itsfView.setBigUint64(0x48, BigInt(ITSF_SIZE), true);
  itsfView.setBigUint64(0x50, BigInt(directory.length), true);
  itsfView.setBigUint64(0x58, BigInt(ITSF_SIZE + directory.length), true);
  return cat(itsf, directory, ...all.map((f) => f.bytes));
}

// pages "<name>.html" in this order in the contents, the first the home page, named as
// the contents name it: page 1
export function makeChmPages(title: string, names: string[]): Uint8Array {
  const item = (name: string) =>
    `<li><object type="text/sitemap"><param name="Name" value="${name}"><param name="Local" value="${name}.html"></object>`;
  const toc = `<html><body><ul>\n${names.map(item).join("\n")}\n</ul></body></html>\n`;
  const pages = names.map((name) => ({ path: `/${name}.html`, data: `<html><body><h1>${name}</h1></body></html>\n` }));
  return makeChm({ title, home: `${names[0]}.html`, toc: "toc.hhc" }, [{ path: "/toc.hhc", data: toc }, ...pages]);
}
