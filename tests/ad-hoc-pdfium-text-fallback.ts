import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { ROOT, runStandalone } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

const dirs = [join(ROOT, ".work", "corpus"), join(ROOT, ".work", "corpus", "independent")];

export async function testit(): Promise<void> {
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".pdf"))
      .map((name) => join(dir, name)),
  );
  if (!files.some((file) => file.includes("ipa-2026-soshiki.pdf"))) {
    throw new Error("Japanese IPA document is missing from corpus");
  }

  let pages = 0;
  let editorPages = 0;
  for (const file of files) {
    const { proc, client } = await launchControlled([file], { env: { SOLOKPDF_ENGINE: "pdfium" } });
    let loadedAt = 0;
    let count = 0;
    try {
      const result = await client.request(ControlCommand.TestCurrentPdf, ["pages"]);
      count = Number(/^pages=(\d+)$/.exec(String(result[1]))?.[1]);
      if (result[0] !== 0 || !count) throw new Error(`${file}: ${result[1]}`);
      for (let page = 1; page <= count; page++) {
        const text = await client.request(ControlCommand.TestCurrentPdf, ["text-page", page]);
        if (text[0] !== 0) throw new Error(`${file} page ${page}: ${text[1]}`);
        const editor = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
        if (editor[1] === "editor=loaded" && !loadedAt) loadedAt = page;
      }
    } finally {
      client.close();
      await killAndWait(proc);
    }
    pages += count;
    if (loadedAt) editorPages += count - loadedAt + 1;
    console.log(`${file}: ${count} pages, editor ${loadedAt ? `loaded at page ${loadedAt}` : "none"}`);
  }
  console.log(
    `PDFium text fallback: ${files.length} documents, ${pages} pages, ${editorPages} pages after editor load`,
  );
}

if (import.meta.main) await runStandalone(testit);
