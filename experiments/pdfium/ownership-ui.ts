import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ControlCommand, withControlledSumatra } from "../../tests/control.ts";
import { cmdId } from "../../tests/util.ts";
import { sendCommandSync, waitForFrame } from "../../tests/win-automation.ts";
import {
  enumWindows,
  findChildWindow,
  getControlText,
  getWindowPid,
  getWindowText,
  processGuiResources,
  processMemory,
  sendCopyDataW,
  setProcessDpiAware,
  systemMemory,
} from "../../tests/winapi.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    exe: { type: "string" },
    output: { type: "string", default: "out/solok-ownership" },
    hold: { type: "string", default: "60" },
  },
});
if (!values.exe || positionals.length !== 4) throw new Error("Pass --exe and four independent PDFs");
const holdSeconds = Number(values.hold);
if (!Number.isInteger(holdSeconds) || holdSeconds < 0) throw new Error("Invalid hold");
const kCopyDataDdeW = 0x44646557;
const out = resolve(values.output),
  exe = resolve(values.exe);
mkdirSync(out, { recursive: true });
setProcessDpiAware();
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const inputs = positionals.map((file, i) => {
  const path = resolve(file),
    copy = join(out, `${i}-${basename(file)}`);
  copyFileSync(path, copy);
  return { path, copy, sha256: hash(path) };
});
const settings = join(out, "settings");
mkdirSync(settings, { recursive: true });
writeFileSync(
  join(settings, "SolokPDF-settings.txt"),
  "UiLanguage = en\nRestoreSession = false\nShowToc = false\nRememberStatePerDocument = false\nDefaultDisplayMode = continuous\nDefaultZoom = 100\nCheckForUpdates = false\n",
);
const snapshots: unknown[] = [];
const save = () =>
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      {
        exe,
        sha256: hash(exe),
        dependencies: ["pdfium.dll", "libsumatrapdf.dll"].map((name) => ({
          name,
          sha256: hash(join(dirname(exe), name)),
        })),
        inputs,
        holdSeconds,
        note: "Ownership diagnostic, excluded from performance aggregates. App PDBs, including the recorded build-output path, are hidden. Cache Info sizes are width*height*4 upper estimates, not actual gray/BGR storage. Counters precede temporary Cache Info window creation. No forced trimming.",
        snapshots,
      },
      null,
      2,
    ) + "\n",
  );
const hidden: [string, string][] = [];
try {
  for (const pdb of new Set([resolve("out/rel64/SumatraPDF.pdb"), exe.replace(/\.exe$/i, ".pdb")])) {
    if (!pdb.startsWith(resolve("out") + "\\")) throw new Error("PDB outside output directory");
    const dest = pdb + ".ownership-hidden";
    if (existsSync(dest)) throw new Error(`Restore interrupted PDB: ${dest}`);
    if (existsSync(pdb)) {
      renameSync(pdb, dest);
      hidden.push([pdb, dest]);
    }
  }
  await withControlledSumatra(
    exe,
    async (client, proc) => {
      await client.setNotificationsEnabled(false);
      const frame = await waitForFrame(proc.pid!);
      if (!frame) throw new Error("No frame");
      const start = performance.now();
      const snapshot = async (stage: string) => {
        await Bun.sleep(500);
        const counters = {
          memory: processMemory(proc.pid!),
          resources: processGuiResources(proc.pid!),
          system: systemMemory(),
        };
        sendCommandSync(frame, cmdId("CmdDebugToggleCacheInfo"));
        let cacheWindow = 0,
          text = "";
        try {
          for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
            await client.request(ControlCommand.Ping);
            enumWindows((hwnd) => {
              if (getWindowPid(hwnd) === proc.pid && getWindowText(hwnd) === "Cache Info") cacheWindow = hwnd;
              return true;
            });
            const edit = cacheWindow && findChildWindow(cacheWindow, "Edit");
            text = edit ? getControlText(edit) : "";
            if (text.startsWith("Cached objects:")) break;
            await Bun.sleep(20);
          }
          if (!text.startsWith("Cached objects:")) throw new Error("No cache snapshot");
          snapshots.push({ stage, ms: performance.now() - start, ...counters, cache: text });
          save();
          console.log(
            `${stage}: Private ${(counters.memory.privateBytes / 1048576).toFixed(1)} MiB; ${text.split(/\r?\n/)[0]}`,
          );
        } finally {
          if (cacheWindow) sendCommandSync(frame, cmdId("CmdDebugToggleCacheInfo"));
        }
      };
      await snapshot("empty");
      for (const [i, input] of inputs.entries()) {
        if (!sendCopyDataW(frame, kCopyDataDdeW, `[Open("${input.copy}",0,1,0)]`)) throw new Error("Open failed");
        await client.waitForRenderIdle(30000);
        await snapshot(`opened-${i + 1}`);
      }
      for (let i = 0; i < inputs.length; i++) {
        sendCommandSync(frame, cmdId("CmdNextTab"));
        if ((await client.request(ControlCommand.TestCurrentTab))[0] !== 0) {
          sendCommandSync(frame, cmdId("CmdNextTab"));
        }
        await client.waitForRenderIdle(30000);
      }
      await snapshot("visited-all");
      for (let seconds = 0; seconds < holdSeconds; seconds++) await Bun.sleep(1000);
      await snapshot("held");
      sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
      if ((await client.request(ControlCommand.TestCurrentTab))[0] === 0) throw new Error("Document still open");
      await snapshot("closed");
      await Bun.sleep(5000);
      await snapshot("closed-settled");
    },
    ["-appdata", settings, "-window-pos", "900x1000@0x0", "-log-to-file", join(out, "app.log")],
    {
      env: { ...process.env, SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "1" },
      connectTimeoutMs: 30000,
    },
  );
  const log = readFileSync(join(out, "app.log"), "utf8");
  if (!log.includes("PDFium 158.0.8111.0: opened") || log.includes("Using MuPDF fallback")) {
    throw new Error("PDFium was not used");
  }
} finally {
  for (const [pdb, dest] of hidden) renameSync(dest, pdb);
}
