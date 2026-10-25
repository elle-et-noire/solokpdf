import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const single = process.argv.includes("--single");
const singleLarge = process.argv.includes("--single-large");
const largeTileBytes = 16 * 1024 * 1024;
const files = process.argv.slice(2).filter((arg) => arg !== "--single" && arg !== "--single-large");
if (!files.length) throw new Error("Pass application logs; --single requires one render buffer at a time");
for (const file of files) {
  const log = readFileSync(resolve(file), "utf8");
  let live = 0;
  let peak = 0;
  let buffers = 0;
  let peakBuffers = 0;
  let outputs = 0;
  let slack = 0;
  let largeCount = 0;
  let peakLargeCount = 0;
  let largeOverlaps = 0;
  for (const line of log.split(/\r?\n/)) {
    const buffer = /^PDFium buffer: thread=\d+ delta=(-?\d+)/.exec(line);
    if (buffer) {
      const delta = Number(buffer[1]);
      live += delta;
      buffers += delta > 0 ? 1 : -1;
      peak = Math.max(peak, live);
      peakBuffers = Math.max(peakBuffers, buffers);
      if (Math.abs(delta) > largeTileBytes) {
        largeCount += delta > 0 ? 1 : -1;
        peakLargeCount = Math.max(peakLargeCount, largeCount);
      }
      if (largeCount > 0 && buffers > 1) largeOverlaps++;
      if (live < 0 || buffers < 0) throw new Error(`Unbalanced buffer trace: ${file}`);
    }
    const output = /^PDFium output: thread=\d+ pixels=(\d+) storage=(\d+)/.exec(line);
    if (output) {
      const pixels = Number(output[1]);
      const storage = Number(output[2]);
      if (storage < pixels) throw new Error(`Invalid storage size: ${file}`);
      slack += storage - pixels;
      outputs++;
    }
  }
  if (live || buffers || !peak || !outputs) throw new Error(`Incomplete buffer trace: ${file}`);
  console.log({
    file,
    peakTrackedBgraBytes: peak,
    peakBuffers,
    peakLargeCount,
    largeOverlaps,
    outputs,
    outputHeapSlackBytes: slack,
  });
  if (single && peakBuffers !== 1) throw new Error(`Overlapping render buffers: ${file}`);
  if (singleLarge && (peakLargeCount !== 1 || largeOverlaps))
    throw new Error(`Overlapping large render buffers: ${file}`);
}
