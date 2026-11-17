// A theme change reaches every open window, without a list of windows to keep
// (E109): tool dialogs opened from the main window, modal and modeless, take
// the new theme's background and their texts leave the old theme's colors.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlClient, ControlCommand } from "./control.ts";
import { cmdId, pollUntil, runStandalone, tmpPath, SETTINGS_FILE, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, sendCommand } from "./win-automation.ts";
import { postMessage, WM_CLOSE } from "./winapi.ts";

const PDF = resolve(import.meta.dir, "issue-1189.pdf");

const SETTINGS = `UiLanguage = en
Theme = Dark
CheckForUpdates = false
RestoreSession = false
RememberOpenedFiles = false
`;

// modeless dialogs: all open at once
const kModeless = ["CmdNavigateFilesInFolder", "CmdPdfCompress", "CmdMergePDF", "CmdAdjustBrightness", "CmdHelpAbout"];

type Win = { hwnd: number; title: string; bg: string; want: string; texts: { col: string; s: string }[] };
type Dump = { colors: string[]; wins: Win[]; raw: string };

function parseDump(raw: string): Dump {
  const d: Dump = { colors: [], wins: [], raw };
  for (const line of raw.split("\n")) {
    const pal = /^palette text=(\w+) muted=(\w+) disabled=(\w+)/.exec(line);
    if (pal) {
      d.colors = [pal[1]!, pal[2]!, pal[3]!];
      continue;
    }
    const win = /^win hwnd=(\d+) title=(.*) bg=(\w+) want=(\w+)$/.exec(line);
    if (win) {
      d.wins.push({ hwnd: Number(win[1]), title: win[2]!, bg: win[3]!, want: win[4]!, texts: [] });
      continue;
    }
    const text = /^text col=(\w+) s=(.*)$/.exec(line);
    if (text && d.wins.length > 0) {
      d.wins[d.wins.length - 1]!.texts.push({ col: text[1]!, s: text[2]! });
    }
  }
  return d;
}

async function dump(client: ControlClient, ...args: string[]): Promise<Dump> {
  const res = await client.request(ControlCommand.TestThemeWindows, args.length > 0 ? args : ["dump"]);
  return parseDump(String(res[1] ?? ""));
}

async function waitForWins(client: ControlClient, n: number, what: string): Promise<Dump> {
  return pollUntil(
    () => dump(client),
    (d) => d.wins.length === n,
    { error: (d) => `theme-open-windows: ${what}: ${d.wins.length} windows, want ${n}:\n${d.raw}` },
  );
}

// every window on its surface's color, no text in a color only the old theme had
function staleIn(before: Dump, after: Dump): string[] {
  const oldOnly = before.colors.filter((c) => !after.colors.includes(c));
  const errs: string[] = [];
  for (const w of after.wins) {
    if (w.bg !== w.want) {
      errs.push(`'${w.title}' bg=${w.bg} want=${w.want}`);
    }
    for (const t of w.texts) {
      if (oldOnly.includes(t.col)) {
        errs.push(`'${w.title}' text '${t.s}' kept ${t.col}`);
      }
    }
  }
  return errs;
}

async function switchTheme(client: ControlClient, theme: string): Promise<void> {
  const before = await dump(client);
  const after = await dump(client, "set", theme);
  if (after.colors.join() === before.colors.join()) {
    throw new Error(`theme-open-windows: ${theme} kept the palette:\n${after.raw}`);
  }
  const errs = staleIn(before, after);
  if (errs.length > 0) {
    throw new Error(`theme-open-windows: ${theme} did not reach:\n  ${errs.join("\n  ")}`);
  }
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP theme-open-windows: Win32 windows");
    return;
  }
  const dir = tmpPath("theme-open-windows");
  rmSync(dir, { recursive: true, force: true });
  const appdata = join(dir, "appdata");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), SETTINGS);

  const { proc, client, frame } = await launchControlled(["-appdata", appdata, PDF]);
  try {
    await client.waitForRenderIdle();
    const base = await dump(client);
    const n = base.wins.length;

    // a modal dialog: the theme can change under it (settings reload, system theme)
    sendCommand(frame, cmdId("CmdZoomCustom"));
    const modal = await waitForWins(client, n + 1, "CmdZoomCustom");
    await switchTheme(client, "Light");
    const zoom = modal.wins.find((w) => !base.wins.some((b) => b.hwnd === w.hwnd))!;
    postMessage(zoom.hwnd, WM_CLOSE, 0, 0);
    await waitForWins(client, n, "closing Zoom");

    for (const [i, cmd] of kModeless.entries()) {
      sendCommand(frame, cmdId(cmd));
      await waitForWins(client, n + i + 1, cmd);
    }
    await switchTheme(client, "Dark");
    console.log("theme-open-windows: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
