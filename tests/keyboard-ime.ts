import { writeFileSync } from "node:fs";
import { ControlCommand } from "./control.ts";
import { IS_WIN } from "./host.ts";
import { cmdId, makeBlankPdf, runStandalone, tmpPath, USE_NG, writeAppdata } from "./util.ts";
import {
  activateTestFrame,
  canActivateTestFrame,
  killAndWait,
  launchControlled,
  pressKey,
  sendCommandSync,
  waitForFocusClass,
} from "./win-automation.ts";
import { getControlText, sendText, sleep } from "./winapi.ts";

export async function testit(): Promise<void> {
  if (!IS_WIN || USE_NG || !canActivateTestFrame()) {
    console.log("SKIP keyboard-ime: Win32 app on a hidden desktop or CI required");
    return;
  }
  const pdf = tmpPath("keyboard-ime.pdf");
  writeFileSync(pdf, makeBlankPdf());
  const data = writeAppdata("keyboard-ime-appdata", "VimKeys = true\nRestoreSession = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", data, pdf]);
  const request = async (action: string, key = "") => {
    const [code, value] = await client.request(ControlCommand.TestVimKeys, [action, key]);
    return { code: Number(code), value: String(value) };
  };
  const expect = async (action: string, pattern: RegExp) => {
    const res = await request(action);
    if (res.code !== 0 || !pattern.test(res.value)) throw new Error(`${action}: ${res.code} ${res.value}`);
    return res.value;
  };
  const waitComposition = async (composing: number) => {
    for (let i = 0; i < 80; i++) {
      const res = await request("ime-state");
      if (res.code === 0 && res.value.includes(`composing=${composing} bytes=4 text=かな`)) return;
      await sleep(50);
    }
    throw new Error(`composition did not start: ${(await request("ime-state")).value}`);
  };
  try {
    await client.waitForRenderIdle();
    await activateTestFrame(client);
    sendCommandSync(frame, cmdId("CmdFindFirst"));
    const find = await waitForFocusClass(frame, "Edit");
    const started = await request("ime-start");
    if (started.code === 2 && process.env.SOLOKPDF_REQUIRE_JAPANESE_IME !== "1") {
      console.log(`SKIP keyboard-ime: ${started.value}`);
      return;
    }
    if (started.code !== 0) throw new Error(`find ime-start: ${started.value}`);
    try {
      await waitComposition(0);
      await expect("ime-cancel", /ok=1/);
      await sleep(100);
      if (getControlText(find) !== "") throw new Error(`find cancel: ${getControlText(find)}`);
    } finally {
      await expect("ime-close", /ok=1/);
    }
    await expect("ime-start", /ok=1/);
    try {
      await waitComposition(0);
      await expect("ime-commit", /ok=1/);
      for (let i = 0; i < 40 && getControlText(find) !== "かな"; i++) await sleep(50);
      if (getControlText(find) !== "かな") throw new Error(`find commit: ${getControlText(find)}`);
    } finally {
      await expect("ime-close", /ok=1/);
    }

    await activateTestFrame(client);
    await request("key", ":");
    let state = (await request("state")).value;
    let edit = Number(/edit=(\d+)/.exec(state)?.[1] ?? 0);
    if (!edit) throw new Error(`vim command did not open: ${state}`);
    sendText(edit, ":1");
    await pressKey(edit, 0x0d);
    await activateTestFrame(client);
    await request("key", ":");
    state = (await request("state")).value;
    edit = Number(/edit=(\d+)/.exec(state)?.[1] ?? 0);
    if (!edit) throw new Error(`vim command did not reopen: ${state}`);
    await expect("ime-start", /ok=1/);
    try {
      await waitComposition(1);
      const before = getControlText(edit);
      await pressKey(edit, 0x26);
      await pressKey(edit, 0x28);
      await pressKey(edit, 0x1b);
      await pressKey(edit, 0x0d);
      await waitComposition(1);
      state = (await request("state")).value;
      if (getControlText(edit) !== before || !state.includes(`edit=${edit}`)) {
        throw new Error(`IME keys changed Vim command: ${state}`);
      }
      await expect("ime-cancel", /ok=1/);
      await sleep(100);
      if (getControlText(edit) !== before) throw new Error("IME cancel changed Vim command text");
    } finally {
      await expect("ime-close", /ok=1/);
    }
    await expect("ime-start", /ok=1/);
    try {
      await waitComposition(1);
      await expect("ime-commit", /ok=1/);
      for (let i = 0; i < 40 && !getControlText(edit).includes("かな"); i++) await sleep(50);
      state = (await request("state")).value;
      if (!getControlText(edit).includes("かな") || !state.includes(`edit=${edit}`)) {
        throw new Error(`vim commit failed: text=${getControlText(edit)} ${state}`);
      }
    } finally {
      await expect("ime-close", /ok=1/);
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
