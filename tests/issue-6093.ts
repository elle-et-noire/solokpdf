// Test for https://github.com/sumatrapdfreader/sumatrapdf/issues/6093
//
// Scrollbars = smart drew nothing: the overlay scrollbar was shown, but
// SetWindowPos put it after (i.e. below) the main frame, so the frame painted
// over it. It has to sit above the frame; as a child of the canvas (E97),
// above the canvas's other children.
//
// Run: bun tests/issue-6093.ts [--no-build]   (or via tests/run-almost-all.ts)

import { join } from "node:path";
import { cmdId, EXE, pollUntil, ROOT, runStandalone, USE_NG, writeAppdata } from "./util.ts";
import { getParentWindow, getWindow, getWindowRect, GW_CHILD, GW_HWNDNEXT, isWindowVisible, sleep } from "./winapi.ts";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { findCanvas, overlayScrollbarWindows, sendCommand, waitForFrame } from "./win-automation.ts";

export async function testit(): Promise<void> {
  const appdata = writeAppdata(
    "issue-6093",
    [
      "UiLanguage = en",
      "CheckForUpdates = false",
      "RestoreSession = false",
      "ShowStartPage = false",
      "Scrollbars = smart",
    ].join("\n"),
  );

  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      const frame = await waitForFrame(proc.pid!);
      await client.waitForRenderIdle(30000);
      await client.setNotificationsEnabled(false);

      // scrolling shows the thin bar for a few seconds
      sendCommand(frame, cmdId("CmdScrollDown"));
      if (USE_NG) {
        // the bar is drawn in the frame, after the page, so it stays above it
        await pollUntil(
          async () => String((await client.request(ControlCommand.TestUiState, []))[1] ?? ""),
          (s) => /overlayV=1/.test(s) && /overlayAbove=1/.test(s),
          { error: (s) => `issue-6093: no visible overlay scrollbar after scrolling (${s})` },
        );
        return;
      }
      await sleep(400);

      const bars = overlayScrollbarWindows(proc.pid!).filter((h) => isWindowVisible(h));
      if (bars.length === 0) {
        throw new Error("issue-6093: no visible overlay scrollbar after scrolling");
      }
      // a child of the canvas, above its other children: drawn over the page (E97)
      const canvas = findCanvas(frame);
      const allBars = overlayScrollbarWindows(proc.pid!);
      const above: number[] = [];
      for (let h = getWindow(canvas, GW_CHILD); h && allBars.includes(h); h = getWindow(h, GW_HWNDNEXT)) above.push(h);
      for (const bar of bars) {
        if (getParentWindow(bar) !== canvas || !above.includes(bar)) {
          const r = getWindowRect(bar);
          throw new Error(
            `issue-6093: overlay scrollbar is not on top of the canvas, so the page may cover it (${JSON.stringify(r)})`,
          );
        }
      }
    },
    ["-appdata", appdata, "-view", "continuous", "-zoom", "200", join(ROOT, "tests", "issue-5871.pdf")],
  );
}

if (import.meta.main) {
  await runStandalone(testit);
}
