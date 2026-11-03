import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { runStandalone, SLOW_BUILD_FACTOR, tmpPath, USE_NG } from "./util.ts";
import { clipboardSeqNo, sleep } from "./winapi.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP ad-hoc-b67-clipboard: original app only");
    return;
  }
  const before = clipboardSeqNo();
  const markdown = tmpPath("b67-copy.md");
  const selection = "B67 Markdown browser copy";
  writeFileSync(markdown, `# ${selection}\n`);
  const { proc, client } = await launchControlled([markdown], { env: { SOLOKPDF_REAL_CLIPBOARD: "0" } });
  try {
    const value = "B67 process-local clipboard";
    const set = await client.request(ControlCommand.TestClipboardText, ["set", value]);
    if (String(set[1] ?? "") !== value) throw new Error("test clipboard set failed");
    const get = await client.request(ControlCommand.TestClipboardText, ["get"]);
    if (String(get[1] ?? "") !== value) throw new Error("test clipboard get failed");
    const data = "1400000000000000000000000000000001000000610000000000";
    const put = await client.request(ControlCommand.TestClipboardFormat, ["set", 15, data]);
    if (put[0] !== 0) throw new Error("test clipboard format set failed");
    const formats = await client.request(ControlCommand.TestClipboardFormat, ["list"]);
    if (String(formats[1] ?? "") !== "13,15") throw new Error(`test clipboard formats: ${formats[1]}`);
    const read = await client.request(ControlCommand.TestClipboardFormat, ["get", 15]);
    if (String(read[1] ?? "") !== data) throw new Error("test clipboard format data changed");
    for (const name of ["HTML Format", "Rich Text Format"]) {
      const registered = await client.request(ControlCommand.TestClipboardFormat, ["register", name]);
      const format = Number(registered[1]);
      if (registered[0] !== 0 || format < 0xc000) throw new Error(`test clipboard register ${name} failed`);
      const payload = Buffer.from(name, "utf8").toString("hex");
      const set = await client.request(ControlCommand.TestClipboardFormat, ["set", format, payload]);
      const get = await client.request(ControlCommand.TestClipboardFormat, ["get", format]);
      if (set[0] !== 0 || !String(get[1] ?? "").startsWith(payload)) throw new Error(`test clipboard ${name} changed`);
    }
    const dib = Buffer.alloc(44);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(1, 4);
    dib.writeInt32LE(-1, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    dib.set([0, 0, 255, 255], 40);
    const bitmap = dib.toString("hex");
    const setBitmap = await client.request(ControlCommand.TestClipboardFormat, ["set", 2, bitmap]);
    if (setBitmap[0] !== 0) throw new Error("test bitmap set failed");
    const getBitmap = await client.request(ControlCommand.TestClipboardFormat, ["get", 2]);
    const copiedBitmap = Buffer.from(String(getBitmap[1] ?? ""), "hex");
    if (
      copiedBitmap.length !== dib.length ||
      copiedBitmap.readInt32LE(4) !== 1 ||
      copiedBitmap.readInt32LE(8) !== -1 ||
      !copiedBitmap.subarray(40, 43).equals(dib.subarray(40, 43))
    )
      throw new Error("test bitmap changed");
    const deadline = Date.now() + 30000 * SLOW_BUILD_FACTOR;
    let ready = false;
    while (Date.now() < deadline) {
      const res = await client.request(ControlCommand.TestMarkdownTocNavigate, [0, 0]);
      if (res[0] === 0 && String(res[1] ?? "").startsWith("OK scrollX=")) {
        ready = true;
        break;
      }
      await sleep(100);
    }
    if (!ready) throw new Error("Markdown browser not ready");
    await client.request(ControlCommand.TestInvokeCommand, ["CmdSelectAll"]);
    await client.request(ControlCommand.TestInvokeCommand, ["CmdCopySelection"]);
    let copied = "";
    const copyDeadline = Date.now() + 10000 * SLOW_BUILD_FACTOR;
    while (Date.now() < copyDeadline) {
      const get = await client.request(ControlCommand.TestClipboardText, ["get"]);
      copied = String(get[1] ?? "");
      if (copied.includes(selection)) break;
      await sleep(100);
    }
    if (!copied.includes(selection)) throw new Error(`Markdown Copy did not reach local clipboard: ${copied}`);
  } finally {
    client.close();
    await killAndWait(proc);
  }
  const after = clipboardSeqNo();
  if (after !== before) throw new Error(`system clipboard changed: ${before} -> ${after}`);
  console.log(`PASS B67: system clipboard sequence ${before} -> ${after}`);
}

if (import.meta.main) await runStandalone(testit);
