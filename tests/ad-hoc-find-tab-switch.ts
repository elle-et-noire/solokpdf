// E74: a find that ends after its tab stopped being current left the document's TextSearch calling back
// into the deleted find data. The next search on that document read freed memory (monkey seed 7 crash).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, takeStderr } from "./win-automation.ts";
import { sendCopyDataW } from "./winapi.ts";

const kDdeCopyData = 0x44646557;

export async function testit(): Promise<void> {
  const a = tmpPath("find-tab-switch-a.pdf");
  const b = tmpPath("find-tab-switch-b.pdf");
  const log = tmpPath("find-tab-switch.log");
  writeFileSync(a, makeTextPdf("alpha page"));
  writeFileSync(b, makeTextPdf("beta page"));
  rmSync(log, { force: true });

  const { proc, client, frame } = await launchControlled(["-log-to-file", log, a, b]);
  try {
    await client.waitForRenderIdle();

    // Search starts a find on A's tab; Open switches to B before the find's end task runs
    if (!sendCopyDataW(frame, kDdeCopyData, `[Search("${a}","zzz")][Open("${b}", 0, 1, 0)]`)) {
      throw new Error("DDE search failed");
    }
    const onB = await client.selectTab();
    if (onB.idx !== 1) throw new Error(`expected tab B current, got ${onB.idx}`);
    await client.selectTab(0);

    // searches A's TextSearch, which still held the ended find's progress callback
    let res;
    try {
      res = await client.request(ControlCommand.TestCurrentPdf, ["search-first", "alpha"]);
    } catch (e) {
      const stderr = await takeStderr(proc);
      throw new Error(`app died on search after tab switch: ${e}\n${stderr.slice(-6000)}`);
    }
    if (res[0] !== 0 || !String(res[1]).startsWith("found=1")) {
      throw new Error(`search-first: ${res[0]} ${res[1]}`);
    }
    const text = readFileSync(log, "utf8");
    if (text.includes("isMainWindowValid: 0")) throw new Error("search called the ended find's callback");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
