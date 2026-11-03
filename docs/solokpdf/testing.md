# SolokPDF test setup

Controlled Win32 tests send window messages and set an app-local cursor through
`-dbg-control` `TestCursorPosition` (155). Use `moveTestCursor()` in
`tests/win-automation.ts` before mouse messages; `clickAt()` does this for
clicks. Two screen coordinates set the position; a request without arguments
clears it. The response is the position. The override works even when a controlled run saves
settings without `-for-testing`; it never moves the Windows pointer.

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
controlled app window to leave the first frame in the background; it does not
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
