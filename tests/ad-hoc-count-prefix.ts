import { writeFileSync } from "node:fs";
import { assemblePdf, runStandalone, tmpPath } from "./util.ts";
import { findCanvas, killAndWait, launchControlled, pressKey } from "./win-automation.ts";
import { getScrollPos } from "./winapi.ts";

function makePdf(): string {
  const pages = Array.from({ length: 20 }, (_, i) => `${3 + i * 2} 0 R`);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.join(" ")}] /Count ${pages.length} >>`,
  ];
  for (let i = 0; i < pages.length; i++) {
    const content = `BT /F1 20 Tf 72 700 Td (Page ${i + 1}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  return assemblePdf(objs);
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("count-prefix.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const { proc, client, frame } = await launchControlled(["-zoom", "200", "-view", "continuous", pdf]);
  try {
    await client.waitForRenderIdle();
    const canvas = findCanvas(frame);
    const start = getScrollPos(canvas);
    await pressKey(frame, 0x4a);
    const afterOne = getScrollPos(canvas);
    const one = afterOne - start;
    await pressKey(frame, 0x33);
    await pressKey(frame, 0x4a);
    const afterThree = getScrollPos(canvas);
    const three = afterThree - afterOne;
    await pressKey(frame, 0x35);
    await pressKey(frame, 0x1b);
    await pressKey(frame, 0x4a);
    const afterEsc = getScrollPos(canvas) - afterThree;
    if (one <= 0 || Math.abs(three - 3 * one) > 5 || Math.abs(afterEsc - one) > 3) {
      throw new Error(`count scroll: one=${one}, three=${three}, after Esc=${afterEsc}`);
    }
  } finally {
    await client.quit().catch(() => {});
    await killAndWait(proc);
  }
}

if (import.meta.main) await runStandalone(testit);
