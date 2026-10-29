import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { createFakeFrame, enumWindows, getClassName, sleep } from "./winapi.ts";

const kSumatraFrame = "SUMATRA_PDF_FRAME";
const kSolokFrame = "SOLOK_PDF_FRAME";

export async function testit(): Promise<void> {
  const dir = tmpPath("solok-coexist");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SolokPDF-settings.txt"),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\n",
  );
  const pdf = (name: string) => {
    const path = join(dir, name);
    writeFileSync(
      path,
      assemblePdf([
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
      ]),
      "latin1",
    );
    return path;
  };
  const first = pdf("first.pdf");
  const reuse = pdf("reuse.pdf");
  const dde = pdf("dde.pdf");
  const { proc, client, frame } = await launchControlled(["-appdata", dir, first]);
  let fake: ReturnType<typeof createFakeFrame> | undefined;
  try {
    await client.waitForRenderIdle();
    fake = createFakeFrame(kSumatraFrame);
    const frames: number[] = [];
    enumWindows((hwnd) => {
      if (getClassName(hwnd) === kSumatraFrame) frames.push(hwnd);
      return true;
    });
    if (frames[0] !== fake.hwnd) throw new Error("fake SumatraPDF window was not first");
    const forward = async (args: string[], path: string) => {
      const child = Bun.spawn([EXE, "-appdata", dir, ...args], { stdout: "ignore", stderr: "ignore" });
      let exited = false;
      void child.exited.then(() => {
        exited = true;
      });
      const deadline = Date.now() + 10000;
      while (!exited && Date.now() < deadline) {
        fake!.pump();
        await sleep(10);
      }
      if (!exited) throw new Error(`${args[0]} did not exit`);
      for (let i = 0; i < 100; i++) {
        fake!.pump();
        const result = await client.request(ControlCommand.TestCurrentTab);
        if (String(result[1] ?? "").includes(path)) return;
        await sleep(30);
      }
      throw new Error(`${args[0]} did not reach SolokPDF; fake received ${fake!.copyDataCount()} messages`);
    };
    await forward(["-reuse-instance", reuse], reuse);
    await forward(["-dde", `[Open("${dde}")]`], dde);
    if (fake.copyDataCount() !== 0) throw new Error(`SumatraPDF fake received ${fake.copyDataCount()} messages`);
    if (getClassName(frame) !== kSolokFrame) throw new Error(`SolokPDF frame class is ${getClassName(frame)}`);
    await client.quit();
    await proc.exited;
  } catch (e) {
    await killAndWait(proc);
    throw e;
  } finally {
    fake?.close();
  }
}

if (import.meta.main) await runStandalone(testit);
