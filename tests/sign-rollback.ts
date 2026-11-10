import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { verifyPdfSignature, writeTestPfx } from "./pki.ts";
import { assemblePdf, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

const password = "sign-rollback-test";
const stage = { widget: 1, options: 2, registered: 3, digest: 4, noJournal: 5, busyJournal: 6 };
type Mode = "clean" | "dirty" | "redo" | "pending" | "saved" | "malformed";

async function query(client: ControlClient, ...args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(String(res[1]));
  const text = String(res[1]);
  if (text.includes("ERROR") || text === "no-editor") throw new Error(text);
  return text;
}

function fixture(existing: boolean, mode: Mode): string {
  const sig = existing ? "6 0 R" : "";
  const fields = mode === "malformed" ? "7" : `[4 0 R ${sig}]`;
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields ${fields} /DR << /Font << /Helv 7 0 R >> >> >> >>`,
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R ${sig}] >>`,
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (text) /V (ORIGINAL) /Rect [50 300 300 350] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>",
    "<< /Type /Annot /Subtype /Text /Rect [400 400 420 420] /Contents (keep annotation) >>",
    "<< /Type /Annot /Subtype /Widget /FT /Sig /T (CEO) /Rect [50 50 250 130] /P 3 0 R /F 4 /Lock << /Action /Include /Fields [(text)] /P 2 >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

function count(state: string, name: string): number {
  const value = new RegExp(`\\b${name}=(\\d+)`).exec(state);
  if (!value) throw new Error(`missing ${name}: ${state}`);
  return Number(value[1]);
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("sign-rollback: skips ng's different control protocol");
    return;
  }
  const dir = tmpPath("sign-rollback");
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "signer.pfx");
  const cert = writeTestPfx(certPath, "Sign Rollback", password);
  const broken = join(dir, "broken.png");
  writeFileSync(broken, "broken PNG");

  for (const engine of ["mupdf", "pdfium"]) {
    for (const existing of [false, true]) {
      for (const mode of ["clean", "dirty", "redo", "pending", "saved", "malformed"] as Mode[]) {
        if (mode === "malformed" && existing) continue;
        const name = `${engine}-${existing}-${mode}`;
        const source = join(dir, `${name}.pdf`);
        const saved = join(dir, `${name}-signed.pdf`);
        writeFileSync(source, fixture(existing, mode), "latin1");
        const { proc, client } = await launchControlled(["-appdata", dir, source], {
          env: { ...process.env, SOLOKPDF_ENGINE: engine },
        });
        try {
          await client.waitForRenderIdle();
          if (mode !== "clean" && mode !== "malformed") {
            const edit = await client.setFormField(1, 0, "KEPT");
            if (edit[0] !== 0) throw new Error(`edit: ${edit[1]}`);
          }
          if (mode === "redo") {
            await client.setFormField(1, 0, "FUTURE");
            await client.request(ControlCommand.TestInvokeCommand, ["CmdUndo"]);
          }
          if (mode === "pending" || mode === "saved") {
            const signed = await query(client, "sign", certPath, password, "", "", 0);
            if (!signed.startsWith("ok=1")) throw new Error(signed);
            if (mode === "saved") {
              if ((await query(client, "sign-save", source)) !== "saved") throw new Error("initial save failed");
              await client.request(ControlCommand.TestInvokeCommand, ["CmdReloadDocument"]);
              await client.waitForRenderIdle();
            }
          }
          const before = await query(client, "sign-state");
          if (mode === "redo" && count(before, "steps") <= count(before, "pos")) throw new Error(`no redo: ${before}`);
          if (mode === "pending" && count(before, "pending") !== 1) throw new Error(`no pending signer: ${before}`);
          if (mode === "saved" && (count(before, "pending") !== 0 || count(before, "dirty") !== 0))
            throw new Error(`initial signature not saved: ${before}`);
          const field = existing ? "CEO" : "";
          const failures: [string, string, string, number][] =
            mode === "malformed"
              ? [[password, "", "", 0]]
              : [
                  ["wrong-password", "", field, 0],
                  [password, broken, field, 0],
                  [password, join(dir, "missing.png"), field, 0],
                  [password, "", "missing-field", 0],
                  [password, "", field, stage.noJournal],
                  [password, "", field, stage.busyJournal],
                ];
          if (mode !== "malformed" && count(before, "faults")) {
            for (const fault of [stage.widget, stage.options, stage.registered, stage.digest])
              failures.push([password, "", field, fault]);
          }
          for (const [pw, image, target, fault] of failures) {
            const result = await query(client, "sign", certPath, pw, image, target, fault);
            if (!result.startsWith("ok=0")) throw new Error(`${name}: expected failure: ${result}`);
            if (fault > 0 && fault <= stage.digest && !result.includes("injected"))
              throw new Error(`wrong failure: ${result}`);
            const after = await query(client, "sign-state");
            if (before !== after)
              throw new Error(`${name} fault=${fault}: changed state\nBEFORE ${before}\nAFTER ${after}`);
          }
          if (mode === "malformed") {
            console.log(`${name}: creation failure rolled back`);
            continue;
          }
          if (mode === "redo") {
            await client.request(ControlCommand.TestInvokeCommand, ["CmdRedo"]);
            if (!/\/V\s*\(FUTURE\)/.test(await query(client, "sign-state"))) throw new Error("lost redo contents");
            await client.request(ControlCommand.TestInvokeCommand, ["CmdUndo"]);
            if (before !== (await query(client, "sign-state"))) throw new Error("undo after redo changed state");
          }
          const retry = await query(client, "sign", certPath, password, "", field, 0);
          if (!retry.startsWith("ok=1")) throw new Error(`retry: ${retry}`);
          const prepared = await query(client, "sign-state");
          if (
            count(prepared, "dirty") !== 1 ||
            count(prepared, "pos") !== count(before, "pos") + 1 ||
            count(prepared, "pending") !== count(before, "pending") + 1
          )
            throw new Error(`retry state: ${prepared}`);
          const failedSave = await query(client, "sign-save", join(dir, "absent", "cannot-save.pdf"));
          if (failedSave !== "save-failed" || prepared !== (await query(client, "sign-state")))
            throw new Error("failed save lost prepared signature");
          copyFileSync(source, saved);
          if ((await query(client, "sign-save", saved)) !== "saved") throw new Error("save failed");
          const bytes = readFileSync(saved);
          const ranges = [...bytes.toString("latin1").matchAll(/\/ByteRange\s*\[\s*\d+\s+\d+\s+(\d+)\s+(\d+)\s*\]/g)];
          const ends = [...new Set(ranges.map((m) => Number(m[1]) + Number(m[2])))].sort((a, b) => a - b);
          if (ends.length !== (mode === "pending" || mode === "saved" ? 2 : 1))
            throw new Error(`lost signature: ${ends}`);
          for (const end of ends) {
            const revision = join(dir, "revision.pdf");
            writeFileSync(revision, bytes.subarray(0, end));
            verifyPdfSignature(revision, cert);
          }
          console.log(`${name}: ${failures.length} failures restored; retry saved and verified`);
        } finally {
          client.close();
          await killAndWait(proc);
        }
      }
    }
  }
}

if (import.meta.main) await runStandalone(testit);
