# SolokPDF test setup

## Local Windows runs

Build commands and output paths are in the [root readme](../../readme.md).
Palette and settings-screen changes apply under `-for-testing` without writing
the settings file. Use a dedicated `-appdata` without `-for-testing` only when
the test needs to verify persistence; it still runs on the hidden desktop.

Run every local test that can launch an app through the hidden-desktop runner,
outside the Codex sandbox. The runner creates a unique desktop in `WinSta0`,
checks it is not the input desktop, and never switches desktops. Ordinary child
windows stay off the owner's screen. It forwards output and exit status; a
timeout or Ctrl+C ends the process tree. The child inherits Windows error mode
flags that suppress hard-error and crash dialogs; the app also sets WER no-UI
mode under the runner. Crashes still fail tests.

```powershell
. ./tools/solokpdf/env.ps1
bun cmd/solok-build.ts -quick
bun tools/solokpdf/run-hidden.ts -- bun tests/issue-1914.ts --no-build
```

`--timeout-ms=N` before `--` changes the default ten-minute limit. Run the
test process itself through the runner, so any Bun child it launches inherits
the desktop. Keep `-for-testing` on ad-hoc app launches. Hosted CI still uses
its own invisible desktop.

The B69 probe (`tests/ad-hoc-b69-hidden-desktop.ts`) creates a visible window
and checks its desktop name against the input desktop. Run it first when
checking the runner. Local app tests must never run on the owner's desktop.

### Virtual sidebar trees

Bookmarks and favorites use virtual trees by default in Debug and Release.
The old opt-in environment variables have no effect. The Debug control probes
still require `-for-testing`; the displayed control matches normal launches.

Build once, then run the targeted tests through the hidden desktop:

```powershell
. ./tools/solokpdf/env.ps1
bun cmd/solok-build.ts -quick
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-tree-prototype.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-virtual-toc.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-virtual-favorites.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-virtual-tree-focus.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-vim-keys.ts --tree-only --no-build
```

The document-tree tests exercise the defaults without environment switches.
Additional lifetime, UIA/MSAA, large-tree and navigation checks are listed in the
[migration plan](tree-view-replacement-plan.md#検証). Rollout results are in
[history.md](history.md#virtual-sidebar-rollout-2026-11-09). Use
`tests/sidebar-tree.ts` for item counts, selection and row operations.
The tree probes remain outside `run-almost-all.ts`. The regular SolokPDF CI set
now includes `ad-hoc-virtual-toc`, `ad-hoc-virtual-favorites`,
`ad-hoc-virtual-tree-focus` and `ad-hoc-tree-lifetime`, using the shared list in
`tests/run-solokpdf-trees.ts`. Run only that group locally with:

```powershell
bun tools/solokpdf/run-hidden.ts -- bun tests/run-solokpdf-trees.ts --no-build
```

`--tree-only` runs the existing Vim test's tree navigation and custom shortcuts
without its document clipboard, dialog and link-hint checks.

E14's [validation record](history.md#e14-virtual-tree-encapsulation-2026-11-10)
maps encapsulation checks to the existing tests. `ad-hoc-tree-lifetime` includes
`event-name`, which destroys the tree synchronously during a name-change WinEvent.
Run startup/layout checks after builds finish; keep the executable hash fixed during each set.

### ASan builds

Build the PDFium-enabled static executable and stage both runtime DLLs with
the SolokPDF wrapper. It delegates to `cmd/build.ts`; no generated project
edits or direct MSBuild workaround are needed.

```powershell
. ./tools/solokpdf/env.ps1
bun cmd/solok-build.ts -asan
$env:SUMATRA_TEST_EXE = Join-Path $PWD 'out/dbg64_asan/SumatraPDF-static.exe'
$env:ASAN_OPTIONS = 'windows_hook_legacy_allocators=0:suppressions="' + (Join-Path $PWD 'asan.supp') + '"'
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-tree-lifetime.ts --no-build
```

Run app tests outside the sandbox, on the hidden desktop. The options match
the project's ASan debugger environment, disabling legacy-allocator hooks and
loading the checked-in suppressions. The test runner copies the ASan DLL into
its isolated executable directory. The wrapper does not create a portable ZIP.
The pinned PDFium DLL is not ASan-instrumented.
See [E16's results](history.md#e16-asan-build-path-2026-11-10) and the
[earlier workaround](history.md#e14-virtual-tree-encapsulation-2026-11-10).

### ASan CI

[solokpdf-asan.yml](../../.github/workflows/solokpdf-asan.yml) adds a manual
workflow and a weekly run on Tuesday at 17:23 UTC (Wednesday 02:23 JST).
It builds with `bun cmd/solok-build.ts -asan` on a fresh hosted runner.
Only `.work/pdfium` is cached; compiled outputs are not restored.

The workflow runs `ad-hoc-tree-lifetime` and
`ad-hoc-pdfium --fallback-only --no-build`. The latter reuses the existing
missing-DLL check without its cursor, dialog or screenshot checks. It verifies
search through MuPDF and the reported DLL-load error. The complete
`ad-hoc-pdfium` test still includes the same check.

For the same focused fallback check locally, use the ASan environment above:

```powershell
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-pdfium.ts --fallback-only --no-build
```

Build/test failures preserve their exit status and upload logs plus the final
test's scratch files as `solokpdf-asan-output`. The fallback step still runs if
the lifetime test fails, provided the build succeeded and the run was not canceled.
The prebuilt PDFium DLL remains uninstrumented.

GitHub requires the workflow on the default branch for
[scheduled and manual execution](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
The repository's default branch is `solokpdf-dev`. D13/E17 are committed as
`9083edafe`; dated hosted status is in the [validation record](history.md#hosted-snapshot-2026-11-10),
and remaining work is in the [backlog](backlog.md#next-steps).

### Physical tree checks

Narrator/NVDA, real monitor DPI changes, native scrollbar thumb dragging and
real-cursor smart-bar hover are manual checks. The owner reported all F2 checks
OK on 2026-11-09; see the [procedure and results](tree-view-screen-reader-check.md).
Rechecks use the owner's visible desktop; automated local
runs continue to use the hidden desktop.

### Keyboard input (E12/E13)

E12 is implemented in `1e49e9185`; its [coverage and results](keyboard-investigation.md#入力先共通化の結果e122026-11-09)
record eight passing targeted tests. Start with these baseline tests before and
after changing input classification.

```powershell
. ./tools/solokpdf/env.ps1
bun cmd/solok-build.ts -quick
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-vim-keys.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-count-prefix.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/keyboard-input-targets.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/find-history-alt-down.ts --no-build
```

Add `keyboard-ime`, `ad-hoc-virtual-tree-focus`, `issue-1841`, `issue-5971`,
`ad-hoc-shortcuts-dialog` or `command-palette-typing` only when the changed path needs them. `keyboard-ime`
may skip when Japanese IME is unavailable; a skip does not establish IME
behavior. Physical keys, OS hotkey conflicts and real IME operation are outside active scope by owner instruction (2026-11-10).
The [E13 coverage](keyboard-investigation.md#自動テストの経路確認e13) records the added paths.
`keyboard-input-targets` runs in the regular and SolokPDF CI sets; it skips ng.
`find-history-alt-down` sets the UI thread's Alt state and posts system-key
press/release pairs for both find UIs. Neither test generates physical keys.
For the affected special modes and Merge PDF, use `issue-5771`, `issue-6169`,
`issue-4684` and `issue-6372` when the changed path needs them.

### Settings application (E11)

For changes to application, saving or external reloads, use the existing
`command-palette-settings`, `adv-settings-home-reload` and
`adv-settings-external-reload` tests through the same runner. The first two
check both `-for-testing` and normal saving with dedicated settings files.
Recorded results are in [history.md](history.md#e11-settings-application-2026-11-09).

### Startup timeout diagnostics

`ad-hoc-pdfium-window-bg` writes a separate startup log for each app launch.
If the control pipe times out, it captures the live process before ending it:
window details, stderr, a thread dump and (when cdb is available) stacks.
CI also saves the matching executable and PDBs in the failure artifact.
Verify the capture locally with `bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-startup-diagnostics.ts --no-build`.
The forced-timeout test passed on both engines in hosted run 42522810078;
see the [D8 audit](history.md#d8-hosted-validation-audit-2026-11-09).

### Hosted follow-ups (D8)

`pdf-edit-toolbar-interaction` now prints `TestDpi` state before exercising
the toolbar. Record its `frame` DPI along with the result: 96 means 100%.
Local runs passed on both engines at 120 DPI (125%); they do not establish
the hosted 100% result. The two filtered hosted runs subsequently passed at
96 DPI on `3da0b8ee1`, completing D8. See the
[results and recheck commands](history.md#d8-hosted-validation-audit-2026-11-09).
No new full suite was run for D8.

### Desktop-dependent checks

| Check                                    | Hidden-desktop behavior                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ad-hoc-b68-window` foreground assertion | Skips when the never-shown desktop has no foreground window.                                                                                 |
| `issue-6269` foreground branch           | Skips locally without CI or `SOLOKPDF_REAL_DESKTOP=1`; its background Copy branch runs.                                                      |
| `overlay-scrollbar-theme`                | Screen-pixel assertions need a visible input desktop.                                                                                        |
| `smart-scrollbars-autohide`              | Screen-pixel assertions need a visible input desktop.                                                                                        |
| `taskbar-icon-contrast`                  | Skips with a message when the hidden desktop has no taskbar; compare pixels on a visible input desktop.                                      |
| System clipboard                         | Shared by desktops in `WinSta0`; `-for-testing` uses an app-local clipboard. Real clipboard tests require CI or `SOLOKPDF_REAL_CLIPBOARD=1`. |

The two skipped foreground branches need a visible input desktop for their
foreground assertions. Do not opt in to them during local hidden runs. DPI
awareness remains per process; window geometry and `PrintWindow` passed in the
hidden SolokPDF CI set (`issue-6113`, `ad-hoc-pdfium-window-bg`, thumbnail and
theme captures). Markdown WebView2 scrolling (`issue-6142`) and HTML loading
and thumbnail capture (`issue-6448`) also passed there. The older
`ad-hoc-md-find` probe fails at its find-bar locator: it expects `Edit` and
`Static` children, while the current bar uses a combo box and virtual status.
That failure is not established as desktop-specific.

The app blocks shell launches under `-for-testing`, including URLs, external
viewers, log files and folder selection. A test may set
`SOLOKPDF_REAL_SHELL_LAUNCH=1` for its app process only when it controls
the launch target and runs on CI or the hidden desktop. The separate desktop is not an
absolute isolation boundary: a process can explicitly target the input
desktop, system services may show UI there, and the clipboard is shared.
Processes launched outside the runner's job need separate review.

`-for-testing` stores text, bitmap, DIB, file-drop, and registered formats in
the app process. `-dbg-control` `TestClipboardText` sets and reads text;
`TestClipboardFormat` registers names, sets and reads format bytes, lists formats,
and reports the local sequence. Browser Copy stores selected text there; browser
Cut and Paste are blocked. Tests needing Windows clipboard synthesis or contention
run only in CI or with `SOLOKPDF_REAL_CLIPBOARD=1`.

The first hidden SolokPDF CI run passed 52/54 tests. `ad-hoc-vim-keys` and
`ad-hoc-count-prefix` had no focused frame and failed keyboard assertions;
both passed individually after activating their own frames. The full set was
run once, before those test changes.

Controlled Win32 tests send window messages and set an app-local cursor through
`-dbg-control` `TestCursorPosition` (169). Use `moveTestCursor()` in
`tests/win-automation.ts` before mouse messages; `clickAt()` does this for
clicks. Two screen coordinates set the position; a request without arguments
clears it. The response is the position. The override works even when a controlled run saves
settings without `-for-testing`; it never moves the Windows pointer.

With `-for-testing`, app windows open behind other windows without activation. Dialogs and new tabs opened by tests may take focus and activate on a visible desktop; local tests use the hidden desktop, so this is acceptable.
Tests that require foreground-only behavior activate their own frame through
`-dbg-control` `TestFocusState("activate")`. Tests that need normal window-state transitions can set
`SOLOKPDF_REAL_WINDOW_ACTIVATION=1` for their app process on CI or a hidden
desktop; this allows activation.

Loading `tests/winapi.ts` makes the test process per-monitor-v2 DPI aware.
Coordinates and captures therefore use physical pixels on scaled displays.
The cursor override cancels Windows mouse-leave tracking; send `WM_MOUSELEAVE`
when the test needs that transition.

`setTestWindowLayout()` defaults to `"rightHalf"`: the right half of the work
area, three quarters of its height. `run-almost-all.ts` selects it explicitly.
`run-github-ci.ts` selects `"workArea"` for the whole work area. App launch
helpers use `testWindowPos()` unless a test supplies its own position.

Original-app message-driven hover, clicks, selection and tab drag-out use the
test cursor without moving the real pointer. `issue-6269` opens a second
controlled app window to test the first frame in the background; it does not
call a foreground API on the local default run. It queries the UI thread's
`GetFocus()` and `GetActiveWindow()` before and after Copy mouse-down/up.
In CI or with `SOLOKPDF_REAL_DESKTOP=1`, it activates its test frame and
sends `WA_INACTIVE` to check the popup's activation guard. The Copy test uses a
process-local clipboard, leaving the system clipboard untouched.
Copy is not a focusable virtual control.
`issue-3472`, `issue-6045`, and the
`ad-hoc-4600-*` tests still call `SetForegroundWindow`. Ng/mac
`moveTestCursor()` still moves the real pointer. An unlocked desktop is needed
for those native paths.

Run app-launching tests outside the Codex sandbox or any similarly restricted
runner. Inside it, WebView2 crashes with an
`msedgewebview2.exe - アプリケーション エラー` dialog and tests report
`browser not ready`.

## Owner's manual acceptance (F1–F3)

Historical procedure: F2 passed by owner report on 2026-11-09. The owner removed
F1/F3 from active work on 2026-11-10; neither was marked passed. The procedure below
is retained for reference. Automated local runs follow the hidden desktop procedure above.

Use `-for-testing` and a dedicated `-appdata` directory, as in the
[tree procedure](tree-view-screen-reader-check.md#起動). Keep any custom test
settings there; changes made in test mode last only for that process.

| Item         | Procedure                                                              | Results                                                                               |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F1: printing | [Below](#printing-f1)                                                  | Append dated results under this section.                                              |
| F2: trees    | [Screen readers, scrollbars and DPI](tree-view-screen-reader-check.md) | OK by owner report, 2026-11-09; [results](tree-view-screen-reader-check.md#実施結果). |
| F3: keyboard | [Physical input checklist](keyboard-investigation.md#実機入力の確認f3) | Append dated results beside that checklist.                                           |

For each result, record the date, source commit, Debug/Release, engine, Windows
build, relevant device/software versions, settings and document used. Mark each
check passed, failed or untested; include actual behavior for failures and a
reason for skipped checks. These historical procedures do not reopen F1/F3
or add new test results.

### Printing (F1)

Print bitmap generation has passed; physical printing remains unverified. See
the [existing coverage](limitations.md#printing).

1. Open a representative PDF using PDFium. Open Print, check the selected
   printer, page range and available document print defaults, then cancel.
   Confirm that cancellation creates no spooler job.
2. Print a small page range to the physical printer. Check the queue reaches
   completion and the paper has the expected pages, orientation, scale and
   readable content. Record printer model, driver and print settings.
3. Repeat with `SOLOKPDF_ENGINE=mupdf` in the test process's environment to
   compare the same file and settings. Restore the environment after the run.
4. Record PDF export separately if checked. Successful bitmap generation or
   export alone does not establish physical-printer behavior.
