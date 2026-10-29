// Building Bookmarks from numbered headings (#5724) is opt-in since #6227:
// off by default, CmdAutoGenerateTOC does it on demand for the open document.
//
// Run: bun tests/issue-6227.ts [--no-build]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlClient, ControlCommand } from "./control.ts";
import { cmdId, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, sendCommand } from "./win-automation.ts";
import { sleep } from "./winapi.ts";
import { makePdf } from "./issue-5724.ts";

// exit code and text of navigating to the first TOC entry of the open document
async function firstTocEntry(client: ControlClient): Promise<{ code: number; text: string }> {
  const res = await client.request(ControlCommand.TestTocNavigate, [1]);
  return { code: typeof res[0] === "number" ? res[0] : -1, text: String(res[1] ?? "").trim() };
}

export async function testit(): Promise<void> {
  const dir = tmpPath("issue-6227");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "no-outline.pdf");
  writeFileSync(pdf, makePdf({ outlines: false }));

  for (const engine of ["mupdf", "pdfium"]) {
    const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf], {
      env: { SOLOKPDF_ENGINE: engine },
    });
    try {
      await client.waitForRenderIdle();
      const before = await firstTocEntry(client);
      if (before.code === 0) {
        throw new Error(`issue-6227 (${engine}): TOC was generated without AutoGenerateTOC: ${before.text}`);
      }

      const vis = await client.request(ControlCommand.TestCommandVisibility, ["CmdAutoGenerateTOC", "palette"]);
      if (!String(vis[1] ?? "").includes("vis=show")) {
        throw new Error(`issue-6227 (${engine}): command hidden: ${vis[1]}`);
      }
      sendCommand(frame, cmdId("CmdAutoGenerateTOC"));
      const deadline = Date.now() + 10_000;
      let after = await firstTocEntry(client);
      while (after.code !== 0 && Date.now() < deadline) {
        await sleep(100);
        after = await firstTocEntry(client);
      }
      if (after.code !== 0) {
        throw new Error(`issue-6227 (${engine}): CmdAutoGenerateTOC did not build a TOC: ${after.text}`);
      }
      console.log(`issue-6227 (${engine}): ${after.text}`);
    } finally {
      try {
        await client.quit();
      } catch {
        await killAndWait(proc);
      }
      client.close();
      await proc.exited;
    }
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
