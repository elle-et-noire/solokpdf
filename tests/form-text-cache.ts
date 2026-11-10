import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlCommand, withControlledSumatra, type ControlClient } from "./control.ts";
import { assemblePdf, cmdId, EXE, pollUntil, runStandalone, SETTINGS_FILE, tmpPath, USE_NG } from "./util.ts";
import { clickAt, findCanvas, FRAME_CLASS, pressEnter, sendCommandSync } from "./win-automation.ts";
import { findVisibleChildWindow, sendText, waitForTopWindow } from "./winapi.ts";

type Mode = "text" | "choice" | "button" | "radio" | "blank" | "reject";

function fixture(mode: Mode): string {
  const old = mode === "blank" ? "" : mode === "button" || mode === "radio" ? "Off" : "OLDWORD";
  const field =
    mode === "choice"
      ? "/FT /Ch /Ff 131072 /Opt [(OLDWORD) (NEWWORD)]"
      : mode === "button" || mode === "radio"
        ? `${mode === "radio" ? "/Parent 10 0 R" : "/FT /Btn /V /Off"} /AS /Off /AP << /N << /Yes 8 0 R /Off 9 0 R >> >>`
        : "/FT /Tx";
  const reject =
    mode === "reject"
      ? '/AA << /V << /S /JavaScript /JS (this.getField\\("total"\\).value = event.value == "REJECTED" ? "SIDEWORD" : event.value; if \\(event.value == "REJECTED"\\) event.rc = false;) >> >>'
      : "";
  const appearance = (word: string) => {
    const stream = `BT /Helv 18 Tf 10 40 Td (${word}) Tj ET`;
    return `<< /Type /XObject /Subtype /Form /BBox [0 0 400 100] /Resources << /Font << /Helv 7 0 R >> >> /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  };
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${mode === "radio" ? 10 : 5} 0 R 6 0 R] /CO [6 0 R] /DR << /Font << /Helv 7 0 R >> >> >> >>`,
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [5 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [6 0 R] >>",
    `<< /Type /Annot /Subtype /Widget ${field} ${mode === "radio" ? "" : "/T (input)"} ${mode === "button" || mode === "radio" ? "" : `/V (${old})`} /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) ${reject} >>`,
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (total) /V (${old}) /Rect [100 300 500 400] /P 4 0 R /F 4 /DA (/Helv 18 Tf 0 g) ${mode === "reject" ? "" : '/AA << /C << /S /JavaScript /JS (event.value = this.getField\\("input"\\).value;) >> >>'} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    appearance("WORDON"),
    appearance("WORDOFF"),
    "<< /FT /Btn /Ff 32768 /T (input) /V /Off /Kids [5 0 R] >>",
  ]);
}

async function query(client: ControlClient, ...args: (string | number)[]): Promise<string> {
  const res = await client.request(ControlCommand.TestCurrentPdf, args);
  if (res[0] !== 0) throw new Error(`${args}: ${res[1]}`);
  return String(res[1]);
}

async function findCount(client: ControlClient, word: string, count: number): Promise<void> {
  await pollUntil(
    async () => String((await client.request(ControlCommand.TestFindResultsOrder, [word, 1]))[1]),
    (text) => text.startsWith(`OK n=${count} `),
    { error: (text) => `find count: expected ${count}: ${text}` },
  );
}

async function check(engine: string, mode: Mode): Promise<void> {
  const dir = tmpPath(`form-text-cache/${engine}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  writeFileSync(source, fixture(mode), "latin1");
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      const old = mode === "blank" ? "" : mode === "button" ? "Off" : "OLDWORD";
      const next = mode === "button" ? "Yes" : "NEWWORD";
      const initial = await client.setFormField(mode === "button" || mode === "blank" ? 2 : 1, 0, old || "BOOTSTRAP");
      if (initial[0] !== 0) throw new Error(String(initial[1]));
      const assertText = async (expected: string, absent: string) => {
        for (const page of [1, 2]) {
          for (const cache of ["cached-text", "editor-text"]) {
            const text = await query(client, cache, page);
            const word = mode === "button" && page === 1 ? (expected === "Yes" ? "WORDON" : "WORDOFF") : expected;
            const missing = mode === "button" && page === 1 ? (expected === "Yes" ? "WORDOFF" : "WORDON") : absent;
            if ((word && !text.includes(word)) || (missing && text.includes(missing)))
              throw new Error(`${engine} ${mode} ${cache} page ${page}, expected '${word}': ${text}`);
          }
        }
      };
      await assertText(old, next);
      if ((await query(client, "search-first", next)).includes("found=1"))
        throw new Error(`${engine} ${mode}: new value already searchable`);
      if (mode === "text") {
        await findCount(client, next, 0);
        const canvas = findCanvas(frame);
        const point = /pt=(-?\d+),(-?\d+)/.exec(await query(client, "widget-cursor", 1, 200, 350));
        if (!point) throw new Error("No form position");
        await clickAt(canvas, +point[1]!, +point[2]!, 0, 0, client);
        const edit = await pollUntil(
          () => findVisibleChildWindow(canvas, "Edit"),
          (h) => h !== 0,
        );
        sendText(edit, next);
        await pressEnter(edit);
        await findCount(client, next, 2);
      } else {
        const changed =
          mode === "button"
            ? await client.request(ControlCommand.TestToggleFormButton, [1, 0])
            : await client.setFormField(1, 0, next);
        if (changed[0] !== 0) throw new Error(String(changed[1]));
      }
      await assertText(next, old);
      const search = await query(client, "search-first", next);
      if (!search.includes("found=1")) throw new Error(`${engine} ${mode} repeat search: ${search}`);
      sendCommandSync(frame, cmdId("CmdToggleShowAnnotations"));
      sendCommandSync(frame, cmdId("CmdToggleShowAnnotations"));
      if (mode !== "button" && !(await query(client, "search-next")).includes("found=1"))
        throw new Error(`${engine} ${mode}: missing second match`);
      if ((await query(client, "search-next")).includes("found=1"))
        throw new Error(`${engine} ${mode}: unexpected extra match`);
      const selection = await client.seedTextSelection(2);
      if (selection.parts === 0) throw new Error(`${engine} ${mode}: empty selection`);
      sendCommandSync(frame, cmdId("CmdUndo"));
      await assertText(old, next);
      if (mode === "text") await findCount(client, next, 0);
      if ((await query(client, "search-next")).includes("found=1"))
        throw new Error(`${engine} ${mode}: stale FindNext after Undo`);
      sendCommandSync(frame, cmdId("CmdRedo"));
      await assertText(next, old);
      if (mode === "text") await findCount(client, next, 2);
      if (!(await query(client, "search-first", next)).includes("found=1"))
        throw new Error(`${engine} ${mode}: Redo not searchable`);
      if (mode === "reject") {
        const rejected = await client.setFormField(1, 0, "REJECTED");
        if (rejected[0] !== 1 || !String(rejected[1]).includes("after='NEWWORD'"))
          throw new Error(`not rejected: ${rejected[1]}`);
        for (const cache of ["cached-text", "editor-text"]) {
          const text = await query(client, cache, 2);
          if (!text.includes("SIDEWORD") || text.includes(next))
            throw new Error(`${engine} rejection ${cache}: ${text}`);
        }
      }
      console.log(`${engine} ${mode}: checked caches, search, selection and Undo/Redo`);
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, "-view", "single page", source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

async function choiceValidation(engine: string, javascript: boolean): Promise<void> {
  const dir = tmpPath(`choice-validation/${engine}-${javascript}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS_FILE), `UiLanguage = en\nDisableJavaScript = ${!javascript}\n`);
  const source = join(dir, "form.pdf");
  const saved = join(dir, "saved.pdf");
  writeFileSync(
    source,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
      "<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /Opt [(first) (second) (third)] /T (field) /V (first) /Rect [100 300 500 400] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) /AA << /V << /S /JavaScript /JS (if \\(event.value == 'second'\\) event.rc = false;) >> >> >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
    "latin1",
  );
  const options = { env: { ...process.env, SOLOKPDF_ENGINE: engine } };
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const result = await client.setFormField(1, 0, "second");
      const state = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      if (javascript) {
        if (
          result[0] !== 1 ||
          !String(result[1]).includes("before='first' after='first'") ||
          !state.includes("canUndo=0 canRedo=0 modified=0")
        )
          throw new Error(`${engine} rejected choice: ${result} ${state}`);
      } else if (result[0] !== 0 || !String(result[1]).includes("after='second'")) {
        throw new Error(`${engine} JavaScript disabled: ${result}`);
      }
      const accepted = await client.setFormField(1, 0, "third");
      if (accepted[0] !== 0 || !String(accepted[1]).includes("after='third'"))
        throw new Error(`${engine} accepted choice: ${accepted}`);
      await client.resolveUnsavedChanges("save-as", saved);
    },
    ["-appdata", dir, source],
    options,
  );
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const result = await client.setFormField(1, 0, "third");
      if (result[0] !== 0 || !String(result[1]).includes("before='third'"))
        throw new Error(`${engine} saved choice: ${result}`);
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, saved],
    options,
  );
}

async function rejectedSideEffect(engine: string, noJournal: boolean): Promise<void> {
  const dir = tmpPath(`form-rejected-side-effect/${engine}-${noJournal}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  writeFileSync(source, fixture("reject"), "latin1");
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const result = await client.setFormField(1, 0, "REJECTED");
      const state = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      const text = await query(client, "editor-text", 2);
      if (result[0] !== 1 || !String(result[1]).includes("after='OLDWORD'") || !text.includes("SIDEWORD"))
        throw new Error(`${engine}: expected rejection with side effect: ${result} ${text}`);
      if (!state.includes("modified=1")) throw new Error(`${engine}: side effect not marked modified: ${state}`);
      if (noJournal && !state.includes("canUndo=0")) throw new Error(`${engine}: unexpected journal: ${state}`);
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_NO_JOURNAL: noJournal ? "1" : "" } },
  );
}

async function rejectedCalculation(engine: string, preDirty: boolean): Promise<void> {
  const dir = tmpPath(`form-rejected-calculation/${engine}-${preDirty}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  writeFileSync(
    source,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] /CO [5 0 R] /DR << /Font << /Helv 6 0 R >> >> >> >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R 5 0 R] >>",
      "<< /Type /Annot /Subtype /Widget /FT /Tx /T (input) /V (OLD) /Rect [100 400 500 450] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) /AA << /V << /S /JavaScript /JS (e36trigger = 1; event.rc = false;) >> >> >>",
      '<< /Type /Annot /Subtype /Widget /FT /Tx /T (total) /V (OLD) /Rect [100 300 500 350] /P 3 0 R /F 4 /DA (/Helv 18 Tf 0 g) /AA << /C << /S /JavaScript /JS (if \\(typeof e36trigger != "undefined" && e36trigger\\) { e36trigger = 0; event.value = "SIDEWORD"; }) >> >> >>',
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
    "latin1",
  );
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      if (preDirty) {
        const previous = await client.setFormField(1, 1, "BASE");
        if (previous[0] !== 0) throw new Error(`${engine}: previous edit: ${previous}`);
      }
      const result = await client.setFormField(1, 0, "REJECTED");
      const state = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      const text = await query(client, "editor-text", 1);
      if (result[0] !== 1 || !String(result[1]).includes("after='OLD'") || !text.includes("SIDEWORD"))
        throw new Error(`${engine}: expected calculated side effect after rejection: ${result} ${text}`);
      if (!state.includes("canUndo=1") || !state.includes("modified=1"))
        throw new Error(`${engine}: calculated side effect not recorded: ${state}`);
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      sendCommandSync(frame, cmdId("CmdUndo"));
      const undone = await query(client, "editor-text", 1);
      if (undone.includes("SIDEWORD") || (preDirty && !undone.includes("BASE")))
        throw new Error(`${engine}: calculated side effect undo: ${undone}`);
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

async function failedRefresh(engine: string, mode: Mode, inject = true): Promise<void> {
  const dir = tmpPath(`form-failed-refresh/${engine}-${mode}-${inject}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "form.pdf");
  const saved = join(dir, "saved.pdf");
  writeFileSync(source, fixture(mode), "latin1");
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      const result =
        mode === "button" || mode === "radio"
          ? await client.request(ControlCommand.TestToggleFormButton, [1, 0])
          : await client.setFormField(1, 0, "NEWWORD");
      const state = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      const expected = mode === "button" || mode === "radio" ? "after='Yes'" : "after='NEWWORD'";
      if (!String(result[1]).includes(expected) || !state.includes("modified=1"))
        throw new Error(`${engine} ${mode}: committed edit lost after refresh failure: ${result} ${state}`);
      if (!String(result[1]).includes(`refreshFailed=${inject ? 1 : 0}`))
        throw new Error(`${engine} ${mode}: refresh error not reported: ${result}`);
      if ((mode === "button" || mode === "radio") && !String(result[1]).includes("toggled=1"))
        throw new Error(`${engine} ${mode}: committed toggle not reported: ${result}`);
      if (mode === "radio") {
        const pixels = /viewBefore=(\d+) viewAfter=(\d+)/.exec(String(result[1]));
        if (!pixels || pixels[1] === pixels[2]) throw new Error(`${engine} ${mode}: unchanged rendering: ${result}`);
      }
      if (mode !== "radio") {
        const word = mode === "button" || mode === "radio" ? "WORDON" : "NEWWORD";
        for (const cache of ["cached-text", "editor-text"]) {
          const text = await query(client, cache, 1);
          if (!text.includes(word)) throw new Error(`${engine} ${mode}: ${cache} after failure: ${text}`);
        }
        if (!(await query(client, "search-first", word)).includes("found=1"))
          throw new Error(`${engine} ${mode}: search missed committed value after failure`);
      }
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      sendCommandSync(frame, cmdId("CmdUndo"));
      const undone = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      if (!undone.includes("modified=0")) throw new Error(`${engine} ${mode}: undo: ${undone}`);
      sendCommandSync(frame, cmdId("CmdRedo"));
      const redone = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      if (!redone.includes("modified=1")) throw new Error(`${engine} ${mode}: redo: ${redone}`);
      await client.resolveUnsavedChanges("save-as", saved);
    },
    ["-appdata", dir, source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_EDIT_REFRESH_FAILURE: inject ? "1" : "" } },
  );
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const result =
        mode === "button" || mode === "radio"
          ? await client.request(ControlCommand.TestToggleFormButton, [1, 0])
          : await client.setFormField(1, 0, "NEWWORD");
      const expected = mode === "button" || mode === "radio" ? "before='Yes'" : "before='NEWWORD'";
      if (!String(result[1]).includes(expected)) throw new Error(`${engine} ${mode}: saved value: ${result}`);
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, saved],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

async function failedAnnotRefresh(engine: string): Promise<void> {
  const dir = tmpPath(`annot-failed-refresh/${engine}`);
  mkdirSync(dir, { recursive: true });
  const source = join(dir, "annot.pdf");
  const saved = join(dir, "saved.pdf");
  writeFileSync(
    source,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /DR << /Font << /Helv 5 0 R >> >> >> >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Annots [4 0 R] >>",
      "<< /Type /Annot /Subtype /FreeText /P 3 0 R /Rect [100 300 500 400] /Contents (OLD) /DA (/Helv 18 Tf 0 g) >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
    "latin1",
  );
  await withControlledSumatra(
    EXE,
    async (client, proc) => {
      await client.waitForRenderIdle();
      for (const cache of ["editor-text", "cached-text"]) {
        const text = await query(client, cache, 1);
        if (cache === "editor-text" && !text.includes("OLD"))
          throw new Error(`${engine}: initial annotation ${cache}: ${text}`);
      }
      const result = await query(client, "set-annot-contents", "NEW");
      const state = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      if (!result.includes("changed=1 before='OLD' after='NEW'") || !state.includes("modified=1"))
        throw new Error(`${engine}: annotation refresh failure: ${result} ${state}`);
      for (const cache of ["cached-text", "editor-text"]) {
        const text = await query(client, cache, 1);
        if (!text.includes("NEW") || text.includes("OLD"))
          throw new Error(`${engine}: annotation ${cache} after failure: ${text}`);
      }
      if (!(await query(client, "search-first", "NEW")).includes("found=1"))
        throw new Error(`${engine}: annotation search missed committed value`);
      const frame = await waitForTopWindow(proc.pid!, FRAME_CLASS);
      sendCommandSync(frame, cmdId("CmdUndo"));
      const undone = String((await client.request(ControlCommand.TestMarkupAnnots))[1]);
      if (!undone.includes("modified=0")) throw new Error(`${engine}: annotation undo: ${undone}`);
      sendCommandSync(frame, cmdId("CmdRedo"));
      await client.resolveUnsavedChanges("save-as", saved);
    },
    ["-appdata", dir, source],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine, SOLOKPDF_TEST_EDIT_REFRESH_FAILURE: "1" } },
  );
  await withControlledSumatra(
    EXE,
    async (client) => {
      await client.waitForRenderIdle();
      const result = await query(client, "set-annot-contents", "NEW");
      if (!result.includes("before='NEW'")) throw new Error(`${engine}: saved annotation: ${result}`);
      await client.resolveUnsavedChanges("discard");
    },
    ["-appdata", dir, saved],
    { env: { ...process.env, SOLOKPDF_ENGINE: engine } },
  );
}

export async function testit(): Promise<void> {
  if (USE_NG) {
    console.log("form-text-cache: skips ng's different control protocol");
    return;
  }
  for (const engine of ["mupdf", "pdfium"]) {
    await failedRefresh(engine, "radio", false);
    for (const preDirty of [false, true]) await rejectedCalculation(engine, preDirty);
    await failedAnnotRefresh(engine);
    for (const mode of ["text", "choice", "button", "radio"] as Mode[]) await failedRefresh(engine, mode);
    for (const noJournal of [false, true]) await rejectedSideEffect(engine, noJournal);
    for (const javascript of [true, false]) await choiceValidation(engine, javascript);
    for (const mode of ["text", "choice", "button", "blank", "reject"] as Mode[]) await check(engine, mode);
  }
}

if (import.meta.main) await runStandalone(testit);
