import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageSolokPdf } from "../cmd/helper/solok-portable";
import { pdfiumOpenLog, pdfiumPin } from "../cmd/solok-fetch-pdfium";
import { ControlCommand, withControlledSumatra } from "./control.ts";

const root = resolve(import.meta.dir, "..");
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

async function testRestaging(work: string): Promise<void> {
  const out = join(work, "build");
  const pdfium = join(work, "pdfium");
  const portable = join(work, "loose");
  const zip = join(work, "restaged.zip");
  mkdirSync(out);
  for (const name of ["SumatraPDF.exe", "libsumatrapdf.dll", "sumatrapdf-tool.exe", "pdfium.dll", "SumatraPDF.pdb"]) {
    writeFileSync(join(out, name), name);
  }
  mkdirSync(join(pdfium, "licenses", "sub"), { recursive: true });
  for (const name of ["LICENSE", "solok-pin.json", "licenses/pdfium.txt", "licenses/sub/old.txt"]) {
    writeFileSync(join(pdfium, name), name);
  }

  await packageSolokPdf(out, pdfium, portable, zip);
  assert(existsSync(join(portable, "licenses/pdfium/sub/old.txt")), "initial notice was missing");
  assert(existsSync(join(portable, "SolokPDF.pdb")), "initial symbols were missing");
  const userFiles = ["SolokPDF-settings.txt", "notes.txt", "licenses/pdfium/sub/notes.txt"];
  for (const name of userFiles) writeFileSync(join(portable, name), name);
  rmSync(join(pdfium, "licenses/sub/old.txt"));
  writeFileSync(join(pdfium, "licenses/sub/new.txt"), "new notice");
  rmSync(join(out, "SumatraPDF.pdb"));

  await packageSolokPdf(out, pdfium, portable, zip);
  assert(!existsSync(join(portable, "licenses/pdfium/sub/old.txt")), "retired notice remained in loose output");
  assert(!existsSync(join(portable, "SolokPDF.pdb")), "retired symbols remained in loose output");
  for (const name of userFiles) assert.equal(readFileSync(join(portable, name), "utf8"), name);
  const added = "licenses/pdfium/sub/new.txt";
  assert.equal(readFileSync(join(portable, added), "utf8"), "new notice");
  const list = Bun.spawnSync([tar, "-tf", zip], { stderr: "inherit" });
  assert.equal(list.exitCode, 0, "could not list restaged ZIP");
  const entries = list.stdout.toString().trim().split(/\r?\n/);
  assert(entries.includes(added), "new notice missing from restaged ZIP");
  for (const name of ["licenses/pdfium/sub/old.txt", "SolokPDF.pdb", ".solok-portable-files.json", ...userFiles]) {
    assert(!entries.includes(name), `unexpected restaged ZIP entry: ${name}`);
  }
  console.log("Portable restaging passed: retired files removed and user files preserved");
}

export async function testit(zip: string): Promise<void> {
  // Windows can supply TEMP as an 8.3 alias, which SolokPDF expands when opening the PDF.
  const work = mkdtempSync(join(realpathSync.native(tmpdir()), "SolokPDF portable "));
  try {
    const extracted = join(work, "extracted");
    mkdirSync(extracted);
    const unpack = Bun.spawnSync([tar, "-xf", resolve(zip), "-C", extracted], { stderr: "inherit" });
    assert.equal(unpack.exitCode, 0, `could not extract ${zip}`);

    for (const entry of [
      "SolokPDF.exe",
      "libsumatrapdf.dll",
      "sumatrapdf-tool.exe",
      "pdfium.dll",
      "AUTHORS",
      "COPYING",
      "COPYING.BSD",
      "licenses/upstream/ext/mupdf/COPYING",
      "licenses/pdfium/LICENSE",
      "licenses/pdfium/pdfium.txt",
      "licenses/pdfium/solok-pin.json",
      "README.txt",
    ]) {
      const file = statSync(join(extracted, entry), { throwIfNoEntry: false });
      assert(file?.isFile() && file.size > 0, `missing or empty ZIP entry: ${entry}`);
    }
    const manifest = readFileSync(join(extracted, "licenses/pdfium/solok-pin.json"), "utf8");
    assert.deepEqual(JSON.parse(manifest), pdfiumPin, "expected the pinned PDFium package in the ZIP");

    const readme = readFileSync(join(extracted, "README.txt"), "utf8");
    const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
    assert.equal(git.exitCode, 0, "could not determine source revision");
    const source = `https://github.com/elle-et-noire/solokpdf/blob/${git.stdout.toString().trim()}`;
    assert(readme.includes("SolokPDF.exe"), "README.txt does not explain how to launch the app");
    assert(
      readme.includes(`${source}/docs/solokpdf/limitations.md`),
      "README.txt lacks a revision-specific limitations link",
    );
    assert(readme.includes(`${source}/docs/solokpdf/testing.md`), "README.txt lacks a revision-specific testing link");

    assert(
      process.env.SOLOKPDF_HIDDEN_DESKTOP || process.env.GITHUB_ACTIONS === "true",
      "run this test through tools/solokpdf/run-hidden.ts",
    );
    await testRestaging(work);
    const pdf = join(work, "sample.pdf");
    copyFileSync(join(root, "tests", "issue-1809.pdf"), pdf);
    const log = join(work, "app.log");
    const env = { ...process.env, SOLOKPDF_ENGINE: undefined };
    let app: Bun.Subprocess | undefined;
    try {
      await withControlledSumatra(
        join(extracted, "SolokPDF.exe"),
        async (client, proc) => {
          app = proc;
          await client.waitForRenderIdle();
          const [status, tab] = await client.request(ControlCommand.TestCurrentTab, []);
          assert.equal(status, 0, String(tab));
          assert.equal(tab, `path=${pdf} page=1`);
        },
        ["-appdata", work, "-log-to-file", log, pdf],
        { cwd: extracted, env, connectTimeoutMs: 30_000 },
      );
      assert.equal(app?.exitCode, 0, "extracted SolokPDF did not shut down cleanly");
      const output = readFileSync(log, "utf8");
      assert(
        output.includes(`${pdfiumOpenLog} '${pdf}', 1 pages;`),
        "expected the extracted app to open the sample with PDFium",
      );
    } catch (error) {
      if (existsSync(log)) console.error(readFileSync(log, "utf8"));
      throw error;
    }
    console.log(`Portable ZIP passed: ${zip} (sample.pdf opened with PDFium)`);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (import.meta.main) {
  const [zip, ...rest] = process.argv.slice(2);
  if (!zip || rest.length) throw new Error("usage: bun tests/ad-hoc-solok-portable.ts <portable.zip>");
  await testit(zip);
}
