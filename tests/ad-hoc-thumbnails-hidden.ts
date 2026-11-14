import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control";
import { assemblePdf, cmdId, runStandalone, SETTINGS_FILE, tmpPath } from "./util";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation";
import { sleep } from "./winapi";

// E47: a re-render while the thumbnails are hidden marks them stale; showing them renders them again.
type State = { shown: boolean; rendered: number; stale: number; raw: string };

async function thumbs(client: ControlClient): Promise<State> {
  const raw = String((await client.request(ControlCommand.TestSidebarThumbnails, []))[1]);
  const m = /rendered=(\d+).* stale=(\d+) active=(\d)/.exec(raw);
  assert.ok(m, `unexpected thumbnails state: ${raw}`);
  return { shown: m[3] === "1", rendered: Number(m[1]), stale: Number(m[2]), raw };
}

async function until(client: ControlClient, ok: (s: State) => boolean, what: string): Promise<State> {
  let s = await thumbs(client);
  for (const deadline = Date.now() + 10000; !ok(s) && Date.now() < deadline; ) {
    await sleep(50);
    s = await thumbs(client);
  }
  assert.ok(ok(s), `${what}: ${s.raw.slice(0, 200)}`);
  return s;
}

export async function testit(): Promise<void> {
  const dir = tmpPath("thumbnails-hidden");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "thumbnails-hidden.pdf");
  const content = "BT /F1 48 Tf 72 600 Td (Thumb) Tj ET";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
  );
  const appdata = join(dir, "appdata");
  mkdirSync(appdata, { recursive: true });
  writeFileSync(join(appdata, SETTINGS_FILE), "ShowToc = false\nShowFavorites = false\n");
  const { proc, client, frame } = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await client.waitForRenderIdle();
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    await until(client, (s) => s.shown && s.rendered > 0 && s.stale === 0, "thumbnails did not render");
    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    await until(client, (s) => !s.shown, "thumbnails did not hide");

    const adjusted = await client.request(ControlCommand.TestPageAdjust, [50, 0]);
    assert.equal(adjusted[0], 0, `brightness: ${adjusted[1]}`);
    await client.waitForRenderIdle();
    const hidden = await thumbs(client);
    assert.ok(hidden.stale > 0, `re-render left hidden thumbnails current: ${hidden.raw.slice(0, 200)}`);

    sendCommandSync(frame, cmdId("CmdToggleThumbnails"));
    await until(client, (s) => s.shown && s.rendered > 0 && s.stale === 0, "shown thumbnails were not re-rendered");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
