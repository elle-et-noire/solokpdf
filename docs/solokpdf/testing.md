# SolokPDF test setup

## Local Windows runs

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

### Desktop-dependent checks

| Check                                                | Hidden-desktop behavior                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ad-hoc-b68-window` foreground and z-order assertion | Skips when the never-shown desktop has no foreground window.                                             |
| `issue-6269` foreground branch                       | Skips locally without CI or `SOLOKPDF_REAL_DESKTOP=1`; its background Copy branch runs.                  |
| `overlay-scrollbar-theme`                            | Screen-pixel assertions need a visible input desktop.                                                    |
| `smart-scrollbars-autohide`                          | Screen-pixel assertions need a visible input desktop.                                                    |
| `taskbar-icon-contrast`                              | Skips with a message when the hidden desktop has no taskbar; compare pixels on a visible input desktop.  |
| System clipboard                                     | Shared by desktops in `WinSta0`; hidden windows do not isolate it. B67 tracks test-local clipboard work. |

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
viewers, log files and folder selection. The separate desktop is not an
absolute isolation boundary: a process can explicitly target the input
desktop, system services may show UI there, and the clipboard is shared.
Processes launched outside the runner's job need separate review.

The first hidden SolokPDF CI run passed 52/54 tests. `ad-hoc-vim-keys` and
`ad-hoc-count-prefix` had no focused frame and failed keyboard assertions;
both passed individually after activating their own frames. The full set was
run once, before those test changes.

Controlled Win32 tests send window messages and set an app-local cursor through
`-dbg-control` `TestCursorPosition` (155). Use `moveTestCursor()` in
`tests/win-automation.ts` before mouse messages; `clickAt()` does this for
clicks. Two screen coordinates set the position; a request without arguments
clears it. The response is the position. The override works even when a controlled run saves
settings without `-for-testing`; it never moves the Windows pointer.

With `-for-testing`, app windows open behind other windows without activation.
Tests that require foreground-only behavior activate their own frame through
`-dbg-control` `TestFocusState("activate")`.

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
process-local text sink, leaving the system clipboard untouched.
Copy is not a focusable virtual control, so its message-driven mouse-down
does not exercise the separate `SetFocus` guard.
`issue-3472`, `issue-6045`, and the
`ad-hoc-4600-*` tests still call `SetForegroundWindow`. Ng/mac
`moveTestCursor()` still moves the real pointer. An unlocked desktop is needed
for those native paths.

Run app-launching tests outside the Codex sandbox or any similarly restricted
runner. Inside it, WebView2 crashes with an
`msedgewebview2.exe - アプリケーション エラー` dialog and tests report
`browser not ready`.
