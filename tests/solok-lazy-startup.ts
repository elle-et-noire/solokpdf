import { existsSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { APP_NAME, EXE, IS_ASAN, ROOT, SLOW_BUILD_FACTOR, runStandalone, writeAppdata } from "./util.ts";
import { processMemoryMap, processesUsingFile } from "./winapi.ts";

const invalidVoice = "solokpdf-invalid-voice-id";

async function voiceState(client: { request: (cmd: ControlCommand, args: string[]) => Promise<unknown[]> }) {
  const res = await client.request(ControlCommand.TestTtsEngineCrash, ["state"]);
  if (res[0] !== 0) throw new Error(`voice state: ${res}`);
  return String(res[1]);
}

export async function testit(): Promise<void> {
  if (APP_NAME !== "SolokPDF") return;
  const dir = writeAppdata("solok-lazy-startup", `ReadAloudVoiceId = ${invalidVoice}\nReadAloudSpeed = 1.5\n`);
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const state = await voiceState(client);
      if (!state.includes(`voice='${invalidVoice}'`)) throw new Error(`voice was applied at startup: ${state}`);

      const speech = processMemoryMap(proc.pid!).filter((m) => /speech_onecore|\\sapi\.dll/i.test(m.file));
      if (speech.length) throw new Error(`speech loaded at startup: ${speech.map((m) => m.file).join(", ")}`);

      const pdb = EXE.replace(/\.exe$/i, ".pdb");
      if (!IS_ASAN && existsSync(pdb)) {
        const owners = processesUsingFile(pdb);
        if (owners.some((s) => s.startsWith("("))) throw new Error(`PDB query failed: ${owners}`);
        const owner = owners.find((s) => s.includes(`pid ${proc.pid}`));
        if (owner) throw new Error(`PDB loaded at startup: ${owner}`);
      }

      await client.waitForRenderIdle();
      const start = await client.request(ControlCommand.TestInvokeCommand, ["CmdToggleReadAloud"]);
      if (start[0] !== 0) throw new Error(`read-aloud start: ${start}`);
      const deadline = Date.now() + 12000 * SLOW_BUILD_FACTOR;
      let bar = "";
      do {
        await Bun.sleep(80);
        const res = await client.request(ControlCommand.TestReadAloudPlaybackBar, []);
        bar = String(res[1]);
        if (bar.includes("voices=0")) break;
        if (res[0] === 0 && bar.includes("label=1.5x")) break;
      } while (Date.now() < deadline);
      if (bar.includes("voices=0")) {
        console.log("SKIP solok-lazy-startup playback: no TTS voices");
      } else if (!bar.includes("label=1.5x")) {
        throw new Error(`read-aloud speed or bar: ${bar}`);
      }
      const activated = await voiceState(client);
      if (!activated.includes("voice=''")) throw new Error(`invalid voice not cleared: ${activated}`);
    },
    ["-appdata", dir, join(ROOT, "ext", "a-zlib", "zlib.3.pdf")],
  );
}

if (import.meta.main) await runStandalone(testit);
