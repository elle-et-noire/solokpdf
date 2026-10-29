import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

const userPassword = "user-password";
const ownerPassword = "owner-password";
const denied = ["printing document", "copying text", "adding annotations", "filling forms"];

function fixture(): string {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [20 20 180 50] /P 3 0 R >>",
  ]);
}

async function properties(
  path: string,
  appdata: string,
  engine: string,
  password: string,
): Promise<{ text: string; print: string; form: string }> {
  return withControlledSumatra(
    EXE,
    async (client) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const res = await client.request(ControlCommand.TestDocumentProperties);
        if (res[0] === 0) {
          const print = await client.request(ControlCommand.TestCommandVisibility, ["CmdPrint", "menu"]);
          const form = await client.request(ControlCommand.TestSetFormField, [1, 0, "filled"]);
          return {
            text: String(res[1] ?? ""),
            print: String(print[1] ?? ""),
            form: String(form[1] ?? ""),
          };
        }
        await Bun.sleep(100);
      }
      throw new Error(`${engine}: document did not open`);
    },
    ["-appdata", appdata, "-pwd", password, path],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  const dir = tmpPath("pdfium-permissions");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const plain = join(dir, "plain.pdf");
  writeFileSync(plain, fixture(), "latin1");

  for (const [name, flags, expectedUser] of [
    ["restricted", "0", denied],
    ["print-only", "4", denied.slice(1)],
  ] as const) {
    const encrypted = join(dir, `${name}.pdf`);
    const clean = Bun.spawnSync([
      EXE,
      "clean",
      "-E",
      "aes-256",
      "-U",
      userPassword,
      "-O",
      ownerPassword,
      "-P",
      flags,
      plain,
      encrypted,
    ]);
    if (clean.exitCode !== 0) throw new Error(`Cannot encrypt ${name}: ${clean.stderr.toString()}`);

    for (const engine of ["pdfium", "mupdf"]) {
      for (const [role, password, expected] of [
        ["user", userPassword, expectedUser],
        ["owner", ownerPassword, []],
      ] as const) {
        const appdata = join(dir, `${name}-${engine}-${role}`);
        mkdirSync(appdata);
        const result = await properties(encrypted, appdata, engine, password);
        const line = result.text.split(/\r?\n/).find((l) => l.startsWith("deniedPermissions=")) ?? "";
        const actual = line.replace("deniedPermissions=", "").trim();
        const want = expected.join(", ");
        if (actual !== want) throw new Error(`${name} ${engine} ${role}: denied "${actual}", want "${want}"`);
        if (!result.print.includes("vis=show")) throw new Error(`${name} ${engine} ${role}: ${result.print}`);
        if (!result.form.includes("OK before=")) throw new Error(`${name} ${engine} ${role}: ${result.form}`);
      }
    }
  }
}

if (import.meta.main) await runStandalone(testit);
