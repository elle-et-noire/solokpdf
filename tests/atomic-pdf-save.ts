import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, makeTextPdf, pollUntil, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { FRAME_CLASS } from "./win-automation.ts";
import {
  findTopWindow,
  isWindowVisible,
  observeProcessExit,
  postMessage,
  sendCopyDataW,
  waitForTopWindow,
  WM_CLOSE,
} from "./winapi.ts";

async function check(engine: string, size: "small" | "big" | "merge" | "copy", failure: string): Promise<boolean> {
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
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R ${size === "copy" ? "/Annots [6 0 R]" : ""} >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Annot /Subtype /Square /P 3 0 R /Rect [72 50 150 100] /Contents (ORIGINAL) >>",
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
        if (size === "copy") {
          const edited = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "COPIED EDIT"]);
          if (!String(edited[1]).includes("changed=1")) throw new Error(`${label}: could not edit: ${edited[1]}`);
          const saved = await client.request(ControlCommand.TestCurrentPdf, ["save-copy", dest]);
          if (String(saved[1]) !== `saved=${failure ? 0 : 1}`) throw new Error(`${label}: ${saved[1]}`);
          const state = await client.request(ControlCommand.TestMarkupAnnots);
          if (!String(state[1]).includes("modified=1")) throw new Error(`${label}: copy marked source clean`);
        } else if (size === "merge") {
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
          (failure
            ? !readFileSync(dest).equals(original)
            : size !== "merge" && size !== "copy" && !readFileSync(dest).equals(data))
        )
          throw new Error(`${label}: failed save destroyed the existing destination`);
        if (!failure && size === "merge") {
          await client.waitForRenderIdle();
          const text = await client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
          if (!String(text[1]).includes("COPIED SOURCE")) throw new Error(`${label}: merged output lost source text`);
        }
        if (!failure && size === "copy") {
          const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
          if (!sendCopyDataW(frame, 0x44646557, `[Open("${dest}", 0, 1, 0)]`))
            throw new Error(`${label}: reopen failed`);
          await client.waitForRenderIdle();
          const text = await client.request(ControlCommand.TestCurrentPdf, ["cached-text", 1]);
          const edit = await client.request(ControlCommand.TestCurrentPdf, ["set-annot-contents", "COPIED EDIT"]);
          if (!String(text[1]).includes("COPIED SOURCE") || !String(edit[1]).includes("before='COPIED EDIT'"))
            throw new Error(`${label}: copy lost content: ${text[1]} ${edit[1]}`);
        }
        if (readdirSync(dir).sort().join("\n") !== before) throw new Error(`${label}: temporary output leaked`);
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
    for (const size of engine === "pdfium"
      ? (["small", "big", "merge", "copy"] as const)
      : (["merge", "copy"] as const)) {
      for (const failure of size === "copy" ? ["f", "p", ""] : ["w", ...(size === "merge" ? [] : ["r"]), "p", ""]) {
        const label = `${engine}-${size}-${failure}`;
        if (process.env.ATOMIC_SAVE_CASE && process.env.ATOMIC_SAVE_CASE !== label) continue;
        if (!(await check(engine, size, failure))) return;
      }
    }
  }
}

if (import.meta.main) await runStandalone(testit);
