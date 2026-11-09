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
The new tree probes are standalone tests, not entries in `run-almost-all.ts`.
`--tree-only` runs the existing Vim test's tree navigation and custom shortcuts
without its document clipboard, dialog and link-hint checks.

Narrator/NVDA, real monitor DPI changes, native scrollbar thumb dragging and
real-cursor smart-bar hover remain manual checks. The owner performs these
on their visible desktop using the
[screen-reader procedure](tree-view-screen-reader-check.md); automated local
runs continue to use the hidden desktop.

### Keyboard input (E12)

E12 is implemented in `1e49e9185`; its [coverage and results](keyboard-investigation.md#入力先共通化の結果e122026-11-09)
record eight passing targeted tests. Start with these baseline tests before and
after changing input classification.

```powershell
. ./tools/solokpdf/env.ps1
bun cmd/solok-build.ts -quick
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-vim-keys.ts --no-build
bun tools/solokpdf/run-hidden.ts -- bun tests/ad-hoc-count-prefix.ts --no-build
```

Add `keyboard-ime`, `ad-hoc-virtual-tree-focus`, `issue-1841`, `issue-5971`,
`ad-hoc-shortcuts-dialog` or `command-palette-typing` only when the changed path needs them. `keyboard-ime`
may skip when Japanese IME is unavailable; a skip does not establish IME
behavior. Physical keys, OS hotkey conflicts and real IME operation remain F3.
Uncovered routing paths are tracked in [E13](keyboard-investigation.md#自動テストの経路確認e13);
the existing passing checks do not establish their behavior.

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
