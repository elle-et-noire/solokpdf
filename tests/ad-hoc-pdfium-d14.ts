import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { EXE, makeTopBottomPdf, pollUntil, runStandalone, tmpPath } from "./util.ts";

export async function testit(): Promise<void> {
  const plain = tmpPath("d14-plain.pdf");
  const encrypted = tmpPath("d14-encrypted.pdf");
  const password = "d14-password";
  writeFileSync(plain, makeTopBottomPdf(2));
  const encrypt = Bun.spawnSync([EXE, "clean", "-E", "aes-256", "-U", password, "-O", "owner", plain, encrypted]);
  assert.equal(encrypt.exitCode, 0, encrypt.stderr.toString());
  for (const src of [plain, encrypted]) {
    const cropped = `${src}.cropped.pdf`;
    const extracted = `${src}.extracted.pdf`;
    const image = `${src}-1.png`;
    for (const path of [cropped, extracted, image]) rmSync(path, { force: true });
    await withControlledSumatra(
      EXE,
      async (client) => {
        await client.waitForRenderIdle();
        const invoke = async (command: string) => {
          const result = await client.request(ControlCommand.TestInvokeCommand, [command]);
          assert.equal(result[0], 0, String(result[1]));
        };
        const pdfium = process.env.SOLOKPDF_ENGINE !== "mupdf";
        await client.request(ControlCommand.TestCurrentPdf, ["page 1 top"]);
        if (pdfium) {
          assert.equal((await client.request(ControlCommand.TestCurrentPdf, ["editor"]))[1], "editor=none");
        }
        const images = await client.request(ControlCommand.TestConvertToImages, [`${src}-<N>.png`, "1", 72]);
        assert.equal(images[0], 0, String(images[1]));
        assert.ok(existsSync(image), "Convert to Images wrote nothing");
        if (pdfium) {
          assert.equal((await client.request(ControlCommand.TestCurrentPdf, ["editor"]))[1], "editor=none");
        }
        const extract = await client.request(ControlCommand.TestExtractPages, [extracted, "2", 0]);
        assert.equal(extract[0], 0, String(extract[1]));
        assert.ok(existsSync(extracted), "Extract Pages wrote nothing");
        await invoke("CmdToggleTrimEmptyMargins");
        await client.request(ControlCommand.TestSaveFileName, [cropped]);
        await invoke("CmdSaveTrimmedPagesAs");
        await pollUntil(() => existsSync(cropped), Boolean);
      },
      ["-pwd", password, src],
    );
    for (const path of [cropped, extracted]) {
      if (src === encrypted) assert.ok(readFileSync(path).includes("/Encrypt"), "export lost encryption");
      const reopened = `${path}.plain.pdf`;
      const result = Bun.spawnSync([EXE, "clean", "-p", password, "-D", path, reopened]);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.ok(readFileSync(reopened, "latin1").match(/\/Type\s*\/Page\b/), "export has no pages");
    }
  }
}

if (import.meta.main) await runStandalone(testit);
