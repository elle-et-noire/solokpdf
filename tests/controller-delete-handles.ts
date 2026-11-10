import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { cmdId, EXE, makeTextPdf, pollUntil, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import {
  enumWindows,
  getClassName,
  getWindowPid,
  processGuiResources,
  sendCopyDataW,
  sendMessage,
  WM_CLOSE,
} from "./winapi.ts";
import { FRAME_CLASS, sendCommandSync, waitForFrame } from "./win-automation.ts";

const kCopyDataDdeW = 0x44646557;
const kCycles = 24;
const kWarmupCycles = 6;
const kHandleTolerance = 8;
type State = { held: number; pending: number };

async function state(client: ControlClient, action = "state"): Promise<State | null> {
  const res = await client.request(ControlCommand.TestControllerDelete, [action]);
  if (res[0] !== 0) throw new Error(`controller-delete: ${res[1]}`);
  if (res[1] === "unsupported") return null;
  const match = /^held=(\d+) pending=(\d+)$/.exec(String(res[1]));
  if (!match) throw new Error(`controller-delete state: ${res[1]}`);
  return { held: Number(match[1]), pending: Number(match[2]) };
}

async function settled(client: ControlClient, pid: number): Promise<number> {
  await pollUntil(
    () => state(client),
    (s) => s?.held === 0 && s.pending === 0,
    { error: (s) => `controller deletes did not finish: ${JSON.stringify(s)}` },
  );
  await client.waitForRenderIdle();
  let handles = Infinity;
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(20);
    handles = Math.min(handles, processGuiResources(pid).handles);
  }
  return handles;
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("SKIP controller-delete-handles: original Windows controller path");
    return;
  }
  const dir = tmpPath("controller-delete-handles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "UseTabs = true\nShowToc = false\nReloadModifiedDocuments = false\n");
  const keeper = join(dir, "keeper.pdf");
  const target = join(dir, "target.pdf");
  writeFileSync(keeper, makeTextPdf("Keep the frame alive"));
  writeFileSync(target, makeTextPdf("Close this document while rendering"));
  const errors: string[] = [];

  for (const engine of ["mupdf", "pdfium"]) {
    await withControlledSumatra(
      EXE,
      async (client, proc) => {
        const frame = await waitForFrame(proc.pid);
        await client.waitForRenderIdle();
        if (!(await state(client))) {
          console.log("SKIP controller-delete-handles: render barrier requires Debug");
          return;
        }
        async function cycle(mode: "idle" | "rendering"): Promise<number> {
          try {
            if (mode === "rendering") await state(client, "hold");
            if (!sendCopyDataW(frame, kCopyDataDdeW, `[Open("${target}", 0, 1, 0)]`)) {
              throw new Error("could not open target");
            }
            if (mode === "rendering") {
              await pollUntil(
                () => state(client),
                (s) => !!s && s.held > 0,
                { error: "target renderer did not reach the barrier" },
              );
            } else {
              await client.waitForRenderIdle();
            }
            sendCommandSync(frame, cmdId("CmdClose"));
            const after = await state(client);
            const expected = mode === "rendering" ? 1 : 0;
            if (after?.pending !== expected) {
              throw new Error(`${engine} ${mode}: expected ${expected} pending delete, got ${JSON.stringify(after)}`);
            }
            const tab = await client.request(ControlCommand.TestCurrentTab);
            if (tab[0] !== 0 || !String(tab[1]).includes(keeper)) throw new Error(`keeper tab lost: ${tab[1]}`);
          } finally {
            await state(client, "release");
          }
          return settled(client, proc.pid);
        }

        try {
          for (const mode of ["idle", "rendering"] as const) {
            for (let i = 0; i < kWarmupCycles; i++) await cycle(mode);
            const before = await settled(client, proc.pid);
            let after = before;
            for (let i = 0; i < kCycles; i++) after = await cycle(mode);
            const growth = after - before;
            console.log(
              `${engine} ${mode}: ${kCycles} closes, handles ${before} -> ${after} (${growth >= 0 ? "+" : ""}${growth})`,
            );
            if (growth > kHandleTolerance) errors.push(`${engine} ${mode}: leaked ${growth} handles`);
          }

          sendCommandSync(frame, cmdId("CmdNewWindow"));
          const second = await pollUntil(
            () => {
              let found = 0;
              enumWindows((hwnd) => {
                if (hwnd !== frame && getWindowPid(hwnd) === proc.pid && getClassName(hwnd) === FRAME_CLASS)
                  found = hwnd;
                return !found;
              });
              return found;
            },
            (hwnd) => hwnd !== 0,
            { error: "second frame did not open" },
          );
          await state(client, "hold");
          if (!sendCopyDataW(frame, kCopyDataDdeW, `[Open("${target}", 0, 1, 0)]`))
            throw new Error("open before window close failed");
          await pollUntil(
            () => state(client),
            (s) => !!s && s.held > 0,
          );
          sendMessage(frame, WM_CLOSE, 0, 0);
          const closing = await state(client);
          if (getWindowPid(frame) !== 0 || closing?.pending !== 1) {
            throw new Error(`frame was not destroyed during pending deletion: ${JSON.stringify(closing)}`);
          }
          await state(client, "release");
          if (!sendCopyDataW(second, kCopyDataDdeW, `[Open("${keeper}", 0, 1, 0)]`))
            throw new Error("surviving window open failed");
          await settled(client, proc.pid);
          console.log(`${engine}: pending delete completed after its frame was destroyed`);
        } finally {
          await state(client, "release");
        }
      },
      ["-appdata", dir, "-log-to-file", join(dir, `${engine}.log`), keeper],
      { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
    );
  }
  if (errors.length) throw new Error(errors.join("; "));
}

if (import.meta.main) {
  await runStandalone(testit);
}
