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
call `SetForegroundWindow`. The test still changes the system clipboard briefly
for Copy, saving and restoring its text. Other tests that exercise native
dialogs still call `SetForegroundWindow`; ng/mac automation can move the real
pointer. An unlocked desktop is needed for those native paths.

Run app-launching tests outside the Codex sandbox or any similarly restricted
runner. Inside it, WebView2 crashes with an
`msedgewebview2.exe - アプリケーション エラー` dialog and tests report
`browser not ready`.
