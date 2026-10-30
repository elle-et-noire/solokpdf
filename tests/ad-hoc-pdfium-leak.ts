import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { cmdId, makeTextPdf, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { processGuiResources, processMemory, sendCopyDataW, sleep } from "./winapi.ts";

const DEFAULT_SECONDS = 120;
const SAMPLE_SECONDS = 10;
const OPEN_DATA_ID = 0x44646557;
const PRIVATE_TOLERANCE = 32 * 1024 * 1024;
const HANDLE_TOLERANCE = 40;
const GDI_TOLERANCE = 12;

type Sample = { sec: number; privateBytes: number; handles: number; gdi: number };

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trend(samples: Sample[], key: "privateBytes" | "handles" | "gdi", tolerance: number): string {
  const warm = samples.slice(Math.floor(samples.length / 4));
  if (warm.length < 6) return "insufficient samples";
  const n = Math.max(2, Math.floor(warm.length / 3));
  const start = mean(warm.slice(0, n).map((sample) => sample[key]));
  const end = mean(warm.slice(-n).map((sample) => sample[key]));
  const rising = warm.slice(1).filter((sample, i) => sample[key] > warm[i]![key]).length;
  if (end - start > tolerance && rising >= Math.ceil(warm.length / 2)) {
    return `${key} rose ${Math.round(end - start)} (tolerance ${tolerance})`;
  }
  return "";
}

export async function testit(): Promise<void> {
  const flag = process.argv.find((arg) => arg.startsWith("--minutes="));
  const minutes = flag ? Number(flag.slice("--minutes=".length)) : DEFAULT_SECONDS / 60;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("use --minutes=<positive number>");
  const duration = minutes * 60 * 1000;

  const dir = tmpPath("pdfium-leak");
  mkdirSync(dir, { recursive: true });
  const docs = ["alpha", "beta"].map((name) => {
    const path = join(dir, `${name}.pdf`);
    writeFileSync(path, makeTextPdf(`${name} search scroll zoom`));
    return path;
  });

  const { proc, client, frame } = await launchControlled([docs[0]!], { env: { SOLOKPDF_ENGINE: "pdfium" } });
  const samples: Sample[] = [];
  const began = Date.now();
  let nextSample = began + SAMPLE_SECONDS * 1000;
  let cycles = 0;
  try {
    while (Date.now() - began < duration) {
      for (const doc of docs) {
        if (!sendCopyDataW(frame, OPEN_DATA_ID, `[Open("${doc}", 0, 1, 0)]`)) {
          throw new Error(`open failed: ${doc}`);
        }
      }
      await client.waitForRenderIdle();
      sendCommandSync(frame, cmdId("CmdZoom200"));
      sendCommandSync(frame, cmdId("CmdScrollDownPage"));
      const search = await client.request(ControlCommand.TestCurrentPdf, ["search"]);
      if (search[0] !== 0 || !String(search[1]).includes("found=1")) {
        throw new Error(`search failed: ${search[1]}`);
      }
      sendCommandSync(frame, cmdId("CmdPrevTab"));
      await client.waitForRenderIdle();
      sendCommandSync(frame, cmdId("CmdCloseAllTabs"));
      await sleep(100);
      cycles++;

      if (Date.now() >= nextSample) {
        const mem = processMemory(proc.pid!);
        const gui = processGuiResources(proc.pid!);
        const sample = {
          sec: Math.round((Date.now() - began) / 1000),
          privateBytes: mem.privateBytes,
          handles: gui.handles,
          gdi: gui.gdi,
        };
        samples.push(sample);
        console.log(JSON.stringify(sample));
        nextSample += SAMPLE_SECONDS * 1000;
      }
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }

  const failures = [
    trend(samples, "privateBytes", PRIVATE_TOLERANCE),
    trend(samples, "handles", HANDLE_TOLERANCE),
    trend(samples, "gdi", GDI_TOLERANCE),
  ].filter(Boolean);
  console.log(`PDFium leak stress: ${cycles} cycles, ${samples.length} samples over ${minutes} min`);
  if (failures.length) throw new Error(failures.join("; "));
}

if (import.meta.main) await runStandalone(testit);
