import { ControlCommand, type ControlClient } from "./control.ts";
import { IS_MAC } from "./host.ts";
import { USE_NG } from "./util.ts";
import { emptyClipboard, getClipboardText, setClipboardText } from "./winapi.ts";

export function canTestClipboard(name: string): boolean {
  if (!USE_NG || process.env.CI || process.env.GITHUB_ACTIONS || process.env.SOLOKPDF_REAL_CLIPBOARD === "1") {
    return true;
  }
  console.log(`SKIP ${name}: ng clipboard needs CI or SOLOKPDF_REAL_CLIPBOARD=1`);
  return false;
}

export function canUseRealClipboard(name: string): boolean {
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.SOLOKPDF_REAL_CLIPBOARD === "1") {
    return true;
  }
  console.log(`SKIP ${name}: system clipboard check needs CI or SOLOKPDF_REAL_CLIPBOARD=1`);
  return false;
}

function localClipboard(): boolean {
  return !USE_NG && process.env.SOLOKPDF_REAL_CLIPBOARD !== "1";
}

export async function setTestClipboardText(client: ControlClient, value: string): Promise<void> {
  if (localClipboard()) {
    const res = await client.request(ControlCommand.TestClipboardText, ["set", value]);
    if (res[0] !== 0) throw new Error(`test clipboard set: ${res[1]}`);
    return;
  }
  if (IS_MAC) {
    const res = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(value), stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) throw new Error(`pbcopy: ${res.stderr}`);
  } else if (!setClipboardText(value)) {
    throw new Error("setClipboardText failed");
  }
}

export async function getTestClipboardText(client: ControlClient): Promise<string> {
  if (localClipboard()) {
    const res = await client.request(ControlCommand.TestClipboardText, ["get"]);
    if (res[0] !== 0) throw new Error(`test clipboard get: ${res[1]}`);
    return String(res[1] ?? "");
  }
  if (IS_MAC) {
    const res = Bun.spawnSync(["pbpaste"], { stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) throw new Error(`pbpaste: ${res.stderr}`);
    return res.stdout.toString();
  }
  return getClipboardText(2000);
}

export async function clearTestClipboard(client: ControlClient): Promise<void> {
  if (localClipboard()) {
    const res = await client.request(ControlCommand.TestClipboardText, ["clear"]);
    if (res[0] !== 0) throw new Error(`test clipboard clear: ${res[1]}`);
    return;
  }
  if (!emptyClipboard()) throw new Error("emptyClipboard failed");
}

export async function setTestClipboardData(client: ControlClient, format: number, data: Uint8Array): Promise<void> {
  const hex = Buffer.from(data).toString("hex");
  const res = await client.request(ControlCommand.TestClipboardFormat, ["set", format, hex]);
  if (res[0] !== 0) throw new Error(`test clipboard format ${format}: ${res[1]}`);
}

export async function getTestClipboardData(client: ControlClient, format: number): Promise<Uint8Array> {
  const res = await client.request(ControlCommand.TestClipboardFormat, ["get", format]);
  if (res[0] !== 0) throw new Error(`test clipboard format ${format}: ${res[1]}`);
  return Buffer.from(String(res[1] ?? ""), "hex");
}
