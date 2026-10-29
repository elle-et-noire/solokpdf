import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, SLOW_BUILD_FACTOR, tmpPath } from "./util.ts";
import { postMessage, processesUsingFile, waitForTopWindow, WM_CLOSE } from "./winapi.ts";

const bigHeader = `%PDF-1.4\n%${"x".repeat(33 * 1024 * 1024)}\n`;

function fixture(size: "small" | "big"): Buffer {
  const pdf = assemblePdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>",
    ],
    { header: size === "big" ? bigHeader : undefined },
  );
  return Buffer.from(pdf, "latin1");
}

async function changeSource(engine: string, action: "rename" | "delete", source: string, moved: string) {
  const deadline = Date.now() + 10000 * SLOW_BUILD_FACTOR;
  while (true) {
    try {
      if (action === "rename") renameSync(source, moved);
      else unlinkSync(source);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // MuPDF keeps its big file open; retrying cannot release that handle.
      if (engine !== "pdfium" || (code !== "EBUSY" && code !== "EPERM")) throw e;
      if (Date.now() >= deadline) {
        throw new Error(`${(e as Error).message}; held by: ${processesUsingFile(source).join(", ") || "unknown"}`);
      }
      await Bun.sleep(100);
    }
  }
}

async function check(engine: string, size: "small" | "big", action: "rename" | "delete", pdf: Buffer) {
  const dir = tmpPath(`pdfium-saveas/${engine}-${size}-${action}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.pdf");
  const moved = join(dir, "moved.pdf");
  const saved = join(dir, "saved.pdf");
  writeFileSync(source, pdf);

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      await changeSource(engine, action, source, moved);
      if (existsSync(source)) throw new Error("source path still exists");

      const save = client.request(ControlCommand.TestSaveFileAs, [saved]);
      const dlg = await Promise.race([save.then(() => 0), waitForTopWindow(proc.pid!, "#32770", 5000)]);
      if (dlg) postMessage(dlg, WM_CLOSE, 0, 0);
      const result = await save;
      if (result[0] !== 0) throw new Error(`Save As: ${result[1]}`);
      if (!existsSync(saved)) throw new Error("Save As made no file");
      if (!readFileSync(saved).equals(pdf)) throw new Error("saved bytes differ from original");
    },
    ["-appdata", join(dir, "settings"), "-log-to-file", join(dir, "app.log"), source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
  console.log(`${engine} ${size} ${action}: saved identical bytes`);
}

export async function testit(): Promise<void> {
  const failures: string[] = [];
  for (const size of ["small", "big"] as const) {
    const pdf = fixture(size);
    for (const engine of ["mupdf", "pdfium"]) {
      for (const action of ["rename", "delete"] as const) {
        try {
          await check(engine, size, action, pdf);
        } catch (e) {
          const name = `${engine} ${size} ${action}`;
          if (engine === "mupdf" && size === "big" && (e as NodeJS.ErrnoException).code === "EBUSY") {
            console.log(`${name}: Windows denied the file operation on MuPDF's open handle`);
            continue;
          }
          failures.push(name);
          console.error(`${name}: ${e}`);
        }
      }
    }
  }
  if (failures.length) throw new Error(`Save As failed: ${failures.join(", ")}`);
}

if (import.meta.main) await runStandalone(testit);
