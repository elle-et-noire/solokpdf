import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { makeTextPdf, pollUntil, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, takeStderr, waitForExit } from "./win-automation.ts";
import { sendCopyDataW } from "./winapi.ts";

const kCopyDataDdeW = 0x44646557;
const kExitTimeoutMs = 20_000;
const modes = ["idle", "hold-until-stop", "hold", "dangerous-hold", "dangerous-drain"] as const;

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("render-cache-shutdown");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), "ShowStartPage = false\nShowToc = false\n");
  const pdf = join(dir, "held.pdf");
  writeFileSync(pdf, makeTextPdf("Shutdown must retain a live renderer's dependencies"));

  for (const engine of ["mupdf", "pdfium"]) {
    for (const mode of modes) {
      const label = `${engine} ${mode}`;
      const logPath = join(dir, `${engine}-${mode}.log`);
      rmSync(logPath, { force: true });
      const { proc, client, frame } = await launchControlled(["-appdata", dir, "-log-to-file", logPath], {
        env: { SOLOKPDF_ENGINE: engine },
      });
      try {
        const rendering = mode === "hold" || mode === "hold-until-stop";
        const hold = await client.request(ControlCommand.TestControllerDelete, [rendering ? mode : "state"]);
        if (hold[1] === "unsupported") {
          console.log("SKIP render-cache-shutdown: requires Debug");
          await client.quit();
          return;
        }
        if (hold[0] !== 0) throw new Error(`could not hold renderer: ${hold[1]}`);
        if (!sendCopyDataW(frame, kCopyDataDdeW, `[Open("${pdf}", 0, 1, 0)]`)) throw new Error("open failed");
        if (rendering) {
          await pollUntil(
            () => client.request(ControlCommand.TestControllerDelete, ["state"]),
            (s) => s[0] === 0 && /held=[1-9]/.test(String(s[1])),
            { error: "renderer never reached the barrier" },
          );
        } else {
          await client.waitForRenderIdle();
        }
        if (mode.startsWith("dangerous-")) {
          const started = await client.request(ControlCommand.TestControllerDelete, [mode]);
          if (started[0] !== 0) throw new Error(`${label}: could not start dangerous worker`);
        }
        await client.quit();
        if (!(await waitForExit(proc, kExitTimeoutMs))) throw new Error(`${label}: shutdown hung`);
        const stderr = await takeStderr(proc);
        if ((await proc.exited) !== 0 || /AddressSanitizer|UNHANDLED EXCEPTION/.test(stderr)) {
          throw new Error(`${label}: shutdown crashed: ${stderr}`);
        }
        const log = readFileSync(logPath, "utf8");
        const fastExit = mode === "hold" || mode === "dangerous-hold";
        if (
          log.includes("fast exit: skipping cleanup") !== fastExit ||
          log.includes("shutdown: shared cleanup complete") === fastExit
        ) {
          throw new Error(`${label}: wrong cleanup decision`);
        }
        if (mode === "hold" && !log.includes("render workers did not stop; retaining shared resources")) {
          throw new Error(`${label}: missing render stop timeout`);
        }
        if (mode === "hold-until-stop" && !log.includes("will execute 'DeleteControllerFinish'")) {
          throw new Error(`${label}: pending delete was not drained`);
        }
        if (mode === "dangerous-hold" && !log.includes("timed out waiting for dangerous threads")) {
          throw new Error(`${label}: missing dangerous worker timeout`);
        }
        if (mode === "dangerous-drain" && !log.includes("test dangerous thread finished on UI")) {
          throw new Error(`${label}: dangerous worker UI completion was not drained`);
        }
        console.log(
          `${label}: ${fastExit ? "retained dependencies; bounded fast exit" : "workers stopped; cleanup completed"}`,
        );
      } finally {
        client.close();
        await killAndWait(proc);
      }
    }
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
