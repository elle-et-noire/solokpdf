// E131: an action and a scroll must find the same hints as an idle render.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, pollUntil, runStandalone, tmpPath } from "./util.ts";
import { killAndWait, launchControlled, sendCommandSync } from "./win-automation.ts";
import { sleep } from "./winapi.ts";

const HOLD_MS = 1000;
const DEBOUNCE_MS = 300;
const RELABEL_MS = 400;
const PAGES = 12;
const COLD_PAGE = 8;
type Engine = "pdfium" | "mupdf";

function makePdf(): string {
  const kids = Array.from({ length: PAGES }, (_, i) => `${3 + 2 * i} 0 R`);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${PAGES} >>`];
  for (let i = 0; i < PAGES; i++) {
    const annot = 4 + 2 * i;
    // An annotation on page 2 also lets PDFium use an existing editor's cached elements.
    const extra = i === 1 ? ` ${3 + 2 * PAGES} 0 R` : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [${annot} 0 R${extra}] >>`,
      `<< /Type /Annot /Subtype /Link /Rect [80 ${400 + i * 10} 170 ${430 + i * 10}] /Dest [3 0 R /Fit] >>`,
    );
  }
  objects.push("<< /Type /Annot /Subtype /Square /Rect [30 30 70 70] /Contents (Note) >>");
  return assemblePdf(objects);
}

async function ask(client: ControlClient, cmd: ControlCommand, args: (string | number)[] = []): Promise<string> {
  const [status, result] = await client.request(cmd, args);
  if (status !== 0) throw new Error(`${args.join(" ")}: ${result}`);
  return String(result);
}

async function check(engine: Engine, failures: string[]): Promise<void> {
  const dir = tmpPath(`ad-hoc-e131-${engine}`);
  mkdirSync(dir, { recursive: true });
  const pdf = join(dir, "doc.pdf");
  writeFileSync(pdf, makePdf(), "latin1");
  const { proc, client, frame } = await launchControlled(
    ["-appdata", dir, "-view", "single page", "-zoom", "fit page", pdf],
    {
      env: { ...process.env, SOLOKPDF_ENGINE: engine } as Record<string, string>,
    },
  );
  const current = (...args: (string | number)[]) => ask(client, ControlCommand.TestCurrentPdf, args);
  const hints = (...args: string[]) => ask(client, ControlCommand.TestKeyboardLinkFollow, args);
  const toggle = () => sendCommandSync(frame, cmdId("CmdToggleKeyboardLinkFollowing"));
  const nav = (cmd: string) => sendCommandSync(frame, cmdId(cmd));
  const holdRender = (action: string) => ask(client, ControlCommand.TestControllerDelete, [action]);
  const lock = engine === "pdfium" ? "hold-pdfium-lock" : "hold-pages-lock";
  const holdLock = async () => {
    const t = Date.now();
    await current(lock, HOLD_MS);
    if (Date.now() - t >= HOLD_MS) throw new Error(`${lock} released before the test could continue`);
    return t;
  };
  const activeOn = (dump: string, page: number) =>
    dump.startsWith("active=1 ") && dump.includes(`\nlink=1 page=${page} `) && dump.includes(" count=1 ");
  const waitHints = async (want: string) => {
    await pollUntil(hints, (s) => s === want, {
      timeoutMs: 3000,
      error: (s) => `hints did not recover without input\nexpected ${want}got ${s}`,
    });
  };
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`${engine} ${what}: OK`);
    } catch (e) {
      failures.push(`${engine} ${what}: ${(e as Error).message}`);
    } finally {
      await hints("stop");
      await pollUntil(
        () => current("try-elements", 1),
        (s) => s.startsWith("ok=1 "),
      );
      await client.waitForRenderIdle();
    }
  };

  try {
    await client.waitForRenderIdle();
    toggle();
    const first = await hints();
    if (!activeOn(first, 1)) throw new Error(`${engine}: bad baseline\n${first}`);
    await hints("stop");

    await step("activation while locked", async () => {
      await holdLock();
      toggle();
      const got = await hints();
      if (got !== first) throw new Error(`expected ${first}got ${got}`);
    });

    nav("CmdGoToNextPage");
    await client.waitForRenderIdle();
    toggle();
    const second = await hints();
    if (!activeOn(second, 2)) throw new Error(`${engine}: bad second page baseline\n${second}`);
    await hints("stop");
    nav("CmdGoToFirstPage");
    await client.waitForRenderIdle();

    await step("relabel after scroll while locked", async () => {
      toggle();
      const scrolled = Date.now();
      nav("CmdScrollDownPage");
      const held = await holdLock();
      if (Date.now() - scrolled >= DEBOUNCE_MS) throw new Error("lock was not held before the scroll debounce");
      await sleep(RELABEL_MS);
      const probe = await current("try-elements", 2);
      if (!probe.startsWith("ok=0 ") || Date.now() - held >= HOLD_MS)
        throw new Error(`relabel was not attempted without waiting for the lock: ${probe}`);
      await waitHints(second);
    });

    nav("CmdGoToFirstPage");
    await client.waitForRenderIdle();
    await step("activation before page elements load", async () => {
      await holdRender("hold");
      try {
        nav("CmdGoToLastPage");
        await pollUntil(
          () => holdRender("state"),
          (s) => /held=[1-9]/.test(s),
        );
        if (engine === "mupdf") {
          const probe = await current("try-elements", PAGES);
          if (!probe.startsWith("ok=1 elements=0 ")) throw new Error(`expected an unlocked, unprepared page: ${probe}`);
        }
        toggle();
        const got = await hints();
        if (!activeOn(got, PAGES)) throw new Error(`missing label before first render\n${got}`);
      } finally {
        await holdRender("release");
      }
    });

    nav("CmdGoToFirstPage");
    await client.waitForRenderIdle();
    await step("relabel before page elements load", async () => {
      toggle();
      await holdRender("hold");
      try {
        const at = await client.goToLocation(1, COLD_PAGE);
        if (at.page !== COLD_PAGE) throw new Error(`landed on page ${at.page}, expected ${COLD_PAGE}`);
        await pollUntil(
          () => holdRender("state"),
          (s) => /held=[1-9]/.test(s),
        );
        await sleep(RELABEL_MS);
        if (engine === "mupdf") {
          const probe = await current("try-elements", COLD_PAGE);
          if (!probe.startsWith("ok=1 elements=0 ")) throw new Error(`expected an unlocked, unprepared page: ${probe}`);
        }
      } finally {
        await holdRender("release");
      }
      const settled = await pollUntil(hints, (s) => activeOn(s, COLD_PAGE), {
        timeoutMs: 3000,
        error: (s) => `hints for the newly rendered page did not appear without input\n${s}`,
      });
      await hints("stop");
      await client.waitForRenderIdle();
      toggle();
      const idle = await hints();
      if (settled !== idle) throw new Error(`expected ${idle}got ${settled}`);
    });

    if (engine === "pdfium") {
      if ((await current("editor")) !== "editor=none") throw new Error("link following loaded the editor");
      nav("CmdGoToFirstPage");
      await client.waitForRenderIdle();
      await step("relabel with an unprepared editor page", async () => {
        await current("editor-text", 1);
        const probe = await current("try-editor-elements", 2);
        if (!probe.startsWith("ok=1 elements=0 ")) throw new Error(`expected an unprepared editor page: ${probe}`);
        toggle();
        nav("CmdScrollDownPage");
        await waitHints(second);
      });
    }
  } finally {
    client.close();
    await killAndWait(proc);
  }
}

export async function testit(): Promise<void> {
  const failures: string[] = [];
  await check("pdfium", failures);
  await check("mupdf", failures);
  if (failures.length) throw new Error(failures.join("\n"));
}

if (import.meta.main) await runStandalone(testit);
