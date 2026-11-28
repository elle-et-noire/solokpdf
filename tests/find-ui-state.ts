// Switching the global find-UI mode must migrate every visible find UI, not
// leave compact and floating variants mixed across multiple windows.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, pollUntil, runStandalone, tmpPath, SETTINGS_FILE, USE_NG } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { sendCopyDataW } from "./winapi.ts";

type FindUiState = {
  windows: number;
  docs: number;
  pref: number;
  compact: number;
  floating: number;
  firstTextLen: number;
  raw: string;
};

async function findUiRequest(client: ControlClient, action: string): Promise<FindUiState> {
  const response = await client.request(ControlCommand.TestFindUiState, [action]);
  const code = Number(response[0] ?? -1);
  const raw = String(response[1] ?? "");
  if (code !== 0) {
    throw new Error(`find-ui-state: ${action} failed (${code}): ${raw.trim()}`);
  }
  const values: Record<string, number> = {};
  for (const match of raw.matchAll(/(\w+)=(\d+)/g)) {
    values[match[1]] = Number(match[2]);
  }
  return {
    windows: values.windows ?? 0,
    docs: values.docs ?? 0,
    pref: values.pref ?? -1,
    compact: values.compact ?? 0,
    floating: values.floating ?? 0,
    firstTextLen: values.firstTextLen ?? -1,
    raw,
  };
}

async function waitForTwoDocuments(client: ControlClient): Promise<void> {
  const deadline = Date.now() + 8000;
  let state = await findUiRequest(client, "state");
  while ((state.windows !== 2 || state.docs !== 2) && Date.now() < deadline) {
    await Bun.sleep(40);
    state = await findUiRequest(client, "state");
  }
  if (state.windows !== 2 || state.docs !== 2) {
    throw new Error(`find-ui-state: duplicate window did not load: ${state.raw.trim()}`);
  }
}

function expectState(state: FindUiState, pref: number, compact: number, floating: number): void {
  if (state.pref !== pref || state.compact !== compact || state.floating !== floating) {
    throw new Error(
      `find-ui-state: expected pref=${pref} compact=${compact} floating=${floating}, got ${state.raw.trim()}`,
    );
  }
}

function labeledPdf(prefix: string, pages: number, text: string): string {
  const stream = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`;
  const kids = Array.from({ length: pages }, (_, i) => `${i + 5} 0 R`).join(" ");
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /D /P (${prefix}) >>] >> >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
    ),
  ]);
}

async function checkProgress(client: ControlClient): Promise<void> {
  const request = (action: string, idx: number, ...args: (string | number)[]) =>
    client.request(ControlCommand.TestFindUiState, [action, idx, ...args]);
  if (USE_NG || String((await request("status", 0))[1]).includes("invalid action")) return;
  assert.equal((await request("progress", 0, 2, 0, -1))[1], "A-2");
  assert.equal((await request("progress", 1, 80, 0, -1))[1], "B-80");
  const [oldEpoch, status] = await request("progress", 0, 0, 4, -1);
  assert.equal(status, "4 A-2");
  assert.equal((await request("status", 1))[1], "B-80");

  await request("count", 1, "gamma");
  await pollUntil(
    () => request("status", 1),
    (r) => r[1] === "0 / 80",
    { error: "B final count was not 80" },
  );

  await request("count", 0, "alpha");
  await request("count", 0, "beta");
  const stale = await request("progress", 0, 0, 999, Number(oldEpoch));
  assert.doesNotMatch(String(stale[1]), /999/);
  await pollUntil(
    () => request("status", 0),
    (r) => r[1] === "0 / 2",
    { error: "A replacement count was not 2" },
  );
}

export async function testit(): Promise<void> {
  const dir = tmpPath("find-ui-state");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nRestoreSession = false\nSearchUIFloating = false\n",
  );

  const pdf = join(dir, "a.pdf");
  const other = join(dir, "b.pdf");
  writeFileSync(pdf, labeledPdf("A-", 2, "alpha alpha beta"), "latin1");
  writeFileSync(other, labeledPdf("B-", 80, "gamma"), "latin1");
  const { proc, client, frame } = await launchControlled(["-appdata", dir, pdf]);
  try {
    await client.waitForRenderIdle();
    if (USE_NG) {
      sendCommandSync(frame, cmdId("CmdDuplicateInNewWindow"));
    } else {
      assert.ok(sendCopyDataW(frame, 0x44646557, `[Open("${other.replaceAll("\\", "/")}",1,0,0)]`));
    }
    await waitForTwoDocuments(client);

    expectState(await findUiRequest(client, "show-all"), 0, 2, 0);
    await checkProgress(client);
    expectState(await findUiRequest(client, "toggle-first"), 1, 0, 2);

    let state = await findUiRequest(client, "set-first-text");
    if (state.firstTextLen !== "stale-term".length) {
      throw new Error(`find-ui-state: failed to seed floating term: ${state.raw.trim()}`);
    }
    await findUiRequest(client, "toggle-first");
    state = await findUiRequest(client, "clear-first");
    if (state.firstTextLen !== 0) {
      throw new Error(`find-ui-state: failed to clear compact term: ${state.raw.trim()}`);
    }
    state = await findUiRequest(client, "toggle-first");
    if (state.firstTextLen !== 0) {
      throw new Error(`find-ui-state: empty term was replaced after switching: ${state.raw.trim()}`);
    }

    // The hidden bar's term still backs F3 after a theme refresh.
    expectState(await findUiRequest(client, "toggle-first"), 0, 2, 0);
    state = await findUiRequest(client, "set-first-text");
    if (state.firstTextLen !== "stale-term".length) {
      throw new Error(`find-ui-state: failed to seed hidden-term test: ${state.raw.trim()}`);
    }
    expectState(await findUiRequest(client, "hide-first"), 0, 1, 0);
    state = await findUiRequest(client, "theme-refresh");
    if (state.firstTextLen !== "stale-term".length) {
      throw new Error(`find-ui-state: hidden term was lost during the theme refresh: ${state.raw.trim()}`);
    }
    console.log("find-ui-state: OK");
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
