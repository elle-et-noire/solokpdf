# Test cursor

`-dbg-control` command 155 sets a process-local cursor position with two screen
coordinates and clears it with no arguments. App cursor queries use it until
cleared or the process exits. It is available in controlled runs that save
settings without `-for-testing`. It does not move the Windows pointer.

Use `moveTestCursor()` in `tests/win-automation.ts` before sending mouse
messages. It needs a controlled app. `clickAt()` does this automatically.
Controlled tests use physical pixel coordinates so cross-process mouse messages
reach the same point at non-100% DPI.
Windows mouse-leave tracking is canceled when the override is set; send
`WM_MOUSELEAVE` when a test needs one. OLE drag and drop still needs the real
pointer.
