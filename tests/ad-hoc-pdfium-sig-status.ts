import { writeFileSync } from "node:fs";
import { ControlCommand, type ControlClient, withControlledSumatra } from "./control.ts";
import { makeCert, writeEutlCache, writeSignedPdf } from "./pki-chain.ts";
import { cmdId, EXE, makeTextPdf, runStandalone, tmpPath, writeAppdata } from "./util.ts";
import { sendCommandSync, waitForFrame } from "./win-automation.ts";

async function editor(client: ControlClient): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, ["editor"]);
  return String(res[1] ?? "");
}

export async function testit(): Promise<void> {
  const plain = tmpPath("d6-plain.pdf");
  writeFileSync(plain, makeTextPdf("unsigned"));
  const appdata = writeAppdata("d6-signatures", "RestoreSession = false\nCheckForUpdates = false\n");
  writeEutlCache(appdata, []);

  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const state = String((await client.request(ControlCommand.TestSignatureStatus, []))[1] ?? "");
      if (!state.includes("rows=0") || (await editor(client)) !== "editor=none") {
        throw new Error(`unsigned PDF loaded editor or showed signatures: ${state}`);
      }
    },
    ["-appdata", appdata, plain],
  );

  const signed = tmpPath("d6-signed.pdf");
  writeSignedPdf(signed, { signer: makeCert({ name: "D6 signer" }), rect: [50, 50, 200, 100] });
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const state = String((await client.request(ControlCommand.TestSignatureStatus, []))[1] ?? "");
        if (state.includes("rows=1")) {
          const wantEditor = process.env.SOLOKPDF_ENGINE === "mupdf" ? "editor=none" : "editor=loaded";
          if ((await editor(client)) !== wantEditor) throw new Error(`signed PDF editor state differs from ${wantEditor}`);
          sendCommandSync(await waitForFrame(proc.pid!), cmdId("CmdShowSignatures"));
          const shown = String((await client.request(ControlCommand.TestSignatureStatus, []))[1] ?? "");
          if (!shown.includes("panel=1")) throw new Error(`CmdShowSignatures did not open panel: ${shown}`);
          return;
        }
        if (Date.now() > deadline) throw new Error(`signature list missing: ${state}`);
        await Bun.sleep(50);
      }
    },
    ["-appdata", appdata, signed],
  );
}

if (import.meta.main) await runStandalone(testit);
