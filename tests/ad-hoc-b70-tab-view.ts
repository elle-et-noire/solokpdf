import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { makeTopBottomPdf, runStandalone, SETTINGS_FILE, tmpPath } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";
import { sleep } from "./winapi.ts";

async function request(
  client: ControlClient,
  command: ControlCommand,
  args: (string | number)[] = [],
): Promise<string> {
  const [code, value] = await client.request(command, args);
  if (code !== 0) throw new Error(`${command}: ${value}`);
  return String(value);
}

async function view(client: ControlClient): Promise<string> {
  return [
    await request(client, ControlCommand.TestCurrentTab),
    await request(client, ControlCommand.TestCurrentPdf, ["zoom"]),
    await request(client, ControlCommand.TestScrollState),
  ].join(" ");
}

async function invoke(client: ControlClient, name: string): Promise<void> {
  await request(client, ControlCommand.TestInvokeCommand, [name]);
}

async function check(engine: string): Promise<void> {
  const dir = tmpPath(`b70-tab-view-${engine}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const first = join(dir, "first.pdf");
  const second = join(dir, "second.pdf");
  writeFileSync(first, makeTopBottomPdf(3));
  writeFileSync(second, makeTopBottomPdf(3));
  writeFileSync(join(dir, SETTINGS_FILE), "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\n");
  const { proc, client } = await launchControlled(["-appdata", dir, first, second], {
    saveSettings: true,
    env: { SOLOKPDF_ENGINE: engine },
  });
  try {
    await client.waitForRenderIdle();
    for (let i = 0; i < 6; i++) await invoke(client, "CmdZoomIn");
    await request(client, ControlCommand.TestFavoriteNav, ["goto", 2]);
    await invoke(client, "CmdScrollDown");
    await sleep(150);
    const secondBefore = await view(client);
    await invoke(client, "CmdPrevTab");
    for (let i = 0; i < 7; i++) await invoke(client, "CmdZoomIn");
    await request(client, ControlCommand.TestFavoriteNav, ["goto", 3]);
    await invoke(client, "CmdScrollDown");
    await sleep(150);
    const firstBefore = await view(client);
    for (const state of [firstBefore, secondBefore]) {
      const y = / y=([-\d.]+)/.exec(state);
      if (!y || Number(y[1]) <= 0) throw new Error(`page was not scrolled: ${state}`);
    }

    await invoke(client, "CmdOptions");
    const changed = await request(client, ControlCommand.TestAdvSettingsRows, ["toggle-common", 4]);
    if (!changed.includes("UseTabs=false")) throw new Error(`UseTabs: ${changed}`);
    await request(client, ControlCommand.TestAdvSettingsRows, ["save", 0]);
    const firstAfter = await view(client);
    if (firstAfter !== firstBefore) throw new Error(`${engine} first tab: ${firstBefore} -> ${firstAfter}`);
    await invoke(client, "CmdNextTab");
    const secondAfter = await view(client);
    if (secondAfter !== secondBefore) throw new Error(`${engine} second tab: ${secondBefore} -> ${secondAfter}`);
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  await check("pdfium");
  await check("mupdf");
}

if (import.meta.main) await runStandalone(testit);
