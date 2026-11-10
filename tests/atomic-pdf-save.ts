import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, makeTextPdf, pollUntil, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { findTopWindow, isWindowVisible, observeProcessExit, postMessage, WM_CLOSE } from "./winapi.ts";

async function check(engine: string, size: "small" | "big" | "merge", failure: string): Promise<boolean> {
  const label = `${engine}-${size}-${failure}`;
  const dir = tmpPath(`atomic-pdf-save/${label}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "source.pdf");
  const dest = join(dir, "keep.pdf");
  const original = makeTextPdf("KEEP THIS FILE");
  const content = "BT /F1 18 Tf 72 200 Td (COPIED SOURCE) Tj ET";
  const padding = size === "merge" ? 0 : size === "big" ? 33 * 1024 * 1024 : 256 * 1024;
  const data = Buffer.from(
    assemblePdf(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ],
      { header: `%PDF-1.7\n%${"x".repeat(padding)}\n` },
    ),
    "latin1",
  );
  writeFileSync(source, data);
  writeFileSync(dest, original);
  if (failure === "p") chmodSync(dest, 0o444);
  let ran = false;
  let nativeExit: (() => number | null) | undefined;
  try {
    ran = await withControlledSumatra(
      EXE,
      async (client, proc) => {
        nativeExit = observeProcessExit(proc.pid!);
        await client.waitForRenderIdle();
        if ((await client.request(ControlCommand.TestCurrentPdf, ["save-faults"]))[1] !== "supported") {
          console.log("SKIP atomic-pdf-save: Debug fault injection unavailable");
          return false;
        }
        const before = readdirSync(dir).sort().join("\n");
        if (size === "merge") {
          const opened = await client.request(ControlCommand.TestMergePdf, ["open", "", 0]);
          if (opened[0] !== 0) throw new Error(`Merge failed to open: ${opened[1]}`);
          const saved = await client.request(ControlCommand.TestMergePdf, ["saveas", dest, 0]);
          if (String(saved[1]) !== `OK saved=${failure ? 0 : 1}`) throw new Error(`${label}: ${saved[1]}`);
          await client.request(ControlCommand.TestMergePdf, ["close", "", 0]);
        } else {
          const saving = client.request(ControlCommand.TestSaveFileAs, [dest]);
          if (failure) {
            const dialog = await pollUntil(
              () => findTopWindow(proc.pid!, "#32770"),
              (hwnd) => !!hwnd && isWindowVisible(hwnd),
              { timeoutMs: 5000, error: "No save failure warning" },
            );
            postMessage(dialog!, WM_CLOSE, 0, 0);
          }
          const saved = await saving;
          if ((saved[0] === 0) !== !failure) throw new Error(`${label}: unexpected save result ${saved[1]}`);
        }
        if (
          !existsSync(dest) ||
          (failure ? !readFileSync(dest).equals(original) : size !== "merge" && !readFileSync(dest).equals(data))
        )
          throw new Error(`${label}: failed save destroyed the existing destination`);
        if (!failure && size === "merge") {
          await client.waitForRenderIdle();
          const text = await client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
          if (!String(text[1]).includes("COPIED SOURCE")) throw new Error(`${label}: merged output lost source text`);
        }
        if (failure && readdirSync(dir).sort().join("\n") !== before)
          throw new Error(`${label}: temporary output leaked`);
        if (!readFileSync(source).equals(data)) throw new Error(`${label}: source changed`);
        return true;
      },
      ["-appdata", join(dir, "settings"), "-log-to-file", join(dir, "app.log"), source],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_SAVE_FAILURE: failure === "p" ? "" : failure } },
    );
  } catch (error) {
    throw new Error(`${error}; native exit=${nativeExit?.()}`);
  } finally {
    nativeExit?.();
    if (existsSync(dest)) chmodSync(dest, 0o666);
  }
  if (ran) console.log(`${label}: destination preserved`);
  return ran;
}

export async function testit(): Promise<void> {
  if (USE_NG) return;
  for (const engine of ["pdfium", "mupdf"]) {
    for (const size of engine === "pdfium" ? (["small", "big", "merge"] as const) : (["merge"] as const)) {
      for (const failure of ["w", ...(size === "merge" ? [] : ["r"]), "p", ""]) {
        const label = `${engine}-${size}-${failure}`;
        if (process.env.ATOMIC_SAVE_CASE && process.env.ATOMIC_SAVE_CASE !== label) continue;
        if (!(await check(engine, size, failure))) return;
      }
    }
  }
}

if (import.meta.main) await runStandalone(testit);
