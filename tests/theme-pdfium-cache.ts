import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand } from "./control.ts";
import { assemblePdf, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { killAndWait, launchControlled } from "./win-automation.ts";

export async function testit(): Promise<void> {
  if (USE_NG) return;
  const dir = tmpPath("theme-pdfium-cache");
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "pages.pdf");
  const log = join(dir, "render.log");
  rmSync(log, { force: true });
  const content = "0 g 0 0 100 100 re f";
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]),
    "latin1",
  );
  writeFileSync(
    join(dir, SETTINGS_FILE),
    "UiLanguage = en\nCheckForUpdates = false\nShowStartPage = false\nDefaultZoom = fit page\nDefaultDisplayMode = single page\nTheme = Solarized Dark\nDocumentColorsFollowTheme = smart\n",
  );
  const { proc, client } = await launchControlled(["-appdata", dir, "-log-to-file", log, pdf], {
    env: { SOLOKPDF_ENGINE: "pdfium", SOLOKPDF_PROFILE: "1" },
  });
  try {
    await client.setNotificationsEnabled(false);
    for (const page of [1, 2, 1]) {
      const location = await client.goToLocation(1, page);
      if (location.page !== page) throw new Error(`wrong page: ${JSON.stringify(location)}`);
      const zoom = await client.request(ControlCommand.TestInvokeCommand, ["CmdZoomIn"]);
      if (zoom[0] !== 0) throw new Error(`zoom: ${zoom}`);
      await client.waitForRenderIdle();
    }
    const conversions = () => (readFileSync(log, "utf8").match(/PDFium theme conversion:/g) ?? []).length;
    const initial = conversions();
    const invoke = async (name: string) => {
      const result = await client.request(ControlCommand.TestInvokeCommand, [name]);
      if (result[0] !== 0) throw new Error(`${name}: ${result}`);
      await client.waitForRenderIdle();
    };
    await invoke("CmdToggleGrayscale");
    await client.request(ControlCommand.TestPageAdjust, [20, 30]);
    await client.waitForRenderIdle();
    await invoke("CmdToggleGrayscale");
    await client.request(ControlCommand.TestPageAdjust, [0, 0]);
    await client.waitForRenderIdle();
    if (conversions() !== initial) throw new Error("view adjustments reconverted PDF contents");

    await invoke("CmdSetTheme Light");
    if (conversions() !== initial + 1) throw new Error("new theme did not convert the visible page once");
    await invoke("CmdSetTheme Solarized Dark");
    if (conversions() !== initial + 1) throw new Error("returning to the cached theme reconverted PDF contents");
    await client.quit();
    await proc.exited;
    const text = readFileSync(log, "utf8");
    const pages = [...text.matchAll(/PDFium theme conversion: page=(\d+)/g)].map((match) => Number(match[1]));
    for (const page of [1, 2]) {
      const expected = page === 1 ? 2 : 1;
      if (pages.filter((n) => n === page).length !== expected) throw new Error(`unexpected conversions: ${pages}`);
      const probes = [...text.matchAll(/PDFium render check: page=(\d+)/g)];
      if (probes.filter((match) => Number(match[1]) === page).length !== 1)
        throw new Error(`theme change repeated page ${page} route probe`);
    }
  } finally {
    await killAndWait(proc);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
