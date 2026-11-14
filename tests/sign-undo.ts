import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { type TestCert, verifyPdfSignature, writeTestPfx } from "./pki.ts";
import { assemblePdf, runStandalone, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

// E40: undoing a prepared (unsaved) signature must drop its pending signer.
const password = "sign-undo-test";

async function query(client: ControlClient, ...args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(String(res[1]));
  const text = String(res[1]);
  if (text.includes("ERROR") || text === "no-editor") throw new Error(text);
  return text;
}

function count(state: string, name: string): number {
  const value = new RegExp(`\\b${name}=(\\d+)`).exec(state);
  if (!value) throw new Error(`missing ${name}: ${state}`);
  return Number(value[1]);
}

function fixture(existing: boolean): string {
  const sig = existing ? "5 0 R" : "";
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R ${sig}] /DR << /Font << /Helv 6 0 R >> >> >> >>`,
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R ${sig}] >>`,
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (text) /V (ORIGINAL) /Rect [50 300 300 350] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) >>",
    "<< /Type /Annot /Subtype /Widget /FT /Sig /T (CEO) /Rect [50 50 250 130] /P 3 0 R /F 4 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("sign-undo: skips ng's different control protocol");
    return;
  }
  const dir = tmpPath("sign-undo");
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "signer.pfx");
  const cert = writeTestPfx(certPath, "Sign Undo", password);

  for (const engine of ["mupdf", "pdfium"]) {
    for (const existing of [false, true]) {
      const name = `${engine}-${existing ? "field" : "new"}`;
      const source = join(dir, `${name}.pdf`);
      writeFileSync(source, fixture(existing), "latin1");
      const field = existing ? "CEO" : "";
      const { proc, client } = await launchControlled(["-appdata", dir, source], {
        env: { ...process.env, SOLOKPDF_ENGINE: engine },
      });
      try {
        await client.waitForRenderIdle();
        const before = await query(client, "sign-state");
        const signed = await query(client, "sign", certPath, password, "", field, 0);
        if (!signed.startsWith("ok=1")) throw new Error(`${name}: sign: ${signed}`);

        // the Save that follows signing was cancelled; undo the signature
        await client.request(ControlCommand.TestInvokeCommand, ["CmdUndo"]);
        const undone = await query(client, "sign-state");
        if (count(undone, "pending") !== 0 || count(undone, "pos") !== count(before, "pos"))
          throw new Error(`${name}: undo kept the signer\nBEFORE ${before}\nAFTER ${undone}`);

        // its signer is gone, so redoing the step must not bring back an unsignable /V
        await client.request(ControlCommand.TestInvokeCommand, ["CmdRedo"]);
        if ((await query(client, "sign-state")) !== undone) throw new Error(`${name}: redo restored the signature`);

        const edit = await client.setFormField(1, 0, "AFTER");
        if (edit[0] !== 0) throw new Error(`${name}: edit: ${edit[1]}`);
        const edited = join(dir, `${name}-edited.pdf`);
        copyFileSync(source, edited);
        if ((await query(client, "sign-save", edited)) !== "saved") throw new Error(`${name}: save after undo failed`);
        const text = readFileSync(edited).toString("latin1");
        if (!text.includes("(AFTER)")) throw new Error(`${name}: edit not saved`);
        if (/\/ByteRange/.test(text)) throw new Error(`${name}: undone signature saved`);

        // signing again still works
        const again = await query(client, "sign", certPath, password, "", field, 0);
        if (!again.startsWith("ok=1")) throw new Error(`${name}: sign again: ${again}`);
        const signedPath = join(dir, `${name}-signed.pdf`);
        copyFileSync(edited, signedPath);
        if ((await query(client, "sign-save", signedPath)) !== "saved") throw new Error(`${name}: signed save failed`);
        verifyPdfSignature(signedPath, cert);
        console.log(`${name}: undo dropped the signer; edit saved; re-sign verified`);
      } finally {
        client.close();
        await killAndWait(proc);
      }
    }
    await checkEditAfterSign(engine, dir, certPath, cert);
  }
}

// Edits after signing go to a later increment. Undoing them must leave the
// signature undoable and, if kept, still written by the next save.
async function checkEditAfterSign(engine: string, dir: string, certPath: string, cert: TestCert): Promise<void> {
  const name = `${engine}-edit`;
  const source = join(dir, `${name}.pdf`);
  writeFileSync(source, fixture(false), "latin1");
  const { proc, client } = await launchControlled(["-appdata", dir, source], {
    env: { ...process.env, SOLOKPDF_ENGINE: engine },
  });
  const sign = async () => {
    const res = await query(client, "sign", certPath, password, "", "", 0);
    if (!res.startsWith("ok=1")) throw new Error(`${name}: sign: ${res}`);
  };
  const edit = async (value: string) => {
    if ((await client.setFormField(1, 0, value))[0] !== 0) throw new Error(`${name}: edit ${value} failed`);
  };
  const undo = () => client.request(ControlCommand.TestInvokeCommand, ["CmdUndo"]);
  try {
    await client.waitForRenderIdle();
    const before = await query(client, "sign-state");
    await sign();
    await edit("MID");
    await undo();
    await undo();
    const undone = await query(client, "sign-state");
    for (const key of ["pos", "pending", "fields", "sigflags"])
      if (count(undone, key) !== count(before, key))
        throw new Error(`${name}: undo left ${key}\nBEFORE ${before}\nAFTER ${undone}`);
    if (/\/V\s*\(MID\)/.test(undone)) throw new Error(`${name}: edit not undone`);

    await sign();
    await edit("DROPPED");
    await undo();
    const saved = join(dir, `${name}-signed.pdf`);
    copyFileSync(source, saved);
    if ((await query(client, "sign-save", saved)) !== "saved") throw new Error(`${name}: save failed`);
    const bytes = readFileSync(saved);
    const text = bytes.toString("latin1");
    const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*\d+\s+\d+\s+(\d+)\s+(\d+)\s*\]/g)];
    if (ranges.length !== 1) throw new Error(`${name}: expected one signature, got ${ranges.length}`);
    if (text.includes("(DROPPED)")) throw new Error(`${name}: undone edit saved`);
    const revision = join(dir, `${name}-revision.pdf`);
    writeFileSync(revision, bytes.subarray(0, Number(ranges[0][1]) + Number(ranges[0][2])));
    verifyPdfSignature(revision, cert);
    console.log(`${name}: undo through an edit reached the signature; a kept one saved after an undone edit`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
