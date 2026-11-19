/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

#include "base/Base.h"

#if OS_WIN
#include "gui/Dpi.h"
#include "base/File.h"
#include "base/WinDynCalls.h"
#include "base/AutoWin.h"

#include <aclapi.h>
#include <float.h> // for _clearfp / _controlfp_s in MaskFpExceptions
#include <mlang.h>
#include "base/Pixmap.h"
#include "base/Win.h"
// the owned popups layer: Win32's own calls (Base.h routes the app's here and hides
// winuser.h's declarations)
#undef ShowWindow
#undef ShowWindowAsync
#undef SetWindowPos
#undef IsWindowVisible
#undef SetWindowPlacement
#undef DeferWindowPos
extern "C" {
WINUSERAPI BOOL WINAPI ShowWindow(HWND hWnd, int nCmdShow);
WINUSERAPI BOOL WINAPI ShowWindowAsync(HWND hWnd, int nCmdShow);
WINUSERAPI BOOL WINAPI SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, UINT uFlags);
WINUSERAPI BOOL WINAPI IsWindowVisible(HWND hWnd);
WINUSERAPI BOOL WINAPI SetWindowPlacement(HWND hWnd, const WINDOWPLACEMENT* lpwndpl);
WINUSERAPI HDWP WINAPI DeferWindowPos(HDWP hWinPosInfo, HWND hWnd, HWND hWndInsertAfter, int x, int y, int cx, int cy,
                                      UINT uFlags);
}
#include "base/Launch.h"

//--- subclass ids

static AtomicInt gSubclassId = 0;

UINT_PTR NextSubclassId() {
    int res = AtomicIntInc(&gSubclassId);
    return (UINT_PTR)res;
}

//--- HWND: geometry

Rect HwndClientRect(HWND hwnd) {
    RECT rc{};
    ::GetClientRect(hwnd, &rc);
    return {rc};
}

Rect HwndWindowRect(HWND hwnd) {
    RECT rc{};
    GetWindowRect(hwnd, &rc);
    return {rc};
}

void HwndInvalidateRect(HWND hwnd, Rect rect, bool erase) {
    if (rect.IsEmpty()) {
        return;
    }
    RECT r = ToRECT(rect);
    InvalidateRect(hwnd, &r, toBOOL(erase));
}

void HwndInvalidate(HWND hwnd, bool erase) {
    InvalidateRect(hwnd, nullptr, toBOOL(erase));
}

void HwndMoveWindow(HWND hwnd, Rect* r) {
    MoveWindow(hwnd, r->x, r->y, r->dx, r->dy, TRUE);
}

void HwndCenterDialog(HWND hDlg, HWND hParent) {
    if (!hParent) {
        hParent = GetParent(hDlg);
    }

    Rect rcDialog = HwndWindowRect(hDlg);
    rcDialog.Offset(-rcDialog.x, -rcDialog.y);
    Rect rcOwner = HwndWindowRect(hParent ? hParent : GetDesktopWindow());
    Rect rcRect = rcOwner;
    rcRect.Offset(-rcRect.x, -rcRect.y);

    // center dialog on its parent window
    rcDialog.Offset(rcOwner.x + ((rcRect.x - rcDialog.x + rcRect.dx - rcDialog.dx) / 2),
                    rcOwner.y + ((rcRect.y - rcDialog.y + rcRect.dy - rcDialog.dy) / 2));
    // ensure that the dialog is fully visible on one monitor
    rcDialog = ShiftRectToWorkArea(rcDialog, hParent, true);

    SetWindowPos(hDlg, nullptr, rcDialog.x, rcDialog.y, 0, 0, SWP_NOZORDER | SWP_NOSIZE | SWP_NOACTIVATE);
}

// change size of the window to have a given client size
void HwndResizeClientSize(HWND hwnd, int dx, int dy) {
    Size client = HwndClientRect(hwnd).Size();
    if (client.dx == dx && client.dy == dy) {
        return;
    }
    Rect rc = HwndWindowRect(hwnd);
    int x = rc.x;
    int y = rc.y;
    DWORD style = GetWindowStyle(hwnd);
    DWORD exStyle = GetWindowExStyle(hwnd);
    RECT r = {x, y, x + dx, y + dy};
    BOOL ok = AdjustWindowRectEx(&r, style, false, exStyle);
    ReportIf(!ok);
    int dx2 = RectDx(r);
    int dy2 = RectDy(r);
    ok = SetWindowPos(hwnd, nullptr, 0, 0, dx2, dy2, SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOREPOSITION);
    ReportIf(!ok);
}

void HwndPositionInCenterOf(HWND hwnd, HWND hwndRelative) {
    Rect rRelative = HwndWindowRect(hwndRelative);
    Rect r = HwndWindowRect(hwnd);
    int x = rRelative.x + (rRelative.dx / 2) - (r.dx / 2);
    int y = rRelative.y + (rRelative.dy / 2) - (r.dy / 2);

    Rect r2 = {x, y, r.dx, r.dy};
    r = ShiftRectToWorkArea(r2, hwndRelative, true);
    SetWindowPos(hwnd, nullptr, r.x, r.y, 0, 0, SWP_NOZORDER | SWP_NOSIZE | SWP_NOACTIVATE);
}

//--- HWND: screen / work area / placement

// fills ncm with non-client metrics (incl. font sizes) scaled for the given
// dpi, so UI fonts can be sized for the monitor a window is on and not just
// the system dpi. Uses SystemParametersInfoForDpi() (Win 10 1607+) when
// available, otherwise scales the system-dpi metrics manually.
bool GetNonClientMetricsForDpi(int dpi, NONCLIENTMETRICS* ncm) {
    ncm->cbSize = sizeof(*ncm);
    if (DynSystemParametersInfoForDpi &&
        DynSystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof(*ncm), ncm, 0, (UINT)dpi)) {
        return true;
    }
    if (!SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(*ncm), ncm, 0)) {
        return false;
    }
    int sysDpi = DpiGetForHwnd(nullptr);
    if (sysDpi <= 0 || sysDpi == dpi) {
        return true;
    }
    auto scaleLf = [sysDpi, dpi](LOGFONTW& lf) {
        int h = (int)std::abs(lf.lfHeight);
        lf.lfHeight = -MulDiv(h, dpi, sysDpi);
    };
    scaleLf(ncm->lfMessageFont);
    scaleLf(ncm->lfMenuFont);
    scaleLf(ncm->lfStatusFont);
    scaleLf(ncm->lfCaptionFont);
    scaleLf(ncm->lfSmCaptionFont);
    return true;
}

Rect ShiftRectToWorkArea(Rect rect, HWND hwnd, bool bFully) {
    Rect monitor = GetWorkAreaRect(rect, hwnd);

    if (rect.y + rect.dy <= monitor.y || bFully && rect.y < monitor.y) {
        /* Rectangle is too far above work area */
        rect.Offset(0, monitor.y - rect.y);
    } else if (rect.y >= monitor.y + monitor.dy || bFully && rect.y + rect.dy > monitor.y + monitor.dy) {
        /* Rectangle is too far below */
        rect.Offset(0, monitor.y - rect.y + monitor.dy - rect.dy);
    }

    if (rect.x + rect.dx <= monitor.x || bFully && rect.x < monitor.x) {
        /* Too far left */
        rect.Offset(monitor.x - rect.x, 0);
    } else if (rect.x >= monitor.x + monitor.dx || bFully && rect.x + rect.dx > monitor.x + monitor.dx) {
        /* Too far right */
        rect.Offset(monitor.x - rect.x + monitor.dx - rect.dx, 0);
    }

    return rect;
}

// Limits size to max available work area (screen size - taskbar)
Size HwndLimitSizeToScreen(HWND hwnd, Size size) {
    HMONITOR hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi{};
    mi.cbSize = sizeof mi;
    BOOL ok = GetMonitorInfo(hmon, &mi);
    if (!ok) {
        SystemParametersInfo(SPI_GETWORKAREA, 0, &mi.rcWork, 0);
    }
    int dx = RectDx(mi.rcWork);
    size.dx = std::min(size.dx, dx);
    int dy = RectDy(mi.rcWork);
    size.dy = std::min(size.dy, dy);
    return size;
}

// If the window is off-screen (e.g. a monitor was disconnected),
// move it to the nearest visible monitor's work area.
void HwndEnsureOnScreen(HWND hwnd) {
    if (!hwnd) {
        return;
    }
    Rect rect = HwndWindowRect(hwnd);
    if (rect.IsEmpty()) {
        return;
    }
    Rect shifted = ShiftRectToWorkArea(rect, nullptr, false);
    if (IsZoomed(hwnd)) {
        // for maximized windows, check if the window's non-maximized position
        // would be on a visible monitor; if not, move to primary and re-maximize
        WINDOWPLACEMENT wp{};
        wp.length = sizeof(wp);
        if (GetWindowPlacement(hwnd, &wp)) {
            Rect normal = ToRect(wp.rcNormalPosition);
            Rect normalShifted = ShiftRectToWorkArea(normal);
            if (normal != normalShifted) {
                wp.rcNormalPosition = ToRECT(normalShifted);
                SetWindowPlacement(hwnd, &wp);
            }
        }
        return;
    }
    if (rect == shifted) {
        return;
    }
    HwndMoveWindow(hwnd, &shifted);
}

// returns available area of the screen i.e. screen minus taskbar area
Rect GetWorkAreaRect(Rect rect, HWND hwnd) {
    RECT tmpRect = ToRECT(rect);
    HMONITOR hmon = MonitorFromRect(&tmpRect, MONITOR_DEFAULTTONEAREST);
    if (hwnd) {
        hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
    }
    MONITORINFO mi{};
    mi.cbSize = sizeof mi;
    BOOL ok = GetMonitorInfo(hmon, &mi);
    if (!ok) {
        SystemParametersInfo(SPI_GETWORKAREA, 0, &mi.rcWork, 0);
    }
    return ToRect(mi.rcWork);
}

// returns the dimensions the given window has to have in order to be a fullscreen window
Rect HwndGetFullscreenRect(HWND hwnd) {
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfo(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)) {
        return ToRect(mi.rcMonitor);
    }
    // fall back to the primary monitor
    return {0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)};
}

static BOOL CALLBACK GetMonitorRectProc(HMONITOR /*hMonitor*/, HDC /*hdc*/, LPRECT rcMonitor, LPARAM data) {
    Rect* rcAll = (Rect*)data;
    *rcAll = rcAll->Union(ToRect(*rcMonitor));
    return TRUE;
}

// returns the smallest rectangle that covers the entire virtual screen (all monitors)
Rect GetVirtualScreenRect() {
    Rect result(0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    EnumDisplayMonitors(nullptr, nullptr, GetMonitorRectProc, (LPARAM)&result);
    return result;
}

//--- HWND: coordinates

Rect HwndMapRectToWindow(Rect rect, HWND hwndFrom, HWND hwndTo) {
    RECT rc = ToRECT(rect);
    ::MapWindowPoints(hwndFrom, hwndTo, (LPPOINT)&rc, 2);
    return ToRect(rc);
}

// map client coords where x=0 is the physical left edge (even on WS_EX_LAYOUTRTL windows)
Rect HwndMapLtrClientRectToScreen(HWND hwnd, Rect r) {
    if (HwndIsRtl(hwnd)) {
        int w = HwndClientRect(hwnd).dx;
        r.x = w - r.x - r.dx;
    }
    return HwndMapRectToWindow(r, hwnd, nullptr);
}

// for SetWindowPos on a WS_EX_LAYOUTRTL parent: child x as offset from physical left
int HwndMapChildXForRtlParent(HWND parent, int ltrX, int childDx) {
    if (!HwndIsRtl(parent)) {
        return ltrX;
    }
    return HwndClientRect(parent).dx - ltrX - childDx;
}

Rect ChildPosWithinParent(HWND hwnd) {
    Point pt = HwndClientToScreen(GetParent(hwnd), Point());
    Rect rc = HwndWindowRect(hwnd);
    rc.Offset(-pt.x, -pt.y);
    return rc;
}

Point HwndMapWindowPoint(HWND hwndFrom, HWND hwndTo, Point p) {
    POINT pt = ToPOINT(p);
    ::MapWindowPoints(hwndFrom, hwndTo, &pt, 1);
    return {pt.x, pt.y};
}

Point HwndClientToScreen(HWND hwnd, Point p) {
    POINT pt = ToPOINT(p);
    ClientToScreen(hwnd, &pt);
    return {pt.x, pt.y};
}

Point HwndScreenToClient(HWND hwnd, Point p) {
    POINT pt = ToPOINT(p);
    ScreenToClient(hwnd, &pt);
    return {pt.x, pt.y};
}

//--- HWND: focus / visibility / Z-order

HWND HwndSetFocus(HWND hwnd) {
    return SetFocus(hwnd);
}

// GetFocus() is null when this thread is not the foreground thread;
// GUITHREADINFO still reports the window that would have focus.
HWND HwndThreadFocus() {
    HWND h = ::GetFocus();
    if (h) {
        return h;
    }
    GUITHREADINFO gti{};
    gti.cbSize = sizeof(gti);
    if (GetGUIThreadInfo(GetCurrentThreadId(), &gti)) {
        return gti.hwndFocus;
    }
    return nullptr;
}

// True while a menu (popup, menu bar or system menu) runs its nested message
// loop on this thread. Work dispatched from that loop runs underneath whatever
// the menu's caller has on its stack, so anything that frees state must wait.
bool IsThreadInMenuMode() {
    GUITHREADINFO gti{};
    gti.cbSize = sizeof(gti);
    if (!GetGUIThreadInfo(GetCurrentThreadId(), &gti)) {
        return false;
    }
    return (gti.flags & (GUI_INMENUMODE | GUI_POPUPMENUMODE | GUI_SYSTEMMENUMODE)) != 0;
}

// SetFocus() does not move this thread's focused window when the thread is not
// foreground. Attach to the foreground thread so Tab can leave a child HWND
// for a virtual control (posted-key tests, a dialog that is not active).
bool HwndSetFocusForce(HWND hwnd) {
    if (!hwnd) {
        return false;
    }
    if (HwndThreadFocus() == hwnd) {
        return true;
    }
    ::SetFocus(hwnd);
    if (HwndThreadFocus() == hwnd) {
        return true;
    }
    HWND hwndFg = GetForegroundWindow();
    DWORD fgTid = hwndFg ? GetWindowThreadProcessId(hwndFg, nullptr) : 0;
    DWORD ourTid = GetCurrentThreadId();
    if (!fgTid || fgTid == ourTid) {
        return false;
    }
    if (!AttachThreadInput(ourTid, fgTid, TRUE)) {
        return false;
    }
    ::SetFocus(hwnd);
    AttachThreadInput(ourTid, fgTid, FALSE);
    return HwndThreadFocus() == hwnd;
}

bool HwndIsFocused(HWND hwnd) {
    return GetFocus() == hwnd;
}

// TabTip / osk / TextInputHost. A Contents or in-place edit that closes on
// WM_KILLFOCUS would vanish when the tablet keyboard takes focus.
bool HwndIsOnScreenKeyboard(HWND hwnd) {
    if (!hwnd) {
        return false;
    }
    WCHAR clsW[64]{};
    GetClassNameW(hwnd, clsW, dimof(clsW));
    TempStr cls = ToUtf8Temp(clsW);
    if (str::StartsWithI(cls, StrL("IPTip")) || str::EqI(cls, StrL("OSKMainClass"))) {
        return true;
    }
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) {
        return false;
    }
    AutoCloseHandle hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProc.IsValid()) {
        return false;
    }
    WCHAR pathW[MAX_PATH]{};
    DWORD pathLen = MAX_PATH;
    if (!QueryFullProcessImageNameW(hProc, 0, pathW, &pathLen)) {
        return false;
    }
    TempStr name = path::GetBaseNameTemp(ToUtf8Temp(pathW));
    static SeqStrings kOskExes = "TabTip.exe\0osk.exe\0TextInputHost.exe\0";
    return SeqStrIndexIS(kOskExes, name) >= 0;
}

void HwndToForeground(HWND hwnd) {
    if (IsIconic(hwnd)) {
        ShowWindow(hwnd, SW_RESTORE);
    }
    SetForegroundWindow(hwnd);
}

static bool IsHiddenWithFrame(HWND hwnd);

// Also a popup hidden with its minimized frame: like a child window's, its
// visibility doesn't change with the frame's minimize. Safe on any thread.
bool HwndIsVisible(HWND hwnd) {
    return ::IsWindowVisible(hwnd) || IsHiddenWithFrame(hwnd);
}

// Shown now, unlike a popup hidden with its minimized frame (HwndIsVisible()).
bool HwndIsOnScreen(HWND hwnd) {
    return ::IsWindowVisible(hwnd);
}

// The top-level window at the end of hwnd's owner chain, e.g. the frame of a window
// it owns. GetAncestor(GA_ROOTOWNER) follows GetParent(), which skips the owner of
// an overlapped window (Merge PDF, the PDF tool dialogs).
HWND HwndRootOwner(HWND hwnd) {
    HWND root = GetAncestor(hwnd, GA_ROOT);
    for (HWND owner = root; owner; owner = GetWindow(owner, GW_OWNER)) {
        root = owner;
    }
    return root;
}

// Gives `to` the focus if the focus is in `from` (from or a window in it). A focus move
// made on the app's behalf, not by the user's input, takes the focus only from a window
// its mover owns: a deferred one may find it in another app or window the user went to.
// A null `from` is no focus on the thread, or the on-screen keyboard's, while to's frame
// is still active: the keyboard took it.
bool HwndMoveFocus(HWND from, HWND to) {
    HWND focus = HwndThreadFocus();
    if (!to) {
        return false;
    }
    if (focus == to) {
        return true;
    }
    if (from && focus != from && !IsChild(from, focus)) {
        return false;
    }
    HWND active = GetActiveWindow();
    bool keyboard = !focus || HwndIsOnScreenKeyboard(focus);
    if (!from && (!keyboard || !active || HwndRootOwner(active) != HwndRootOwner(to))) {
        return false;
    }
    SetFocus(to);
    focus = HwndThreadFocus();
    return focus == to || IsChild(to, focus);
}

void HwndSetVisible(HWND hwnd, bool visible) {
    if (!visible) {
        HwndShowWindow(hwnd, SW_HIDE);
        return;
    }
    if (!HwndIsVisible(hwnd)) {
        ShowWindow(hwnd, SW_SHOW);
    }
}

//--- HWND: styles / RTL / chrome

Point& UnmirrorRtl(HWND hwnd, Point& p) {
    if (!HwndIsRtl(hwnd)) return p;
    p.x = HwndClientRect(hwnd).dx - 1 - p.x;
    return p;
}

static void HwndSetWindowStyle(HWND hwnd, DWORD flags, bool enable, int type) {
    DWORD style = GetWindowLongW(hwnd, type);
    // WS_VISIBLE doesn't show or hide a top-level window: an owned one goes through
    // ShowWindow(), which the owned popups layer sees
    bool topLevel = type == GWL_STYLE && !(style & WS_CHILD);
    ReportIf(topLevel && (flags & WS_VISIBLE) && HwndRootOwner(hwnd) != hwnd);
    DWORD newStyle;
    if (enable) {
        newStyle = style | flags;
    } else {
        newStyle = style & ~flags;
    }
    if (newStyle != style) {
        SetWindowLongW(hwnd, type, (LONG)newStyle);
    }
}

bool HwndIsWindowStyleSet(HWND hwnd, DWORD flags) {
    DWORD style = GetWindowLongW(hwnd, GWL_STYLE);
    return bit::IsMaskSet<DWORD>(style, flags);
}

bool HwndIsRtl(HWND hwnd) {
    DWORD style = GetWindowLongW(hwnd, GWL_EXSTYLE);
    return bit::IsMaskSet<DWORD>(style, WS_EX_LAYOUTRTL);
}

static void HwndSetWindowExStyle(HWND hwnd, DWORD flags, bool enable) {
    HwndSetWindowStyle(hwnd, flags, enable, GWL_EXSTYLE);
}

void HwndSetRtl(HWND hwnd, bool isRtl) {
    HwndSetWindowExStyle(hwnd, WS_EX_LAYOUTRTL | WS_EX_NOINHERITLAYOUT, isRtl);
}

void HwndSetWindowStyle(HWND hwnd, DWORD flags, bool enable) {
    HwndSetWindowStyle(hwnd, flags, enable, GWL_STYLE);
}

//--- HWND: text / font / icon / paint

int HwndGetTextLen(HWND hwnd) {
    return (int)SendMessageW(hwnd, WM_GETTEXTLENGTH, 0, 0);
}

// return text of window or edit control, nullptr in case of an error
TempWStr HwndGetTextWTemp(HWND hwnd) {
    int cch = HwndGetTextLen(hwnd);
    WCHAR* buf = AllocArrayTemp<WCHAR>(cch + 2); // +2 for extra room
    if (!buf) {
        return {};
    }
    LRESULT copied = SendMessageW(hwnd, WM_GETTEXT, cch + 1, (LPARAM)buf);
    return WStr(buf, (int)copied);
}

// return text of window or edit control, nullptr in case of an error
TempStr HwndGetTextTemp(HWND hwnd) {
    return ToUtf8Temp(HwndGetTextWTemp(hwnd));
}

void HwndSetText(HWND hwnd, Str sv) {
    // can be called before a window is created
    if (!hwnd) {
        return;
    }
    if (len(sv) == 0) {
        sv = Str();
    }
    // WM_SETTEXT unconditionally invalidates and repaints the control (and, for
    // edit controls, fires EN_CHANGE and resets the caret/selection). Skip it
    // when the text is unchanged so callers don't cause needless repaints /
    // flicker (e.g. the toolbar page box on Back when the page doesn't change).
    // Every caller is fine with this: those that need a re-search/notification on
    // unchanged text trigger it explicitly, not via the EN_CHANGE side effect.
    TempStr current = HwndGetTextTemp(hwnd);
    if (current && str::Eq(current, sv)) {
        return;
    }
    WCHAR* ws = CWStrTemp(sv);
    SendMessageW(hwnd, WM_SETTEXT, 0, (LPARAM)ws);
}

void HwndSetDlgItemText(HWND hDlg, int itemID, Str s) {
    WCHAR* ws = CWStrTemp(s);
    SetDlgItemTextW(hDlg, itemID, ws);
}

// https://docs.microsoft.com/en-us/windows/win32/winmsg/wm-seticon
HICON HwndSetIcon(HWND hwnd, HICON icon) {
    if (!hwnd || !icon) {
        return nullptr;
    }
    HICON res = (HICON)SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)icon);
    return res;
}

// schedule WM_PAINT at window's leasure
void HwndScheduleRepaint(HWND hwnd) {
    if (!hwnd || !::IsWindow(hwnd)) {
        return;
    }
    HwndInvalidate(hwnd);
}

// do WM_PAINT immediately
void HwndRepaintNow(HWND hwnd) {
    if (!hwnd || !::IsWindow(hwnd)) {
        return;
    }
    if (!IsWindowVisible(hwnd)) {
        return;
    }
    HwndInvalidate(hwnd);
    // send WM_PAINT right away (normally would wait for empty msg queue)
    UpdateWindow(hwnd);
}

void HwndSetFont(HWND hwnd, HFONT font) {
    if (!hwnd || !font) {
        return;
    }
    SetWindowFont(hwnd, font, TRUE);
}

static BOOL CALLBACK SetFontChildProc(HWND hwnd, LPARAM lp) {
    SetWindowFont(hwnd, (HFONT)lp, TRUE);
    return TRUE;
}

// Set the font on hwnd and every descendant. Handy after a DPI change, when the
// whole dialog has to move to a font scaled for the new DPI.
void HwndSetFontForWindowAndItsChildren(HWND hwnd, HFONT font) {
    if (!hwnd || !font) {
        return;
    }
    SetWindowFont(hwnd, font, TRUE);
    EnumChildWindows(hwnd, SetFontChildProc, (LPARAM)font);
}

void HwndSetTreeFontForDpi(HWND hwndTree, HFONT font, int dpi) {
    if (!hwndTree || !font) {
        return;
    }
    if (dpi <= 0) {
        dpi = RoundUp(DpiGetForHwnd(hwndTree), 4);
    }
    HwndSetFont(hwndTree, font);
    HDC dc = GetDC(hwndTree);
    if (!dc) {
        return;
    }
    {
        AutoRestoreFont selectFont(dc, font);
        TEXTMETRICW tm{};
        if (GetTextMetricsW(dc, &tm)) {
            int itemH = tm.tmHeight + tm.tmExternalLeading + MulDiv(4, dpi, 96);
            SendMessageW(hwndTree, TVM_SETITEMHEIGHT, (WPARAM)itemH, 0);
        }
    }
    ReleaseDC(hwndTree, dc);
}

//--- HWND: identity / parent / lifecycle / messages

HWND HwndGetParent(HWND hwnd) {
    return ::GetParent(hwnd);
}

TempStr HwndGetClassName(HWND hwnd) {
    WCHAR buf[512] = {};
    int n = GetClassNameW(hwnd, buf, dimof(buf));
    ReportIf(n == 0);
    return ToUtf8Temp(buf);
}

void HwndSendCommand(HWND hwnd, int cmdId, LPARAM lp) {
    SendMessageW(hwnd, WM_COMMAND, (WPARAM)cmdId, lp);
}

void HwndPostCommand(HWND hwnd, int cmdId, LPARAM lp) {
    PostMessageW(hwnd, WM_COMMAND, (WPARAM)cmdId, lp);
}

void HwndDestroyWindowSafe(HWND* hwndPtr) {
    auto* hwnd = *hwndPtr;
    *hwndPtr = nullptr;

    if (!hwnd || !::IsWindow(hwnd)) {
        return;
    }
    ::DestroyWindow(hwnd);
}

//--- edit control

void EditSelectAll(HWND hwnd) {
    Edit_SetSel(hwnd, 0, -1);
}

void EditSelectText(HWND hwnd, int start, int end) {
    Edit_SetSel(hwnd, start, end);
}

void EditGetSelection(HWND hwnd, int& start, int& end) {
    start = 0;
    end = 0;
    if (!hwnd) {
        return;
    }
    DWORD sel = (DWORD)Edit_GetSel(hwnd);
    start = (int)LOWORD(sel);
    end = (int)HIWORD(sel);
}

void EditSetCursorPos(HWND hwnd, int pos) {
    if (!hwnd) {
        return;
    }
    EditSelectText(hwnd, pos, pos);
}

void EditSetCursorPosAtEnd(HWND hwnd) {
    EditSetCursorPos(hwnd, EditGetTextLen(hwnd));
}

int EditGetTextLen(HWND hwnd) {
    return hwnd ? HwndGetTextLen(hwnd) : 0;
}

void EditSetModified(HWND hwnd, bool on) {
    if (!hwnd) {
        return;
    }
    Edit_SetModify(hwnd, on);
}

bool EditIsModified(HWND hwnd) {
    return hwnd && Edit_GetModify(hwnd);
}

void EditSetCueText(HWND hwnd, Str s) {
    if (!hwnd) {
        return;
    }
    Edit_SetCueBannerText(hwnd, CWStrTemp(s));
}

void EditSetMargins(HWND hwnd, int left, int right) {
    if (!hwnd) {
        return;
    }
    SendMessageW(hwnd, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(left, right));
}

void EditSetNumbersOnly(HWND hwnd, bool on) {
    if (!hwnd) {
        return;
    }
    HwndSetWindowStyle(hwnd, ES_NUMBER, on);
}

void EditSetPasswordVisible(HWND hwnd, bool show) {
    if (!hwnd) {
        return;
    }
    SendMessageW(hwnd, EM_SETPASSWORDCHAR, show ? 0 : (WPARAM)L'\x25CF', 0);
    HwndInvalidate(hwnd, true);
}

// Ctrl+Backspace reaches an edit as WM_CHAR 0x7F, which it would insert as a box.
// Call on WM_CHAR: for 0x7F, deletes the selection or the word before the caret.
bool EditHandleCtrlBack(HWND hwnd, WPARAM ch) {
    constexpr WPARAM kCtrlBackChar = 0x7F;
    if (!hwnd || ch != kCtrlBackChar) {
        return false;
    }
    int selStart = 0;
    int selEnd = 0;
    EditGetSelection(hwnd, selStart, selEnd);
    if (selStart == selEnd) {
        // "foo bar  |" => "foo |"
        TempWStr text = HwndGetTextWTemp(hwnd);
        selStart = std::min(selStart, len(text));
        for (; selStart > 0 && wstr::IsWs(text.s[selStart - 1]); selStart--) {
            ;
        }
        for (; selStart > 0 && !wstr::IsWs(text.s[selStart - 1]); selStart--) {
            ;
        }
        EditSelectText(hwnd, selStart, selEnd);
    }
    SendMessageW(hwnd, WM_CLEAR, 0, 0);
    return true;
}

//--- list box

int LbAddString(HWND hwnd, WStr text) {
    return (int)SendMessageW(hwnd, LB_ADDSTRING, 0, (LPARAM)CWStrTemp(text));
}

int LbAddString(HWND hwnd, Str text) {
    return LbAddString(hwnd, ToWStrTemp(text));
}

int LbGetCurrentSelection(HWND hwnd) {
    return (int)SendMessageW(hwnd, LB_GETCURSEL, 0, 0);
}

bool LbSetCurrentSelection(HWND hwnd, int idx) {
    LRESULT res = SendMessageW(hwnd, LB_SETCURSEL, (WPARAM)idx, 0);
    return idx < 0 || res != LB_ERR;
}

TempWStr LbGetTextTemp(HWND hwnd, int idx) {
    int len = (int)SendMessageW(hwnd, LB_GETTEXTLEN, (WPARAM)idx, 0);
    if (len == LB_ERR) {
        return {};
    }
    TempWStr text = AllocArrayTemp<WCHAR>(len + 1);
    LRESULT res = SendMessageW(hwnd, LB_GETTEXT, (WPARAM)idx, (LPARAM)text.s);
    if (res == LB_ERR) {
        return {};
    }
    text.len = (int)res;
    return text;
}

void LbSetItemHeight(HWND hwnd, int idx, int height) {
    SendMessageW(hwnd, LB_SETITEMHEIGHT, (WPARAM)idx, (LPARAM)height);
}

//--- combo box

// hwnd should be a Combo Box control

void CbResetContent(HWND hwnd) {
    SendMessageW(hwnd, CB_RESETCONTENT, 0, 0);
}

void CbAddString(HWND hwnd, Str s) {
    WCHAR* ws = CWStrTemp(s);
    SendMessageW(hwnd, CB_ADDSTRING, 0, (LPARAM)ws);
}

int CbGetItemsCount(HWND hwnd) {
    if (!hwnd) {
        return 0;
    }
    int n = (int)SendMessageW(hwnd, CB_GETCOUNT, 0, 0);
    return n < 0 ? 0 : n;
}

// unlike CbResetContent() / CbAddString(), these leave an editable combo's
// edit control untouched, so they can rebuild the list under a user who is
// still typing
void CbInsertString(HWND hwnd, int idx, Str s) {
    WCHAR* ws = CWStrTemp(s);
    SendMessageW(hwnd, CB_INSERTSTRING, (WPARAM)idx, (LPARAM)ws);
}

void CbDeleteString(HWND hwnd, int idx) {
    SendMessageW(hwnd, CB_DELETESTRING, (WPARAM)idx, 0);
}

void CbSetCueBanner(HWND hwnd, Str s) {
    if (!hwnd) {
        return;
    }
    SendMessageW(hwnd, CB_SETCUEBANNER, 0, (LPARAM)CWStrTemp(s));
}

// how many items the drop-down list shows before it scrolls
void CbSetMinVisible(HWND hwnd, int n) {
    SendMessageW(hwnd, CB_SETMINVISIBLE, (WPARAM)n, 0);
}

// idx of -1 sets the height of the always-visible selection field
void CbSetItemHeight(HWND hwnd, int idx, int dy) {
    SendMessageW(hwnd, CB_SETITEMHEIGHT, (WPARAM)idx, (LPARAM)dy);
}

int CbGetTextLen(HWND hwnd) {
    return hwnd ? HwndGetTextLen(hwnd) : 0;
}

// true while the drop-down list is showing
bool CbIsDropped(HWND hwnd) {
    return hwnd && SendMessageW(hwnd, CB_GETDROPPEDSTATE, 0, 0);
}

// which item of the drop-down list is selected. -1 means none, which is also
// what a null hwnd reports
int CbGetCurrentSelection(HWND hwnd) {
    if (!hwnd) {
        return -1;
    }
    return (int)SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
}

// -1 : no selection
void CbSetCurrentSelection(HWND hwnd, int selIdx) {
    SendMessageW(hwnd, CB_SETCURSEL, (WPARAM)selIdx, 0);
}

// the edit control an editable combo keeps the text and keyboard focus in,
// null for a CBS_DROPDOWNLIST combo (which has no edit)
HWND CbEditHwnd(HWND hwnd) {
    if (!hwnd) {
        return nullptr;
    }
    COMBOBOXINFO info{};
    info.cbSize = sizeof(info);
    if (!GetComboBoxInfo(hwnd, &info)) {
        return nullptr;
    }
    return info.hwndItem;
}

void CbEditSelectAll(HWND hwnd) {
    CbEditSelectText(hwnd, 0, -1);
}

// The text selection within the edit, not the selected drop-down list item.
// Goes to the edit control rather than through the combo's CB_SETEDITSEL /
// CB_GETEDITSEL: those are packed into a LPARAM's two WORDs (so they can't say
// anything past 65535) and the combo drops CB_SETEDITSEL while it is itself
// setting the edit's text, which loses the caret.
void CbEditSelectText(HWND hwnd, int start, int end) {
    HWND edit = CbEditHwnd(hwnd);
    if (!edit) {
        return;
    }
    SendMessageW(edit, EM_SETSEL, (WPARAM)start, (LPARAM)end);
}

void CbEditGetSelection(HWND hwnd, int& start, int& end) {
    start = 0;
    end = 0;
    HWND edit = CbEditHwnd(hwnd);
    if (!edit) {
        return;
    }
    DWORD s = 0, e = 0;
    SendMessageW(edit, EM_GETSEL, (WPARAM)&s, (LPARAM)&e);
    start = (int)s;
    end = (int)e;
}

void CbEditSetModified(HWND hwnd, bool on) {
    EditSetModified(CbEditHwnd(hwnd), on);
}

bool CbEditIsModified(HWND hwnd) {
    return EditIsModified(CbEditHwnd(hwnd));
}

//--- toolbar

void TbSetButtonStructSize(HWND hwnd, int size) {
    SendMessageW(hwnd, TB_BUTTONSTRUCTSIZE, (WPARAM)size, 0);
}

void TbAddButtons(HWND hwnd, int count, const TBBUTTON* buttons) {
    auto res = SendMessageW(hwnd, TB_ADDBUTTONS, count, (LPARAM)buttons);
    ReportDebugIf(0 == res);
}

void TbAutoSize(HWND hwnd) {
    SendMessageW(hwnd, TB_AUTOSIZE, 0, 0);
}

int TbGetButtonCount(HWND hwnd) {
    return (int)SendMessageW(hwnd, TB_BUTTONCOUNT, 0, 0);
}

DWORD TbGetExtendedStyle(HWND hwnd) {
    return (DWORD)SendMessageW(hwnd, TB_GETEXTENDEDSTYLE, 0, 0);
}

void TbSetExtendedStyle(HWND hwnd, DWORD style) {
    SendMessageW(hwnd, TB_SETEXTENDEDSTYLE, 0, style);
}

Rect TbGetItemRect(HWND hwnd, int buttonIdx) {
    if (!hwnd) {
        return {};
    }
    RECT rc{};
    auto res = SendMessageW(hwnd, TB_GETITEMRECT, buttonIdx, (LPARAM)&rc);
    if (res == 0) {
        logf("TbGetItemRect: hwnd=0x%p, buttonIdx: %d\n", hwnd, buttonIdx);
        LogLastError();
        ReportIf(res == 0);
    }
    return {rc};
}

//--- tree view

void TreeViewExpandRecursively(HWND hTree, HTREEITEM hItem, uint flag, bool subtree) {
    while (hItem) {
        TreeView_Expand(hTree, hItem, flag);
        HTREEITEM child = TreeView_GetChild(hTree, hItem);
        if (child) {
            TreeViewExpandRecursively(hTree, child, flag, false);
        }
        if (subtree) {
            break;
        }
        hItem = TreeView_GetNextSibling(hTree, hItem);
    }
}

//--- dialogs / message boxes

int MsgBox(HWND hwnd, Str text, Str caption, UINT flags) {
    WCHAR* textW = CWStrTemp(text);
    WCHAR* captionW = CWStrTemp(caption);
    return MessageBoxW(hwnd, textW, captionW, flags);
}

void MsgBoxWarning(HWND hwnd, Str msg, Str title) {
    if (len(title) == 0) {
        title = StrL("Warning");
    }
    MsgBox(hwnd, msg, title, MB_OK | MB_ICONEXCLAMATION);
}

//--- GDI: draw / measure

void HdcDrawRect(HDC hdc, const Rect& rect) {
    MoveToEx(hdc, rect.x, rect.y, nullptr);
    LineTo(hdc, rect.x + rect.dx - 1, rect.y);
    LineTo(hdc, rect.x + rect.dx - 1, rect.y + rect.dy - 1);
    LineTo(hdc, rect.x, rect.y + rect.dy - 1);
    LineTo(hdc, rect.x, rect.y);
}

void HdcFillRect(HDC hdc, const Rect& rect, HBRUSH br) {
    RECT r = ToRECT(rect);
    ::FillRect(hdc, &r, br);
}

void HdcFillRect(HDC hdc, const Rect& rect, Color col) {
    AutoDeleteBrush br(CreateSolidBrush(col));
    RECT r = ToRECT(rect);
    ::FillRect(hdc, &r, br);
}

// returns previously focused window

int HdcDrawText(HDC hdc, WStr s, const Rect& r, uint format, HFONT font) {
    ReportIf(format & DT_CALCRECT);
    if (len(s) == 0) {
        return 0;
    }
    AutoRestoreFont f(hdc, font);
    RECT r2 = ToRECT(r);
    return DrawTextW(hdc, s.s, s.len, &r2, format);
}

int HdcDrawText(HDC hdc, Str s, const Rect& r, uint format, HFONT font) {
    return HdcDrawText(hdc, ToWStrTemp(s), r, format, font);
}

int HdcDrawText(HDC hdc, Str s, const Point& pos, uint format, HFONT font) {
    Rect r = {pos.x, pos.y, 0, 0};
    return HdcDrawText(hdc, s, r, format, font);
}

int HdcDrawText(HDC hdc, WStr s, const Point& pos, uint format, HFONT font) {
    Rect r = {pos.x, pos.y, 0, 0};
    return HdcDrawText(hdc, s, r, format, font);
}

static Rect HdcMeasureWithDrawText(HDC hdc, WStr s, Rect r, uint format, HFONT font) {
    if (len(s) == 0) {
        return r;
    }
    AutoRestoreFont f(hdc, font);
    RECT r2 = ToRECT(r);
    DrawTextW(hdc, s.s, s.len, &r2, format | DT_CALCRECT);
    return ToRect(r2);
}

static Rect HdcMeasureWithDrawText(HDC hdc, Str s, Rect r, uint format, HFONT font) {
    return HdcMeasureWithDrawText(hdc, ToWStrTemp(s), r, format, font);
}

// uses the same logic as HdcDrawText
// maxDx limits the width, used when measuring text wrapped with DT_WORDBREAK
Size HdcMeasureText(HDC hdc, Str s, int maxDx, uint format, HFONT font) {
    if (len(s) == 0) {
        return {};
    }
    Rect bounds = {0, 0, maxDx, 4096};
    Rect measured = HdcMeasureWithDrawText(hdc, s, bounds, format, font);
    return {measured.dx, measured.dy};
}

void HdcDrawCenteredText(HDC hdc, Rect r, Str txt, bool isRTL) {
    int prevMode = SetBkMode(hdc, TRANSPARENT);
    uint format = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX;
    if (isRTL) {
        format |= DT_RTLREADING;
    }
    HdcDrawText(hdc, txt, r, format);
    if (prevMode != 0) {
        SetBkMode(hdc, prevMode);
    }
}

void HdcPaintCheckerboard(HDC hdc, int x, int y, int w, int h) {
    constexpr int kCheckerSize = 8;
    Color lightColor = kColWhite;
    Color darkColor = MkRgb(204, 204, 204);
    HBRUSH lightBrush = CreateSolidBrush(lightColor);
    HBRUSH darkBrush = CreateSolidBrush(darkColor);

    for (int cy = 0; cy < h; cy += kCheckerSize) {
        for (int cx = 0; cx < w; cx += kCheckerSize) {
            int cellW = std::min(kCheckerSize, w - cx);
            int cellH = std::min(kCheckerSize, h - cy);
            RECT rc = {x + cx, y + cy, x + cx + cellW, y + cy + cellH};
            bool isDark = ((cx / kCheckerSize) + (cy / kCheckerSize)) % 2 != 0;
            HdcFillRect(hdc, ToRect(rc), isDark ? darkBrush : lightBrush);
        }
    }

    DeleteObject(lightBrush);
    DeleteObject(darkBrush);
}

Size HdcGetTextExtentPoint32(HDC hdc, WStr str) {
    SIZE size{};
    GetTextExtentPoint32W(hdc, str.s, str.len, &size);
    return {(int)size.cx, (int)size.cy};
}

Size HdcGetTextExtentPoint32(HDC hdc, Str str) {
    return HdcGetTextExtentPoint32(hdc, ToWStrTemp(str));
}

//--- GDI: handles / bitmaps / pixmaps

static bool DeleteObjectSafe(HGDIOBJ* h) {
    if (!h || !*h) {
        return false;
    }
    auto res = ::DeleteObject(*h);
    *h = nullptr;
    return tobool(res);
}

bool DeleteBrushSafe(HBRUSH* br) {
    return DeleteObjectSafe((HGDIOBJ*)br);
}

// --- begin: merged from former src/common/win_util.cpp ---

Size RenderedBitmap::GetSize() {
    return size;
}

RenderedBitmap::RenderedBitmap(HBITMAP hbmp, Size size, HANDLE hMap) {
    this->hbmp = hbmp;
    this->hMap = hMap;
    this->size = size;
}

RenderedBitmap::~RenderedBitmap() {
    if (IsValidHandle(hbmp)) {
        DeleteObject(hbmp);
    }
    if (IsValidHandle(hMap)) {
        CloseHandle(hMap);
    }
}

RenderedBitmap* RenderedBitmap::Clone() const {
    HBITMAP hbmp2 = (HBITMAP)CopyImage(hbmp, IMAGE_BITMAP, size.dx, size.dy, 0);
    return new RenderedBitmap(hbmp2, size);
}

bool RenderedBitmap::IsValid() {
    return hbmp != nullptr;
}

// callers must not delete this (use Clone if you have to modify it)
HBITMAP RenderedBitmap::GetBitmap() const {
    return hbmp;
}

HBITMAP CreateMemoryBitmap(Size size, HANDLE* hDataMapping) {
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = size.dx;
    bmi.bmiHeader.biHeight = -size.dy;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biCompression = BI_RGB;
    // trading speed for memory (32 bits yields far better performance)
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biSizeImage = size.dx * 4 * size.dy;

    void* data = nullptr;
    if (hDataMapping && !*hDataMapping) {
        *hDataMapping =
            CreateFileMapping(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, bmi.bmiHeader.biSizeImage, nullptr);
    }
    return CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS, &data, hDataMapping ? *hDataMapping : nullptr, 0);
}

//--- double-buffer / deferred window positioning

DoubleBuffer::DoubleBuffer(HWND hwnd, Rect rect, DoubleBufferKind kind)
    : hTarget(hwnd), hdcCanvas(::GetDC(hwnd)), rect(rect) {
    if (rect.IsEmpty()) {
        return;
    }

    doubleBuffer = kind == DoubleBufferKind::Dib ? CreateMemoryBitmap({rect.dx, rect.dy})
                                                 : CreateCompatibleBitmap(hdcCanvas, rect.dx, rect.dy);
    if (!doubleBuffer) {
        return;
    }

    hdcBuffer = CreateCompatibleDC(hdcCanvas);
    if (!hdcBuffer) {
        return;
    }
    // CreateCompatibleDC copies LAYOUT_RTL from an RTL hwnd's DC. The document
    // canvas must stay LTR (issue #5326); a mirrored buffer would flip the
    // page and keep it flipped after the hwnd is set back to LTR.
    SetLayout(hdcBuffer, 0);

    if (rect.x != 0 || rect.y != 0) {
        SetGraphicsMode(hdcBuffer, GM_ADVANCED);
        XFORM ctm = {1.0, 0, 0, 1.0, (float)-rect.x, (float)-rect.y};
        SetWorldTransform(hdcBuffer, &ctm);
    }
    DeleteObject(SelectObject(hdcBuffer, doubleBuffer));
}

DoubleBuffer::~DoubleBuffer() {
    DeleteObject(doubleBuffer);
    DeleteDC(hdcBuffer);
    ReleaseDC(hTarget, hdcCanvas);
}

HDC DoubleBuffer::GetDC() const {
    if (hdcBuffer != nullptr) {
        return hdcBuffer;
    }
    return hdcCanvas;
}

void DoubleBuffer::Flush(HDC hdc) const {
    ReportIf(hdc == hdcBuffer);
    if (!hdcBuffer) {
        return;
    }
    // BitBlt onto a LAYOUT_RTL DC mirrors the whole bitmap (glyphs included).
    // The buffer is painted in LTR; copy it verbatim, same as VirtHost.
    DWORD layout = GetLayout(hdc);
    bool mirrored = layout != GDI_ERROR && (layout & LAYOUT_RTL);
    if (mirrored) {
        SetLayout(hdc, 0);
    }
    BitBlt(hdc, rect.x, rect.y, rect.dx, rect.dy, hdcBuffer, 0, 0, SRCCOPY);
    if (mirrored) {
        SetLayout(hdc, layout);
    }
}

DeferWinPosHelper::DeferWinPosHelper() : hdwp(::BeginDeferWindowPos(32)) {}

DeferWinPosHelper::~DeferWinPosHelper() {
    End();
}

void DeferWinPosHelper::End() {
    if (hdwp) {
        ::EndDeferWindowPos(hdwp);
        hdwp = nullptr;
    }
}

void DeferWinPosHelper::MoveWindow(HWND hWnd, Rect r) {
    uint flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER;
    hdwp = ::DeferWindowPos(hdwp, hWnd, nullptr, r.x, r.y, r.dx, r.dy, flags);
}

void DeferWinPosHelper::MoveWindowNoCopyBits(HWND hWnd, Rect r) {
    uint flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER | SWP_NOCOPYBITS;
    hdwp = ::DeferWindowPos(hdwp, hWnd, nullptr, r.x, r.y, r.dx, r.dy, flags);
}

//--- clipboard

struct ClipEntry {
    UINT format;
    HANDLE data;
};

static constexpr int kMaxTestBitmapDim = 4096;

static bool gTestClipboardMode = false;
static bool gTestClipboardOpen = false;
static DWORD gTestClipboardSeq = 1;
static Vec<ClipEntry> gTestClipboard;

void SetTestClipboardMode() {
    gTestClipboardMode = true;
}

bool IsTestClipboardMode() {
    return gTestClipboardMode;
}

static void FreeClipEntry(ClipEntry entry) {
    if (entry.format == CF_BITMAP) {
        DeleteObject(entry.data);
    } else {
        GlobalFree(entry.data);
    }
}

BOOL ClipboardOpen(HWND owner) {
    if (!gTestClipboardMode) {
        return OpenClipboard(owner);
    }
    if (gTestClipboardOpen) {
        return FALSE;
    }
    gTestClipboardOpen = true;
    return TRUE;
}

BOOL ClipboardClose() {
    if (!gTestClipboardMode) {
        return CloseClipboard();
    }
    gTestClipboardOpen = false;
    return TRUE;
}

BOOL ClipboardEmpty() {
    if (!gTestClipboardMode) {
        return EmptyClipboard();
    }
    if (!gTestClipboardOpen) {
        return FALSE;
    }
    for (ClipEntry entry : gTestClipboard) {
        FreeClipEntry(entry);
    }
    VecReset(gTestClipboard);
    gTestClipboardSeq++;
    return TRUE;
}

HANDLE ClipboardSetData(UINT format, HANDLE data) {
    if (!gTestClipboardMode) {
        return SetClipboardData(format, data);
    }
    if (!gTestClipboardOpen || !data) {
        return nullptr;
    }
    for (ClipEntry& entry : gTestClipboard) {
        if (entry.format == format) {
            FreeClipEntry(entry);
            entry.data = data;
            gTestClipboardSeq++;
            return data;
        }
    }
    if (!VecAppend(gTestClipboard, ClipEntry{format, data})) {
        return nullptr;
    }
    gTestClipboardSeq++;
    return data;
}

HANDLE ClipboardGetData(UINT format) {
    if (!gTestClipboardMode) {
        return GetClipboardData(format);
    }
    if (!gTestClipboardOpen) {
        return nullptr;
    }
    for (ClipEntry entry : gTestClipboard) {
        if (entry.format == format) {
            return entry.data;
        }
    }
    return nullptr;
}

BOOL ClipboardHasFormat(UINT format) {
    if (!gTestClipboardMode) {
        return IsClipboardFormatAvailable(format);
    }
    for (ClipEntry entry : gTestClipboard) {
        if (entry.format == format) {
            return TRUE;
        }
    }
    return FALSE;
}

DWORD ClipboardSequence() {
    return gTestClipboardMode ? gTestClipboardSeq : GetClipboardSequenceNumber();
}

Str TestClipboardFormatsTemp() {
    str::Builder sb;
    for (ClipEntry entry : gTestClipboard) {
        if (len(sb) > 0) {
            sb.AppendChar(',');
        }
        sb.Append(fmt("%d", (int)entry.format));
    }
    return ToStrTemp(sb);
}

Str TestClipboardDataTemp(UINT format) {
    if (!gTestClipboardMode || !ClipboardOpen(nullptr)) {
        return {};
    }
    HANDLE h = ClipboardGetData(format);
    const u8* data = nullptr;
    size_t n = 0;
    if (format == CF_BITMAP && h) {
        BITMAP bmp{};
        if (GetObject(h, sizeof(bmp), &bmp) && bmp.bmWidth > 0 && bmp.bmHeight > 0 &&
            bmp.bmWidth <= kMaxTestBitmapDim && bmp.bmHeight <= kMaxTestBitmapDim) {
            n = sizeof(BITMAPINFOHEADER) + (size_t)bmp.bmWidth * bmp.bmHeight * 4;
            u8* bits = AllocArrayTemp<u8>((int)n);
            BITMAPINFO info{};
            info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            info.bmiHeader.biWidth = bmp.bmWidth;
            info.bmiHeader.biHeight = -bmp.bmHeight;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;
            HDC dc = GetDC(nullptr);
            int rows =
                dc ? GetDIBits(dc, (HBITMAP)h, 0, bmp.bmHeight, bits + sizeof(BITMAPINFOHEADER), &info, DIB_RGB_COLORS)
                   : 0;
            if (dc) ReleaseDC(nullptr, dc);
            if (rows == bmp.bmHeight) {
                memcpy(bits, &info.bmiHeader, sizeof(BITMAPINFOHEADER));
                data = bits;
            }
        }
    } else if (h) {
        n = GlobalSize(h);
        data = (const u8*)GlobalLock(h);
    }
    str::Builder sb;
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; data && i < n; i++) {
        sb.AppendChar(digits[data[i] >> 4]);
        sb.AppendChar(digits[data[i] & 15]);
    }
    if (data && format != CF_BITMAP) {
        GlobalUnlock(h);
    }
    ClipboardClose();
    return ToStrTemp(sb);
}

static int HexDigit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool SetTestClipboardData(UINT format, Str hex) {
    if (!gTestClipboardMode || format == 0 || len(hex) % 2 != 0 || !ClipboardOpen(nullptr)) {
        return false;
    }
    size_t n = len(hex) / 2;
    HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, n ? n : 1);
    u8* data = h ? (u8*)GlobalLock(h) : nullptr;
    bool valid = data != nullptr;
    for (size_t i = 0; valid && i < n; i++) {
        int hi = HexDigit(hex.s[2 * i]);
        int lo = HexDigit(hex.s[2 * i + 1]);
        valid = hi >= 0 && lo >= 0;
        if (valid) data[i] = (u8)((hi << 4) | lo);
    }
    HANDLE clipData = h;
    if (valid && format == CF_BITMAP) {
        BITMAPINFOHEADER header{};
        if (n < sizeof(header)) {
            valid = false;
        } else {
            memcpy(&header, data, sizeof(header));
            size_t pixels = header.biWidth > 0 && header.biWidth <= kMaxTestBitmapDim && header.biHeight < 0 &&
                                    -(i64)header.biHeight <= kMaxTestBitmapDim
                                ? (size_t)header.biWidth * -(i64)header.biHeight * 4
                                : 0;
            valid = header.biSize == sizeof(header) && header.biPlanes == 1 && header.biBitCount == 32 &&
                    header.biCompression == BI_RGB && pixels > 0 && pixels == n - sizeof(header);
            if (valid) {
                void* bits = nullptr;
                HDC dc = GetDC(nullptr);
                HBITMAP bmp = dc ? CreateDIBSection(dc, (BITMAPINFO*)data, DIB_RGB_COLORS, &bits, nullptr, 0) : nullptr;
                if (dc) ReleaseDC(nullptr, dc);
                valid = bmp && bits;
                if (valid) memcpy(bits, data + sizeof(header), pixels);
                clipData = bmp;
            }
        }
    }
    if (data) GlobalUnlock(h);
    if (format == CF_BITMAP && h) GlobalFree(h);
    if (valid) valid = ClipboardSetData(format, clipData) != nullptr;
    if (!valid && clipData && (format == CF_BITMAP ? clipData != h : true)) {
        if (format == CF_BITMAP)
            DeleteObject(clipData);
        else
            GlobalFree(clipData);
    }
    ClipboardClose();
    return valid;
}

static HWND gClipboardOwnerWnd = nullptr;

static HWND GetClipboardOwnerWnd() {
    if (gClipboardOwnerWnd && IsWindow(gClipboardOwnerWnd)) {
        return gClipboardOwnerWnd;
    }
    static WCHAR className[] = L"SumatraPDFClipboardOwner";
    static bool registered = false;
    if (!registered) {
        WNDCLASSEX wcex;
        FillWndClassEx(wcex, className, DefWindowProcW);
        RegisterClassExW(&wcex);
        registered = true;
    }
    gClipboardOwnerWnd =
        CreateWindowExW(0, className, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandle(nullptr), nullptr);
    return gClipboardOwnerWnd;
}

// --- end: merged from former src/common/win_util.cpp ---

// OpenClipboard fails when another process still holds it (Explorer, a just-
// exited Set-Clipboard, rdpclip syncing a change). Retry rather than silently
// dropping the copy.
bool OpenClipboardForUpdate() {
    constexpr int kTries = 100; // 2 secs
    HWND owner = GetClipboardOwnerWnd();
    if (!owner) {
        return false;
    }
    for (int i = 0; i < kTries; i++) {
        if (ClipboardOpen(owner)) {
            if (ClipboardEmpty()) {
                return true;
            }
            ClipboardClose();
        }
        Sleep(20);
    }
    return false;
}

void CloseClipboardAfterUpdate() {
    ClipboardClose();
}

static bool CopyOrAppendTextToClipboard(WStr text, bool appendOnly) {
    if (len(text) == 0) {
        return false;
    }

    if (!appendOnly) {
        if (!OpenClipboardForUpdate()) {
            return false;
        }
    }

    int n = text.len + 1;
    HGLOBAL handle = GlobalAlloc(GMEM_MOVEABLE, n * sizeof(WCHAR));
    if (!handle) {
        if (!appendOnly) {
            CloseClipboardAfterUpdate();
        }
        return false;
    }

    WCHAR* globalText = (WCHAR*)GlobalLock(handle);
    if (!globalText) {
        GlobalFree(handle);
        if (!appendOnly) {
            CloseClipboardAfterUpdate();
        }
        return false;
    }
    wstr::BufSet(WStr(globalText, n), text);
    GlobalUnlock(handle);

    if (!ClipboardSetData(CF_UNICODETEXT, handle)) {
        GlobalFree(handle);
        if (!appendOnly) {
            CloseClipboardAfterUpdate();
        }
        return false;
    }
    // SetClipboardData owns the handle now.

    if (!appendOnly) {
        CloseClipboardAfterUpdate();
    }

    return true;
}

Str GetTestClipboardText() {
    if (!gTestClipboardMode || !ClipboardOpen(nullptr)) {
        return {};
    }
    HGLOBAL h = (HGLOBAL)ClipboardGetData(CF_UNICODETEXT);
    WCHAR* data = h ? (WCHAR*)GlobalLock(h) : nullptr;
    size_t maxChars = h ? GlobalSize(h) / sizeof(WCHAR) : 0;
    size_t n = 0;
    while (data && n < maxChars && data[n]) n++;
    Str text = data ? ToUtf8Temp(WStr(data, (int)n)) : Str{};
    if (data) GlobalUnlock(h);
    ClipboardClose();
    return text;
}

bool HandleTestEditClipboard(HWND hwnd, UINT msg) {
    if (!gTestClipboardMode || (msg != WM_COPY && msg != WM_CUT && msg != WM_PASTE)) {
        return false;
    }
    DWORD style = GetWindowLongW(hwnd, GWL_STYLE);
    if (msg == WM_PASTE) {
        if (!(style & ES_READONLY)) {
            Str text = str::LFToCRLFTemp(GetTestClipboardText());
            SendMessageW(hwnd, EM_REPLACESEL, TRUE, (LPARAM)ToWStrTemp(text).s);
        }
        return true;
    }
    if (style & ES_PASSWORD) {
        return true;
    }
    DWORD start = 0;
    DWORD end = 0;
    SendMessageW(hwnd, EM_GETSEL, (WPARAM)&start, (LPARAM)&end);
    int count = GetWindowTextLengthW(hwnd);
    if (end > start && end <= (DWORD)count) {
        WCHAR* text = AllocArrayTemp<WCHAR>(count + 1);
        GetWindowTextW(hwnd, text, count + 1);
        CopyTextToClipboard(ToUtf8Temp(WStr(text + start, end - start)));
        if (msg == WM_CUT && !(style & ES_READONLY)) {
            SendMessageW(hwnd, EM_REPLACESEL, TRUE, (LPARAM)L"");
        }
    }
    return true;
}

bool CopyTextToClipboard(Str s) {
    return CopyOrAppendTextToClipboard(ToWStrTemp(s), false);
}

bool AppendTextToClipboard(Str s) {
    return CopyOrAppendTextToClipboard(ToWStrTemp(s), true);
}

static bool SetClipboardImage(HBITMAP hbmp) {
    if (!hbmp) {
        return false;
    }
    BITMAP bmpInfo;
    if (!GetObject(hbmp, sizeof(BITMAP), &bmpInfo)) {
        return false;
    }
    // Give the clipboard its own bitmap. SetClipboardData owns clipBmp on success.
    HBITMAP clipBmp = (HBITMAP)CopyImage(hbmp, IMAGE_BITMAP, bmpInfo.bmWidth, bmpInfo.bmHeight, 0);
    if (!clipBmp) {
        return false;
    }
    if (!ClipboardSetData(CF_BITMAP, clipBmp)) {
        DeleteObject(clipBmp);
        return false;
    }
    return true;
}

bool CopyImageToClipboard(HBITMAP hbmp, bool appendOnly) {
    if (!appendOnly) {
        if (!OpenClipboardForUpdate()) {
            return false;
        }
    }

    bool ok = SetClipboardImage(hbmp);

    if (!appendOnly) {
        CloseClipboardAfterUpdate();
    }

    return ok;
}

//--- menus

void MenuSetChecked(HMENU m, int id, bool isChecked) {
    ReportIf(id < 0);
    if (!m || id < 0) {
        return;
    }
    // CheckMenuItem(MF_BYCOMMAND) only hits the first item with that id. The
    // same command can appear twice (e.g. File and Settings "Use SumatraPDF
    // File Picker"), so walk the whole menu tree and update every match.
    int n = GetMenuItemCount(m);
    for (int i = 0; i < n; i++) {
        MENUITEMINFOW mii{};
        mii.cbSize = sizeof(mii);
        mii.fMask = MIIM_ID | MIIM_SUBMENU | MIIM_STATE | MIIM_FTYPE;
        if (!GetMenuItemInfoW(m, (UINT)i, TRUE, &mii)) {
            continue;
        }
        if (mii.hSubMenu) {
            MenuSetChecked(mii.hSubMenu, id, isChecked);
            continue;
        }
        if ((int)mii.wID != id) {
            continue;
        }
        mii.fMask = MIIM_STATE;
        if (isChecked) {
            mii.fState |= MFS_CHECKED;
        } else {
            mii.fState &= ~MFS_CHECKED;
        }
        SetMenuItemInfoW(m, (UINT)i, TRUE, &mii);
    }
}

bool MenuSetEnabled(HMENU m, int id, bool isEnabled) {
    ReportIf(id < 0);
    BOOL ret = EnableMenuItem(m, (UINT)id, MF_BYCOMMAND | (isEnabled ? MF_ENABLED : MF_GRAYED));
    return ret != -1;
}

void MenuRemove(HMENU m, int id) {
    ReportIf(id < 0);
    RemoveMenu(m, (UINT)id, MF_BYCOMMAND);
}

void MenuEmpty(HMENU m) {
    while (RemoveMenu(m, 0, MF_BYPOSITION)) {
        // no-op
    }
}

static bool MenuSetTextRec(HMENU m, int id, MENUITEMINFOW* mii) {
    if (SetMenuItemInfoW(m, id, FALSE, mii)) {
        return true;
    }
    int n = GetMenuItemCount(m);
    for (int i = 0; i < n; i++) {
        HMENU sub = GetSubMenu(m, i);
        if (sub && MenuSetTextRec(sub, id, mii)) {
            return true;
        }
    }
    return false;
}

void MenuSetText(HMENU m, int id, WStr s) {
    ReportIf(id < 0);
    MENUITEMINFOW mii{};
    mii.cbSize = sizeof(mii);
    mii.fMask = MIIM_STRING;
    mii.fType = MFT_STRING;
    mii.dwTypeData = s.s;
    mii.cch = (uint)s.len;
    if (MenuSetTextRec(m, id, &mii)) {
        return;
    }
    // setting text on a menu item that isn't present is benign (e.g. the
    // item was filtered out by command visibility): log it, don't assert
    TempStr tmp = len(s) == 0 ? StrL("(null)") : ToUtf8Temp(s);
    logf("MenuSetText(): id=%d, s='%s'\n", id, tmp);
    LogLastError();
}

void MenuSetText(HMENU m, int id, Str s) {
    TempWStr ws = ToWStrTemp(s);
    MenuSetText(m, id, ws);
}

/* Make a string safe to be displayed as a menu item
   (preserving all & so that they don't get swallowed)
   if no change is needed, the string is returned as is,
   else it's also saved in newResult for automatic freeing */
TempStr MenuToSafeStringTemp(Str s) {
    TempStr safe = str::ReplaceTemp(s, StrL("&"), StrL("&&"));
    return safe;
}

//--- keyboard state

static bool IsKeyPressed(int key) {
    SHORT state = GetKeyState(key);
    SHORT isDown = (SHORT)(state & 0x8000);
    return isDown != 0;
}

bool IsShiftPressed() {
    return IsKeyPressed(VK_SHIFT);
}

bool IsAltPressed() {
    return IsKeyPressed(VK_MENU);
}

// a path the next Save As takes instead of showing the dialog: tests set it
// through the control channel, so no script has to drive the system dialog
static WStr gTestSaveFileName;

void SetTestSaveFileName(Str path) {
    wstr::Free(gTestSaveFileName);
    gTestSaveFileName = len(path) > 0 ? ToWStr(path) : WStr{};
}

// call before GetSaveFileNameW: true when a test's path was put in ofn
bool TakeTestSaveFileName(OPENFILENAMEW* ofn) {
    if (len(gTestSaveFileName) == 0 || !ofn || !ofn->lpstrFile || ofn->nMaxFile == 0) {
        return false;
    }
    int n = std::min(len(gTestSaveFileName), (int)ofn->nMaxFile - 1);
    memcpy(ofn->lpstrFile, gTestSaveFileName.s, n * sizeof(WCHAR));
    ofn->lpstrFile[n] = 0;
    SetTestSaveFileName({});
    return true;
}

bool IsCtrlPressed() {
    return IsKeyPressed(VK_CONTROL);
}

// Some mouse drivers omit MK_RBUTTON on WM_MOUSEWHEEL, the same way they omit
// MK_CONTROL. Use this alongside the message flags so hold-right + wheel still
// zooms.
bool IsRightButtonPressed() {
    return IsKeyPressed(VK_RBUTTON);
}

// Mark every key and mouse button up in this thread's key state (what
// GetKeyState() and TranslateAccelerator() read), keeping the Caps Lock /
// Num Lock toggles. Returns how many were down.
int ReleaseThreadKeyState() {
    BYTE keys[256];
    if (!GetKeyboardState(keys)) {
        return 0;
    }
    int nDown = 0;
    for (BYTE& k : keys) {
        if (k & 0x80) {
            k &= ~0x80;
            nDown++;
        }
    }
    if (nDown > 0) {
        SetKeyboardState(keys);
    }
    return nDown;
}

//--- app input
// What the app sees of the mouse and the foreground. Window code reads them
// only through these functions. A test drives the app with a test cursor
// (-dbg-control TestCursorPosition) while Windows still delivers physical
// input; the difference is handled here and nowhere else:
//
//   physical WM_MOUSEMOVE off the test cursor -> dropped by testMouseHook with
//                                                the WM_SETCURSOR Windows sends
//                                                for it; posted, by testInputHook
//   cursor position, message position          -> the test cursor
//   window under a point                       -> only this thread's windows
//   foreground                                 -> the active window, whatever
//                                                another app on the desktop does
//   mouse leave tracking                       -> emulated at the test cursor
//
// Leave tracking is re-armed here, for tests and real users alike: a mouse
// capture cancels it without a WM_MOUSELEAVE, so when the capture of a window
// that asked for leave ends, the layer arms it again (LeaveWatchProc).

static bool hasTestCursor = false;
static Point testCursor{};
static HHOOK testInputHook = nullptr;
static HHOOK testMouseHook = nullptr;
static HHOOK testSentHook = nullptr;
// the window tracked for leave at the test cursor, like Windows' one tracked window
static HWND testLeaveHwnd = nullptr;

// A move Windows made at the physical pointer, off the test cursor (e.g. at a
// window shown under the pointer). Drags pass.
static bool IsPhysicalMove(const MSG& m) {
    if (m.message == WM_NCMOUSEMOVE) {
        return !testCursor.Eq(GET_X_LPARAM(m.lParam), GET_Y_LPARAM(m.lParam));
    }
    if (m.message != WM_MOUSEMOVE || !m.hwnd || (m.wParam & (MK_LBUTTON | MK_RBUTTON | MK_MBUTTON)) != 0) {
        return false;
    }
    return !HwndScreenToClient(m.hwnd, testCursor).Eq(GET_X_LPARAM(m.lParam), GET_Y_LPARAM(m.lParam));
}

// Like Windows, a mouse capture cancels leave tracking.
static void CancelTestLeaveOnCapture() {
    if (testLeaveHwnd && GetCapture()) {
        testLeaveHwnd = nullptr;
    }
}

static void PostTestLeave() {
    if (testLeaveHwnd) {
        PostMessageW(testLeaveHwnd, WM_MOUSELEAVE, 0, 0);
        testLeaveHwnd = nullptr;
    }
}

// Sees every message this thread retrieves, in modal loops (dialogs, menus,
// drag and drop) too.
static LRESULT CALLBACK TestInputHookProc(int code, WPARAM wp, LPARAM lp) {
    MSG* m = (MSG*)lp;
    if (code == HC_ACTION && IsPhysicalMove(*m)) {
        m->message = WM_NULL;
    }
    CancelTestLeaveOnCapture();
    return CallNextHookEx(nullptr, code, wp, lp);
}

// Sees mouse input Windows takes from its queue before it sends WM_SETCURSOR to
// the window under the pointer, whose handler would read the test cursor
// elsewhere. Tests post or send their input, which never comes this way.
static LRESULT CALLBACK TestMouseHookProc(int code, WPARAM wp, LPARAM lp) {
    auto* mh = (MOUSEHOOKSTRUCT*)lp;
    bool move = wp == WM_MOUSEMOVE || wp == WM_NCMOUSEMOVE;
    if (code >= 0 && move && !testCursor.Eq(mh->pt.x, mh->pt.y)) {
        return 1;
    }
    return CallNextHookEx(nullptr, code, wp, lp);
}

// Sees sent messages (tests send their mouse input) after they are handled.
static LRESULT CALLBACK TestSentHookProc(int code, WPARAM wp, LPARAM lp) {
    CancelTestLeaveOnCapture();
    return CallNextHookEx(nullptr, code, wp, lp);
}

static BOOL CALLBACK CancelLeaveTracking(HWND hwnd, LPARAM) {
    TRACKMOUSEEVENT tme{sizeof(tme), TME_CANCEL | TME_LEAVE, hwnd, 0};
    TrackMouseEvent(&tme);
    return TRUE;
}

static BOOL CALLBACK CancelLeaveTrackingTree(HWND hwnd, LPARAM lp) {
    CancelLeaveTracking(hwnd, lp);
    EnumChildWindows(hwnd, CancelLeaveTracking, lp);
    return TRUE;
}

// Called on the UI thread (-dbg-control requests run there).
void SetTestCursorPosition(Point pt) {
    testCursor = pt;
    hasTestCursor = true;
    if (!testInputHook) {
        testInputHook = SetWindowsHookExW(WH_GETMESSAGE, TestInputHookProc, nullptr, GetCurrentThreadId());
        testSentHook = SetWindowsHookExW(WH_CALLWNDPROCRET, TestSentHookProc, nullptr, GetCurrentThreadId());
        testMouseHook = SetWindowsHookExW(WH_MOUSE, TestMouseHookProc, nullptr, GetCurrentThreadId());
    }
    // tracking armed at the physical pointer would post a leave that clears the test's hover
    EnumThreadWindows(GetCurrentThreadId(), CancelLeaveTrackingTree, 0);
    if (testLeaveHwnd && HwndWindowFromPoint(pt) != testLeaveHwnd) {
        PostTestLeave();
    }
}

void ClearTestCursorPosition() {
    hasTestCursor = false;
    testLeaveHwnd = nullptr;
    if (testInputHook) {
        UnhookWindowsHookEx(testInputHook);
        testInputHook = nullptr;
    }
    if (testSentHook) {
        UnhookWindowsHookEx(testSentHook);
        testSentHook = nullptr;
    }
    if (testMouseHook) {
        UnhookWindowsHookEx(testMouseHook);
        testMouseHook = nullptr;
    }
}

Point GetCursorPosition() {
    if (hasTestCursor) {
        return testCursor;
    }
    POINT pt{};
    GetCursorPos(&pt);
    return {pt.x, pt.y};
}

bool HwndIsCursorOverWindow(HWND hwnd) {
    Point pt = GetCursorPosition();
    Rect rcWnd = HwndWindowRect(hwnd);
    return rcWnd.Contains(pt);
}

Point HwndGetCursorPos(HWND hwnd) {
    return HwndScreenToClient(hwnd, GetCursorPosition());
}

// Where the cursor was for the message being handled (GetMessagePos()).
Point GetMessageCursorPosition() {
    if (hasTestCursor) {
        return testCursor;
    }
    DWORD pos = GetMessagePos();
    return {GET_X_LPARAM(pos), GET_Y_LPARAM(pos)};
}

// Takes the point like WindowFromPoint(): visible, not a disabled child, not
// click-through, inside its region, not answering HTTRANSPARENT.
static bool WindowTakesPoint(HWND hwnd, Point pt) {
    DWORD style = (DWORD)GetWindowLongPtrW(hwnd, GWL_STYLE);
    DWORD exStyle = (DWORD)GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if ((style & WS_VISIBLE) == 0 || (style & (WS_CHILD | WS_DISABLED)) == (WS_CHILD | WS_DISABLED)) {
        return false;
    }
    if ((exStyle & (WS_EX_LAYERED | WS_EX_TRANSPARENT)) == (WS_EX_LAYERED | WS_EX_TRANSPARENT)) {
        return false;
    }
    Rect rc = HwndWindowRect(hwnd);
    if (!rc.Contains(pt)) {
        return false;
    }
    HRGN rgn = CreateRectRgn(0, 0, 0, 0);
    bool outsideRgn = GetWindowRgn(hwnd, rgn) != ERROR && !PtInRegion(rgn, pt.x - rc.x, pt.y - rc.y);
    DeleteObject(rgn);
    if (outsideRgn) {
        return false;
    }
    // WindowFromPoint() asks only windows of the calling thread
    if (GetWindowThreadProcessId(hwnd, nullptr) != GetCurrentThreadId()) {
        return true;
    }
    return SendMessageW(hwnd, WM_NCHITTEST, 0, MAKELPARAM(pt.x, pt.y)) != HTTRANSPARENT;
}

static HWND HitTestWindow(HWND hwnd, Point pt) {
    if (!WindowTakesPoint(hwnd, pt)) {
        return nullptr;
    }
    Point cpt = HwndScreenToClient(hwnd, pt);
    if (IsIconic(hwnd) || !HwndClientRect(hwnd).Contains(cpt)) {
        return hwnd;
    }
    for (HWND child = GetWindow(hwnd, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
        HWND hit = HitTestWindow(child, pt);
        if (hit) {
            return hit;
        }
    }
    return hwnd;
}

// WindowFromPoint() among this thread's windows: a test's app windows open
// behind other apps' windows, which must not take the test cursor.
static HWND ThreadWindowFromPoint(Point pt) {
    DWORD tid = GetCurrentThreadId();
    for (HWND hwnd = GetTopWindow(nullptr); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT)) {
        if (GetWindowThreadProcessId(hwnd, nullptr) != tid) {
            continue;
        }
        HWND hit = HitTestWindow(hwnd, pt);
        if (hit) {
            return hit;
        }
    }
    return nullptr;
}

HWND HwndWindowFromPoint(Point p) {
    if (hasTestCursor) {
        return ThreadWindowFromPoint(p);
    }
    return WindowFromPoint(ToPOINT(p));
}

// Under a test cursor the active window stands in: the hidden test desktop
// has no foreground window, and on CI another app may be in front.
HWND HwndGetForeground() {
    if (hasTestCursor) {
        return GetActiveWindow();
    }
    return GetForegroundWindow();
}

// Windows tracks the physical pointer, not the test cursor; this tracks the
// test cursor the same way: one window, leave posted when the cursor leaves it
// (at once if already outside), cancelled by a mouse capture.
static bool ArmTestLeave(HWND hwnd) {
    if (GetCapture()) {
        return false;
    }
    if (testLeaveHwnd != hwnd) {
        PostTestLeave();
    }
    testLeaveHwnd = hwnd;
    if (HwndWindowFromPoint(testCursor) != hwnd) {
        PostTestLeave();
    }
    return true;
}

static bool ArmLeave(HWND hwnd) {
    if (hasTestCursor) {
        return ArmTestLeave(hwnd);
    }
    TRACKMOUSEEVENT tme{sizeof(tme), TME_LEAVE, hwnd, 0};
    return TrackMouseEvent(&tme) != FALSE;
}

static bool IsLeaveArmed(HWND hwnd) {
    if (hasTestCursor) {
        return testLeaveHwnd == hwnd;
    }
    TRACKMOUSEEVENT tme{sizeof(tme), TME_QUERY, hwnd, 0};
    TrackMouseEvent(&tme);
    return (tme.dwFlags & TME_LEAVE) != 0;
}

// Subclasses each window that asked for leave. A capture cancels the tracking;
// when the window's capture ends, re-arm it (leave posted at once if the mouse
// is already outside). A subclass sees only these windows' messages; a thread
// hook would see every message sent on the UI thread.
static LRESULT CALLBACK LeaveWatchProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR) {
    if (msg == WM_NCDESTROY) {
        RemoveWindowSubclass(hwnd, LeaveWatchProc, id);
        if (testLeaveHwnd == hwnd) {
            testLeaveHwnd = nullptr;
        }
        return DefSubclassProc(hwnd, msg, wp, lp);
    }

    LRESULT res = DefSubclassProc(hwnd, msg, wp, lp);
    if (msg == WM_CAPTURECHANGED && IsWindow(hwnd)) {
        ArmLeave(hwnd);
    }
    return res;
}

// Asks for WM_MOUSELEAVE for the window (TrackMouseEvent TME_LEAVE), also
// after each mouse capture of the window ends.
bool ArmMouseLeave(HWND hwnd) {
    SetWindowSubclass(hwnd, LeaveWatchProc, 0, 0);
    return ArmLeave(hwnd);
}

// ArmMouseLeave() unless leave is already tracked. Returns true if it armed.
bool TrackMouseLeave(HWND hwnd) {
    if (IsLeaveArmed(hwnd)) {
        return false;
    }
    return ArmMouseLeave(hwnd);
}

//--- owned popups
// The app's top-level windows are registered as they are created (TrackOwnedPopups(),
// a WH_CBT hook on the UI thread). Each one a frame owns, whether its owner was set
// at creation or later (GWLP_HWNDPARENT), follows the frame's minimize:
//
//   frame minimized   -> hidden, shown again with it, unless its owner hid it meanwhile.
//                        The focus it had comes back once the frame is active. Its owner
//                        doesn't see it lose the focus, unless the focus goes to another
//                        window first or doesn't come back (hidden by its owner meanwhile)
//   app deactivated   -> the focus its owner keeps for it (HwndRefocusWhenActive) comes
//                        back the same way, once its frame (or it, unowned) is active,
//                        also after another of the app's windows was
//
// A held focus comes back as the activation ends, before the input that follows it: the
// click that activated the window then moves the focus as on an active window.
//
// An anchored popup (AnchorPopup) also belongs to a child window, its anchor: a toolbar
// button's drop-down, a tip on the canvas. Windows moves and hides a child with its
// parents, a popup only by hand; here, whatever did it:
//
//   anchor or an ancestor moved             -> popup moved as much
//   anchor moved or resized, popup placed
//   from content (AnchorArgs::place)        -> owner places it
//   frame minimized: a hover, a popup it
//   doesn't own                             -> dismissed
//   anchor or an ancestor hidden            -> dismissed
//   anchor shows other content (AnchorShows)-> dismissed
//   cursor left the anchor (AnchorLeave)    -> dismissed
//
// The anchor and its ancestors are subclassed, a free popup's frame while it is
// minimized. What they report is acted on in a message posted to the popup, once the
// windows settled: a relayout hides and shows them on its way, and WM_SETREDRAW clears
// WS_VISIBLE meanwhile.
// Hiding a hidden window tells no one. Base.h routes the app's ShowWindow(),
// SetWindowPos() and IsWindowVisible() here: a hide while minimized keeps the popup
// hidden on restore, and a read reports it shown while it waits for the restore, so its
// owner's state, and whether it hides it, don't depend on the minimize. That mark is a
// window property, readable on any thread; the registry is the UI thread's.

struct OwnedPopup {
    HWND popup = nullptr;
    // anchored by AnchorPopup(); args.anchor is null for a free popup
    AnchorArgs args;
    // subclassed: the anchor and its ancestors, or a free popup's minimized frame
    Vec<HWND> chain;
    const void* anchorShows = nullptr;
    // the popup's top-left from the anchor's client origin, and where it was
    Point offset;
    Point placed;
    // the anchor's client area on screen when the popup was placed
    Rect anchorRc;
    Rect placeRc;
    UINT_PTR id = 0;
    bool syncPosted = false;
    bool left = false;
    // hidden with its minimized frame, to be shown with it again
    bool minimized = false;
    // it or a window in it had the focus then; its WM_KILLFOCUS is held back. Kept
    // after the restore until the frame is active
    HWND focus = nullptr;
    // Windows moved the focus off `focus` while it was held: its owner hasn't seen the loss
    bool lost = false;
    // its owner saw the loss (HwndRefocusWhenActive): the focus its window gets back
    bool sawLoss = false;
    // its window was activated: the refocus runs before the thread's next input, or as
    // posted. Activation focuses the popup itself meanwhile
    bool refocusPending = false;
};

static Vec<OwnedPopup*> gOwnedPopups;
static DWORD gPopupThread = 0;
// posted to a popup: wParam is a PopupMsg
static UINT gPopupMsg = 0;
static const WCHAR* kHiddenWithFrameProp = L"SumatraHiddenWithFrame";

enum PopupMsg : WPARAM {
    PopupSync = 0,
    // its owner hid it
    PopupHidden = 1,
    // its frame was activated
    PopupRefocus = 2,
};

// the registry belongs to the thread that tracks the popups
static Vec<OwnedPopup*>& OwnedPopups() {
    ReportIf(gPopupThread && GetCurrentThreadId() != gPopupThread);
    return gOwnedPopups;
}

static bool IsHiddenWithFrame(HWND hwnd) {
    return GetPropW(hwnd, kHiddenWithFrameProp) != nullptr;
}

static bool Anchored(OwnedPopup* ap) {
    return ap->args.anchor != nullptr;
}

// the frame that owns a popup, if any
static HWND PopupFrame(HWND popup) {
    HWND frame = HwndRootOwner(popup);
    return frame != popup ? frame : nullptr;
}

static Point AnchorOrigin(HWND anchor) {
    return HwndClientToScreen(anchor, Point{});
}

static Rect AnchorScreenRect(HWND anchor) {
    Point o = AnchorOrigin(anchor);
    Rect r = HwndClientRect(anchor);
    return {o.x, o.y, r.dx, r.dy};
}

static bool FrameMinimized(HWND anchor) {
    return IsWindow(anchor) && IsIconic(GetAncestor(anchor, GA_ROOT));
}

static bool AnchorShown(HWND anchor) {
    return IsWindow(anchor) && IsWindowVisible(anchor) && !FrameMinimized(anchor);
}

static Rect PlaceWindowRect(OwnedPopup* ap) {
    HWND hwnd = ap->args.placeWindow;
    return hwnd && IsWindowVisible(hwnd) ? AnchorScreenRect(hwnd) : Rect{};
}

static void NoteAnchorOffset(OwnedPopup* ap) {
    Rect r = HwndWindowRect(ap->popup);
    Point o = AnchorOrigin(ap->args.anchor);
    ap->placed = {r.x, r.y};
    ap->offset = {r.x - o.x, r.y - o.y};
    ap->anchorRc = AnchorScreenRect(ap->args.anchor);
    ap->placeRc = PlaceWindowRect(ap);
}

static void PostAnchorSync(OwnedPopup* ap) {
    if (ap->syncPosted || (!IsWindowVisible(ap->popup) && !ap->minimized)) {
        return;
    }
    ap->syncPosted = true;
    PostMessageW(ap->popup, gPopupMsg, PopupSync, 0);
}

static void HidePopup(HWND popup) {
    uint flags = SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER;
    SetWindowPos(popup, nullptr, 0, 0, 0, 0, flags);
}

// at its place, or at `at`
static void ShowPopup(HWND popup, const Point* at) {
    uint flags = SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER | (at ? 0 : SWP_NOMOVE);
    Point pt = at ? *at : Point{};
    SetWindowPos(popup, nullptr, pt.x, pt.y, 0, 0, flags);
}

static bool InPopup(HWND popup, HWND hwnd) {
    return hwnd && (hwnd == popup || IsChild(popup, hwnd));
}

static LRESULT CALLBACK HeldFocusProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
static LRESULT CALLBACK FocusMoveHook(int, WPARAM, LPARAM);
static LRESULT CALLBACK RefocusInputHook(int, WPARAM, LPARAM);
static OwnedPopup* FindOwnedPopup(HWND popup);
static void RefocusWhenActive(OwnedPopup* ap);
static LRESULT CALLBACK AnchorChainProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
static LRESULT CALLBACK PlaceWindowProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);

static HHOOK gFocusMoveHook = nullptr;
static HHOOK gRefocusInputHook = nullptr;
// a held focus's loss is being delivered to its owner
static bool gDeliveringLoss = false;

static void SyncHook(HHOOK& hook, bool want, int type, HOOKPROC proc) {
    if (want && !hook) {
        hook = SetWindowsHookExW(type, proc, nullptr, GetCurrentThreadId());
        if (!hook) {
            logf("SyncFocusHooks: SetWindowsHookEx failed: %d\n", (int)GetLastError());
        }
    } else if (!want && hook) {
        UnhookWindowsHookEx(hook);
        hook = nullptr;
    }
}

// FocusMoveHook watches the focus while a popup's is held, RefocusInputHook the input
// while a refocus is pending
static void SyncFocusHooks() {
    bool held = gDeliveringLoss;
    bool pending = false;
    for (OwnedPopup* ap : OwnedPopups()) {
        held = held || ap->focus;
        pending = pending || ap->refocusPending;
    }
    SyncHook(gFocusMoveHook, held, WH_CBT, FocusMoveHook);
    SyncHook(gRefocusInputHook, pending, WH_GETMESSAGE, RefocusInputHook);
}

static void ReleaseFocus(OwnedPopup* ap) {
    if (!ap->focus) {
        return;
    }
    RemoveWindowSubclass(ap->focus, HeldFocusProc, ap->id);
    ap->focus = nullptr;
    ap->lost = false;
    ap->sawLoss = false;
    ap->refocusPending = false;
    SyncFocusHooks();
}

// The hold ends with the focus elsewhere. The owner gets the loss Windows sent while it
// was held, so its Edit destroys its caret; FocusMoveHook drops its focus moves.
static void DropHold(OwnedPopup* ap) {
    HWND hwnd = ap->lost ? ap->focus : nullptr;
    if (!IsWindow(hwnd)) {
        ReleaseFocus(ap);
        return;
    }
    // before the hold goes, so the hook stays
    bool delivering = gDeliveringLoss;
    gDeliveringLoss = true;
    ReleaseFocus(ap);
    SendMessageW(hwnd, WM_KILLFOCUS, (WPARAM)GetFocus(), 0);
    gDeliveringLoss = delivering;
    SyncFocusHooks();
}

enum class FocusMove {
    SetFocus,
    // Windows activates the window, which takes the focus, also without a SetFocus()
    Activate,
};

// The focus goes to `to`. A held focus outside to's frame is lost, e.g. to
// another of the app's frames: the owner sees the loss before `to` gets WM_SETFOCUS, as
// for a click there, so the caret its edit destroys is still its own, not to's.
// One set back in its restored popup before the frame was activated is no longer held.
// A window of a class not the app's (MessageBox, file dialog) is like another app's:
// the focus is held until the frame or a window of the app's it owns is active again.
static void NoteFocusMoving(HWND to, FocusMove how) {
    if (!FindOwnedPopup(GetAncestor(to, GA_ROOT))) {
        return;
    }
    HWND frame = HwndRootOwner(to);
    Vec<HWND> lost;
    // before the holds go, so the hook stays to drop the owners' focus moves
    gDeliveringLoss = true;
    for (OwnedPopup* ap : OwnedPopups()) {
        if (!ap->focus) {
            continue;
        }
        if (HwndRootOwner(ap->popup) == frame) {
            bool activating = ap->refocusPending && to == ap->popup;
            if (how == FocusMove::SetFocus && !ap->minimized && InPopup(ap->popup, to) && !activating) {
                ReleaseFocus(ap);
            }
            continue;
        }
        // the focus its window gets back stays held
        if (ap->sawLoss) {
            continue;
        }
        // one that still has the focus gets WM_KILLFOCUS from Windows, one that lost it now
        if (ap->lost) {
            VecAppend(lost, ap->focus);
        }
        ReleaseFocus(ap);
    }
    // owners may hide or destroy popups; FocusMoveHook drops their focus moves
    for (HWND hwnd : lost) {
        if (IsWindow(hwnd)) {
            SendMessageW(hwnd, WM_KILLFOCUS, (WPARAM)to, 0);
        }
    }
    gDeliveringLoss = false;
    SyncFocusHooks();
}

// A held focus goes back once its frame (or unowned popup) is activated
// (RefocusWhenActive): before the input that follows, or as posted with none.
static void NoteActivating(HWND hwnd) {
    HWND root = HwndRootOwner(hwnd);
    for (OwnedPopup* ap : OwnedPopups()) {
        if (ap->focus && !ap->minimized && HwndRootOwner(ap->popup) == root) {
            ap->refocusPending = true;
            PostMessageW(ap->popup, gPopupMsg, PopupRefocus, 0);
        }
    }
    SyncFocusHooks();
}

static bool IsInputMessage(UINT msg) {
    bool key = msg >= WM_KEYFIRST && msg <= WM_KEYLAST;
    bool mouse = msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST;
    bool ncMouse = msg >= WM_NCMOUSEMOVE && msg <= WM_NCXBUTTONDBLCLK;
    return key || mouse || ncMouse;
}

// The thread takes its first input since an activation: the click that activated the
// window comes out of the queue after the activation, ahead of what it posted. The
// refocus runs first, so the click decides the focus.
static LRESULT CALLBACK RefocusInputHook(int code, WPARAM wp, LPARAM lp) {
    auto* m = (MSG*)lp;
    if (code != HC_ACTION || wp != PM_REMOVE || !IsInputMessage(m->message)) {
        return CallNextHookEx(nullptr, code, wp, lp);
    }
    Vec<HWND> pending;
    for (OwnedPopup* ap : OwnedPopups()) {
        if (ap->refocusPending) {
            VecAppend(pending, ap->popup);
        }
    }
    // owners may hide or destroy popups
    for (HWND popup : pending) {
        OwnedPopup* ap = FindOwnedPopup(popup);
        if (ap && ap->refocusPending) {
            RefocusWhenActive(ap);
        }
    }
    return CallNextHookEx(nullptr, code, wp, lp);
}

// Watches the thread's focus and activation while a focus is held. Windows calls it
// before the focus moves or a window activates. While an owner reacts to a loss, its focus
// and activation changes are dropped: the focus goes where Windows was moving it, once.
static LRESULT CALLBACK FocusMoveHook(int code, WPARAM wp, LPARAM lp) {
    bool move = code == HCBT_SETFOCUS || code == HCBT_ACTIVATE;
    if (move && gDeliveringLoss) {
        logf("FocusMoveHook: dropped a focus or activation change made on a held focus's loss\n");
        return 1;
    }
    LRESULT res = CallNextHookEx(nullptr, code, wp, lp);
    if (res != 0 || !wp) {
        return res;
    }
    if (code == HCBT_SETFOCUS) {
        NoteFocusMoving((HWND)wp, FocusMove::SetFocus);
        return res;
    }
    if (code != HCBT_ACTIVATE) {
        return res;
    }
    // only the app's own windows (the registry) count as another of its windows
    HWND hwnd = (HWND)wp;
    if (FindOwnedPopup(hwnd)) {
        NoteFocusMoving(hwnd, FocusMove::Activate);
    }
    NoteActivating(hwnd);
    return res;
}

// Windows moves the focus off a popup it hides, e.g. to the frame, as it does
// for a click away. Its owner, which may commit or close on that, doesn't see it.
static LRESULT CALLBACK HeldFocusProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR data) {
    auto* ap = (OwnedPopup*)data;
    if (msg == WM_KILLFOCUS && ap->minimized) {
        ap->lost = true;
        return 0;
    }
    if (msg == WM_SETFOCUS) {
        ap->lost = false;
    }
    if (msg == WM_NCDESTROY) {
        ReleaseFocus(ap);
    }
    return DefSubclassProc(hwnd, msg, wp, lp);
}

static void ClearChain(OwnedPopup* ap) {
    if (ap->args.placeWindow) {
        RemoveWindowSubclass(ap->args.placeWindow, PlaceWindowProc, ap->id);
    }
    for (HWND hwnd : ap->chain) {
        RemoveWindowSubclass(hwnd, AnchorChainProc, ap->id);
    }
    VecClear(ap->chain);
}

static void SubclassChain(OwnedPopup* ap, HWND hwnd) {
    VecAppend(ap->chain, hwnd);
    SetWindowSubclass(hwnd, AnchorChainProc, ap->id, (DWORD_PTR)ap);
}

// hidden or shown with its minimized frame; HwndIsVisible() reads the mark
static void SetMinimized(OwnedPopup* ap, bool minimized) {
    ap->minimized = minimized;
    if (minimized) {
        SetPropW(ap->popup, kHiddenWithFrameProp, (HANDLE)1);
    } else {
        RemovePropW(ap->popup, kHiddenWithFrameProp);
    }
    if (Anchored(ap)) {
        return;
    }
    // a free popup learns of the restore from its frame
    ClearChain(ap);
    HWND frame = PopupFrame(ap->popup);
    if (minimized && frame) {
        SubclassChain(ap, frame);
    }
}

// what has the focus in it keeps it for its owner and gets it back with the frame,
// unless the focus goes to another window meanwhile (FocusMoveHook)
static void NoteMinimized(OwnedPopup* ap) {
    if (!ap->minimized) {
        SetMinimized(ap, true);
    }
    HWND focus = GetFocus();
    if (!InPopup(ap->popup, focus) || focus == ap->focus) {
        return;
    }
    DropHold(ap);
    ap->focus = focus;
    SetWindowSubclass(focus, HeldFocusProc, ap->id, (DWORD_PTR)ap);
    SyncFocusHooks();
}

// A restored popup gets its held focus back once its frame or a window of the app's it
// owns is active; one held for the app's deactivation (HwndRefocusWhenActive), once its
// frame, or the popup if no frame owns it, is. Until then the focus may be in another app
// or in a dialog of a class not the app's (NoteFocusMoving()): a SetFocus() would take it.
static void RefocusWhenActive(OwnedPopup* ap) {
    ap->refocusPending = false;
    SyncFocusHooks();
    if (!ap->focus || ap->minimized) {
        return;
    }
    HWND active = GetActiveWindow();
    HWND root = HwndRootOwner(ap->popup);
    if (!active || HwndRootOwner(active) != root || !FindOwnedPopup(active)) {
        return;
    }
    // activating the frame left the focus in it, the popup or nowhere; a click since may
    // have given it to another window, which keeps it
    HWND focus = ap->focus;
    bool back = IsWindow(focus) && InPopup(ap->popup, focus) && IsWindowVisible(ap->popup);
    bool moved =
        back && (HwndMoveFocus(ap->popup, focus) || HwndMoveFocus(root, focus) || HwndMoveFocus(nullptr, focus));
    if (moved) {
        ReleaseFocus(ap);
        return;
    }
    DropHold(ap);
}

// The focus left `to`, in an app window, for none of the app's: the on-screen keyboard's
// or another app's. Back now if to's window is still active (the keyboard took it), else
// held as for a minimize until its frame, or the popup if no frame owns it, is active
// again. Its owner saw the loss: a hold that ends without the focus back delivers none.
// A window of the app's the focus goes to keeps it.
void HwndRefocusWhenActive(HWND to) {
    if (HwndMoveFocus(nullptr, to)) {
        return;
    }
    OwnedPopup* ap = FindOwnedPopup(GetAncestor(to, GA_ROOT));
    HWND active = GetActiveWindow();
    if (!ap || ap->minimized || ap->focus == to || (active && FindOwnedPopup(active))) {
        return;
    }
    DropHold(ap);
    ap->focus = to;
    ap->sawLoss = true;
    SetWindowSubclass(to, HeldFocusProc, ap->id, (DWORD_PTR)ap);
    SyncFocusHooks();
}

// not shown again with its frame
static void ForgetMinimized(OwnedPopup* ap) {
    if (ap->minimized) {
        SetMinimized(ap, false);
    }
    DropHold(ap);
}

static void DismissAnchoredPopup(OwnedPopup* ap) {
    ForgetMinimized(ap);
    // may destroy the popup, and ap with it
    Func0 dismiss = ap->args.dismiss;
    if (!dismiss.IsValid()) {
        HidePopup(ap->popup);
        return;
    }
    dismiss.Call();
}

// Windows hides the popups a frame owns before it goes iconic. One shown in
// between waits the same way: hidden, its owner's state kept for the restore,
// whichever of Windows and this sync came first
static void SyncFreePopup(OwnedPopup* ap) {
    HWND frame = PopupFrame(ap->popup);
    if (frame && IsIconic(frame)) {
        if (IsWindowVisible(ap->popup)) {
            NoteMinimized(ap);
            HidePopup(ap->popup);
        }
        return;
    }
    if (!ap->minimized) {
        return;
    }
    SetMinimized(ap, false);
    if (!IsWindowVisible(ap->popup)) {
        ShowPopup(ap->popup, nullptr);
    }
    RefocusWhenActive(ap);
}

static void SyncAnchoredPopup(OwnedPopup* ap) {
    ap->syncPosted = false;
    if (!Anchored(ap)) {
        SyncFreePopup(ap);
        return;
    }
    bool left = ap->left;
    ap->left = false;
    HWND anchor = ap->args.anchor;
    bool withFrame = FrameMinimized(anchor) && GetWindow(ap->popup, GW_OWNER) == GetAncestor(anchor, GA_ROOT);
    // a hover goes with the minimize, also when the frame is back by now
    bool hover = ap->args.minimize == AnchorMinimize::Dismiss;
    if (hover && (ap->minimized || (withFrame && IsWindowVisible(ap->popup)))) {
        DismissAnchoredPopup(ap);
        return;
    }
    // as for a free popup
    if (withFrame) {
        if (IsWindowVisible(ap->popup)) {
            NoteMinimized(ap);
            HidePopup(ap->popup);
        }
        return;
    }
    bool restored = ap->minimized;
    if (restored) {
        SetMinimized(ap, false);
    }
    if (!IsWindowVisible(ap->popup) && !restored) {
        DropHold(ap);
        return;
    }
    bool stale = ap->args.content && ap->args.content != ap->anchorShows;
    // back over the anchor by now: the leave is stale
    bool gone = left && HwndWindowFromPoint(GetCursorPosition()) != anchor;
    if (!AnchorShown(anchor) || stale || gone) {
        DismissAnchoredPopup(ap);
        return;
    }
    Point o = AnchorOrigin(anchor);
    Point want{o.x + ap->offset.x, o.y + ap->offset.y};
    if (!IsWindowVisible(ap->popup)) {
        // the frame is back before Windows showed the popup
        ShowPopup(ap->popup, ap->args.place.IsValid() ? nullptr : &want);
    }
    RefocusWhenActive(ap);
    if (ap->args.place.IsValid()) {
        Rect rc = AnchorScreenRect(anchor);
        Rect placeRc = PlaceWindowRect(ap);
        if (rc == ap->anchorRc && placeRc == ap->placeRc) {
            return;
        }
        ap->anchorRc = rc;
        ap->placeRc = placeRc;
        // may hide or destroy the popup, and ap with it
        Func0 place = ap->args.place;
        place.Call();
        return;
    }
    Rect r = HwndWindowRect(ap->popup);
    if (want.x != r.x || want.y != r.y) {
        SetWindowPos(ap->popup, nullptr, want.x, want.y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

static LRESULT CALLBACK OwnedPopupProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);

// a free popup again
static void UnanchorPopup(OwnedPopup* ap) {
    ClearChain(ap);
    ap->args = {};
    ap->anchorShows = nullptr;
    ap->left = false;
    if (ap->minimized) {
        SetMinimized(ap, true);
    }
}

static void UntrackPopup(OwnedPopup* ap) {
    ReleaseFocus(ap);
    ClearChain(ap);
    RemovePropW(ap->popup, kHiddenWithFrameProp);
    RemoveWindowSubclass(ap->popup, OwnedPopupProc, ap->id);
    VecRemove(OwnedPopups(), ap);
    delete ap;
}

static LRESULT CALLBACK AnchorChainProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR data) {
    auto* ap = (OwnedPopup*)data;
    switch (msg) {
        case WM_WINDOWPOSCHANGED:
            PostAnchorSync(ap);
            break;
        case WM_MOUSELEAVE:
            if (hwnd == ap->args.anchor && ap->args.leave == AnchorLeave::Dismiss) {
                ap->left = true;
                PostAnchorSync(ap);
            }
            break;
        case WM_NCDESTROY:
            if (Anchored(ap)) {
                // the owner of the popup takes it down with the window
                UnanchorPopup(ap);
            } else {
                ClearChain(ap);
            }
            break;
    }
    return DefSubclassProc(hwnd, msg, wp, lp);
}

// A placement window can move, hide or die while the anchor remains visible.
static LRESULT CALLBACK PlaceWindowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR data) {
    auto* ap = (OwnedPopup*)data;
    if (msg == WM_NCDESTROY) {
        ap->args.placeWindow = nullptr;
        RemoveWindowSubclass(hwnd, PlaceWindowProc, id);
        PostAnchorSync(ap);
    } else if (msg == WM_WINDOWPOSCHANGED) {
        PostAnchorSync(ap);
    }
    return DefSubclassProc(hwnd, msg, wp, lp);
}

static LRESULT CALLBACK OwnedPopupProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR data) {
    auto* ap = (OwnedPopup*)data;
    if (msg == gPopupMsg && wp == PopupSync) {
        SyncAnchoredPopup(ap);
        return 0;
    }
    if (msg == gPopupMsg && wp == PopupHidden) {
        ForgetMinimized(ap);
        return 0;
    }
    if (msg == gPopupMsg && wp == PopupRefocus) {
        RefocusWhenActive(ap);
        return 0;
    }
    if (msg == WM_NCDESTROY) {
        UntrackPopup(ap);
        return DefSubclassProc(hwnd, msg, wp, lp);
    }
    // While it waits for the restore, only the layer shows it: WS_VISIBLE set without a
    // show (WM_SETREDRAW TRUE, a style write) would put it on screen with its frame minimized
    if (ap->minimized && msg == WM_SETREDRAW && wp) {
        return 0;
    }
    if (ap->minimized && msg == WM_STYLECHANGING && (int)wp == GWL_STYLE) {
        ((STYLESTRUCT*)lp)->styleNew &= ~WS_VISIBLE;
    }
    // Windows hides it for its minimized frame
    if (msg == WM_SHOWWINDOW && !wp && lp == SW_PARENTCLOSING) {
        NoteMinimized(ap);
    }
    // Windows shows it with its restored frame also when its owner hid it meanwhile:
    // the sync does instead, unless it was hidden
    if (msg == WM_SHOWWINDOW && wp && lp == SW_PARENTOPENING) {
        return 0;
    }
    LRESULT res = DefSubclassProc(hwnd, msg, wp, lp);
    if (msg != WM_WINDOWPOSCHANGED || !IsWindowVisible(hwnd)) {
        return res;
    }
    auto* pos = (WINDOWPOS*)lp;
    bool shown = pos->flags & SWP_SHOWWINDOW;
    // Any show is checked once settled: Windows shows one again with its frame,
    // its owner may while the frame is minimized
    if (!Anchored(ap)) {
        if (shown && PopupFrame(hwnd)) {
            PostAnchorSync(ap);
        }
        return res;
    }
    // placed by its owner, relative to where the anchor is now. Z-order changes
    // (the frame activated) leave the place alone. One its owner places may be
    // shown again where it was, e.g. with its restored frame: placed once settled.
    Rect r = HwndWindowRect(hwnd);
    bool moved = r.x != ap->placed.x || r.y != ap->placed.y;
    bool place = ap->args.place.IsValid();
    if ((shown && !place) || (moved && !shown)) {
        NoteAnchorOffset(ap);
    }
    if (shown) {
        PostAnchorSync(ap);
    }
    return res;
}

static OwnedPopup* FindOwnedPopup(HWND popup) {
    for (OwnedPopup* ap : OwnedPopups()) {
        if (ap->popup == popup) {
            return ap;
        }
    }
    return nullptr;
}

static OwnedPopup* TrackPopup(HWND popup) {
    auto* ap = new OwnedPopup();
    ap->popup = popup;
    ap->id = NextSubclassId();
    SetWindowSubclass(popup, OwnedPopupProc, ap->id, (DWORD_PTR)ap);
    VecAppend(OwnedPopups(), ap);
    return ap;
}

// a window class of the app's: its code hides the window through this layer
static bool IsAppWindowClass(HWND hwnd) {
    static HMODULE self = nullptr;
    if (!self) {
        uint flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
        GetModuleHandleExW(flags, (LPCWSTR)&IsAppWindowClass, &self);
    }
    auto mod = (HMODULE)GetClassLongPtrW(hwnd, GCLP_HMODULE);
    return mod == self || mod == GetModuleHandleW(nullptr);
}

// every top-level window of the app's, before it gets WM_NCCREATE
static LRESULT CALLBACK PopupCreateHook(int code, WPARAM wp, LPARAM lp) {
    if (code == HCBT_CREATEWND) {
        auto hwnd = (HWND)wp;
        CREATESTRUCTW* cs = ((CBT_CREATEWNDW*)lp)->lpcs;
        bool topLevel = !(cs->style & WS_CHILD) && cs->hwndParent != HWND_MESSAGE;
        if (topLevel && IsAppWindowClass(hwnd)) {
            TrackPopup(hwnd);
        }
    }
    return CallNextHookEx(nullptr, code, wp, lp);
}

// Called once, on the UI thread, before it creates windows.
void TrackOwnedPopups() {
    ReportIf(gPopupThread);
    gPopupThread = GetCurrentThreadId();
    gPopupMsg = RegisterWindowMessageW(L"SumatraOwnedPopupMsg");
    HHOOK hook = SetWindowsHookExW(WH_CBT, PopupCreateHook, nullptr, gPopupThread);
    if (!hook) {
        logf("TrackOwnedPopups: SetWindowsHookEx failed: %d\n", (int)GetLastError());
    }
}

// a hide of a popup hidden with its minimized frame: it stays hidden on restore
static void NotePopupHidden(HWND hwnd) {
    if (hwnd && IsHiddenWithFrame(hwnd)) {
        // on the popup's thread
        SendMessageW(hwnd, gPopupMsg, PopupHidden, 0);
    }
}

// ShowWindow() for the app's code (Base.h)
BOOL HwndShowWindow(HWND hwnd, int cmd) {
    if (cmd == SW_HIDE) {
        NotePopupHidden(hwnd);
    }
    return ShowWindow(hwnd, cmd);
}

// ShowWindowAsync() for the app's code (Base.h)
BOOL HwndShowWindowAsync(HWND hwnd, int cmd) {
    if (cmd == SW_HIDE) {
        NotePopupHidden(hwnd);
    }
    return ShowWindowAsync(hwnd, cmd);
}

// SetWindowPos() for the app's code (Base.h)
BOOL HwndSetWindowPos(HWND hwnd, HWND after, int x, int y, int dx, int dy, UINT flags) {
    if (flags & SWP_HIDEWINDOW) {
        NotePopupHidden(hwnd);
    }
    return SetWindowPos(hwnd, after, x, y, dx, dy, flags);
}

// Ties popup, where its owner just placed it, to args.anchor until either
// window is destroyed. Called again on a show, the latest args apply.
void AnchorPopup(HWND popup, const AnchorArgs& args) {
    if (!popup || !args.anchor) {
        return;
    }
    if (!gPopupMsg) {
        gPopupMsg = RegisterWindowMessageW(L"SumatraOwnedPopupMsg");
    }
    // not the app's, or created before TrackOwnedPopups()
    OwnedPopup* ap = FindOwnedPopup(popup);
    if (!ap) {
        ap = TrackPopup(popup);
    }
    if (ap->args.anchor != args.anchor || ap->args.placeWindow != args.placeWindow) {
        ClearChain(ap);
        for (HWND hwnd = args.anchor; hwnd; hwnd = (GetWindowStyle(hwnd) & WS_CHILD) ? GetParent(hwnd) : nullptr) {
            SubclassChain(ap, hwnd);
        }
        if (args.placeWindow) {
            SetWindowSubclass(args.placeWindow, PlaceWindowProc, ap->id, (DWORD_PTR)ap);
        }
    }
    ap->args = args;
    ap->anchorShows = args.content;
    ap->left = false;
    NoteAnchorOffset(ap);
    if (args.leave == AnchorLeave::Dismiss) {
        TrackMouseLeave(args.anchor);
    }
    // shown before it was anchored, e.g. while its frame is minimized
    PostAnchorSync(ap);
}

// The anchor shows content now: popups describing something else go.
void AnchorShows(HWND anchor, const void* content) {
    for (OwnedPopup* ap : OwnedPopups()) {
        if (ap->args.anchor != anchor || !ap->args.content || ap->anchorShows == content) {
            continue;
        }
        ap->anchorShows = content;
        PostAnchorSync(ap);
    }
}

//--- cursors

static LPWSTR knownCursorIds[] = {IDC_ARROW,  IDC_IBEAM,    IDC_HAND,     IDC_SIZEALL, IDC_SIZEWE,
                                  IDC_SIZENS, IDC_SIZENWSE, IDC_SIZENESW, IDC_NO,      IDC_CROSS};

static HCURSOR cachedCursors[dimof(knownCursorIds)]{};

static int GetCursorIndex(LPWSTR cursorId) {
    int n = dimofi(knownCursorIds);
    for (int i = 0; i < n; i++) {
        if (cursorId == knownCursorIds[i]) {
            return i;
        }
    }
    return -1;
}

HCURSOR GetCachedCursor(LPWSTR cursorId) {
    int i = GetCursorIndex(cursorId);
    ReportIf(i < 0);
    if (i < 0) {
        return nullptr;
    }
    if (nullptr == cachedCursors[i]) {
        cachedCursors[i] = LoadCursor(nullptr, cursorId);
        ReportIf(cachedCursors[i] == nullptr);
    }
    return cachedCursors[i];
}

void SetCursorCached(LPWSTR cursorId) {
    HCURSOR c = GetCachedCursor(cursorId);
    HCURSOR prevCursor = GetCursor();
    if (c == prevCursor) {
        return;
    }
    SetCursor(c);
}

void DeleteCachedCursors() {
    for (HCURSOR& cur : cachedCursors) {
        if (cur) {
            DestroyCursor(cur);
            cur = nullptr;
        }
    }
}

// 0 - metric (centimeters etc.)
// 1 - imperial (inches etc.)
// this triggers drmemory. Force no inlining so that it's easy to write a
// localized suppression
__declspec(noinline) int GetMeasurementSystem() {
    WCHAR unitSystem[2]{};
    GetLocaleInfoW(LOCALE_USER_DEFAULT, LOCALE_IMEASURE, unitSystem, dimof(unitSystem));
    if (unitSystem[0] == '0') {
        return 0;
    }
    return 1;
}

//--- handles

bool IsValidHandle(HANDLE h) {
    return !(h == nullptr || h == INVALID_HANDLE_VALUE);
}

// close handle returned by FindFirstFile()
bool SafeFindClose(HANDLE* hPtr) {
    HANDLE h = *hPtr;
    if (!IsValidHandle(h)) {
        *hPtr = nullptr;
        return false;
    }
    BOOL ok = FindClose(h);
    *hPtr = nullptr;
    return !!ok;
}

// This is just to satisfy /analyze. CloseHandle(nullptr) works perfectly fine
// but /analyze complains anyway
bool SafeCloseHandle(HANDLE* hPtr) {
    HANDLE h = *hPtr;
    if (!IsValidHandle(h)) {
        *hPtr = nullptr;
        return false;
    }
    BOOL ok = CloseHandle(h);
    *hPtr = nullptr;
    return !!ok;
}

//--- OS / process / CPU

// Check if we were launched by PowerShell with stdout redirected to a pipe.
// PowerShell's pipe redirection has known issues with GUI apps using WriteFile.
static bool FindProcessEntry(HANDLE hSnapshot, DWORD pid, PROCESSENTRY32W* pe) {
    pe->dwSize = sizeof(*pe);
    for (BOOL ok = Process32FirstW(hSnapshot, pe); ok; ok = Process32NextW(hSnapshot, pe)) {
        if (pe->th32ProcessID == pid) {
            return true;
        }
    }
    return false;
}

bool WasLaunchedByPowershellWithPipeRedirect() {
    HANDLE hStdout = GetStdHandle(STD_OUTPUT_HANDLE);
    if (hStdout == INVALID_HANDLE_VALUE || hStdout == nullptr || GetFileType(hStdout) != FILE_TYPE_PIPE) {
        return false;
    }

    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot == INVALID_HANDLE_VALUE) {
        return false;
    }
    AutoCall closeSnapshot(CloseHandle, hSnapshot);

    // our entry gives the parent pid, the parent's entry its exe name
    PROCESSENTRY32W pe = {};
    if (!FindProcessEntry(hSnapshot, GetCurrentProcessId(), &pe) ||
        !FindProcessEntry(hSnapshot, pe.th32ParentProcessID, &pe)) {
        return false;
    }
    TempStr parentName = ToUtf8Temp(WStr(pe.szExeFile));
    return str::StartsWithI(parentName, StrL("pwsh.exe")) || str::StartsWithI(parentName, StrL("powershell"));
}

bool IsProcessRunningElevated() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        return false;
    }
    TOKEN_ELEVATION elevation{};
    DWORD size = sizeof(elevation);
    BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, size, &size);
    CloseHandle(token);
    if (!ok) {
        return false;
    }
    return elevation.TokenIsElevated != 0;
}

// We assume that if OpenProcess() works, we are at the same or greater
// elevation level
// I tried to run IsProcessRunningElevated() on 2 processes but this didn't
// work if we're not elevated and other process is (because we can't OpenProcess())
bool CanTalkToProcess(DWORD procId) {
    BOOL inheritHandle = FALSE;
    HANDLE hProc = OpenProcess(PROCESS_QUERY_INFORMATION, inheritHandle, procId);
    if (hProc) {
        CloseHandle(hProc);
        return true;
    }
    return false;
}

/* Ensure that the rectangle is at least partially in the work area on a
   monitor. The rectangle is shifted into the work area if necessary. */

bool GetOsVersion(OSVERSIONINFOEX& ver) {
    ZeroMemory(&ver, sizeof(ver));
    ver.dwOSVersionInfoSize = sizeof(ver);
#pragma warning(push)
#pragma warning(disable : 4996)  // 'GetVersionEx': was declared deprecated
#pragma warning(disable : 28159) // Consider using 'IsWindows*' instead of 'GetVersionExW'
    // see: https://msdn.microsoft.com/en-us/library/windows/desktop/dn424972(v=vs.85).aspx
    // starting with Windows 8.1, GetVersionEx will report a wrong version number
    // unless the OS's GUID has been explicitly added to the compatibility manifest
    BOOL ok = GetVersionEx((OSVERSIONINFO*)&ver); // NOLINT
#pragma warning(pop)
    return !!ok;
}

TempStr OsNameFromVerTemp(const OSVERSIONINFOEX& ver) {
    if (VER_PLATFORM_WIN32_NT != ver.dwPlatformId) {
        return str::DupTemp(StrL("9x"));
    }
    if (ver.dwMajorVersion == 6 && ver.dwMinorVersion == 3) {
        return str::DupTemp(StrL("8.1")); // or Server 2012 R2
    }
    if (ver.dwMajorVersion == 6 && ver.dwMinorVersion == 2) {
        return str::DupTemp(StrL("8")); // or Server 2012
    }
    if (ver.dwMajorVersion == 6 && ver.dwMinorVersion == 1) {
        return str::DupTemp(StrL("7")); // or Server 2008 R2
    }
    if (ver.dwMajorVersion == 10) {
        // ver.dwMinorVersion seems to always be 0
        int buildNo = (int)(ver.dwBuildNumber & 0xFFFF);
        return fmt("10.%d", buildNo);
    }

    // either a newer or an older NT version, neither of which we support
    return fmt("NT %u.%u", ver.dwMajorVersion, ver.dwMinorVersion);
}

TempStr GetWindowsVerTemp() {
    OSVERSIONINFOEX ver{};
    if (!GetOsVersion(ver)) {
        return str::DupTemp(StrL("unknown"));
    }
    return OsNameFromVerTemp(ver);
}

bool IsProcess64() {
    return 8 == sizeof(void*);
}

bool IsProcess32() {
    return 4 == sizeof(void*);
}

// https://learn.microsoft.com/en-us/windows/win32/api/wow64apiset/nf-wow64apiset-iswow64process
bool IsRunningInWow64() {
    if (IsProcess64()) {
        // only 32-bit build can run under wow
        return false;
    }
    BOOL isWow = FALSE;
    if (IsWow64Process(GetCurrentProcess(), &isWow)) {
        return isWow == TRUE;
    }
    return false;
}

// return true if running on a 64-bit OS
bool IsOs64() {
    // 64-bit processes can only run on a 64-bit OS,
    // 32-bit processes run on a 64-bit OS under WOW64
    return IsProcess64() || IsRunningInWow64();
}

bool IsArmBuild() {
    return IS_ARM_64 == 1;
}

// number of logical processors available to the process

// return true if OS and our process have the same arch (i.e. both are 32bit
// or both are 64bit)
bool IsProcessAndOsArchSame() {
    return IsProcess64() == IsOs64();
}

void DisableDataExecution() {
    // Win7+; 32-bit only (fails with ERROR_NOT_SUPPORTED on 64-bit processes)
    SetProcessDEPPolicy(PROCESS_DEP_ENABLE);
}

u32 CpuID() {
#if IS_ARM_64
    // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-isprocessorfeaturepresent
    u32 res = 0;
    if (IsProcessorFeaturePresent(PF_ARM_NEON_INSTRUCTIONS_AVAILABLE)) {
        res |= kCpuNEON;
    }
    if (IsProcessorFeaturePresent(PF_ARM_V8_CRYPTO_INSTRUCTIONS_AVAILABLE)) {
        res |= kCpuArmCrypto;
    }
    if (IsProcessorFeaturePresent(PF_ARM_V81_ATOMIC_INSTRUCTIONS_AVAILABLE)) {
        res |= kCpuArmAtomics;
    }
    if (IsProcessorFeaturePresent(PF_ARM_V82_DP_INSTRUCTIONS_AVAILABLE)) {
        res |= kCpuArmDotProd;
    }
    return res;
#else
    // https://learn.microsoft.com/en-us/cpp/intrinsics/cpuid-cpuidex?view=msvc-170
    u32 f_1_ECX_ = 0;
    u32 f_1_EDX_ = 0;
    u32 f_7_EBX_ = 0;

    u32 res = 0;
    int cpuInfo[4]{};
    __cpuid(cpuInfo, 0);
    int nIds = cpuInfo[0];
    if (nIds >= 1) {
        __cpuid(cpuInfo, 1);
        f_1_ECX_ = cpuInfo[2];
        f_1_EDX_ = cpuInfo[3];
    }
    if (nIds >= 7) {
        __cpuid(cpuInfo, 7);
        f_7_EBX_ = cpuInfo[1];
    }

    // {register bits, bit no, flag}
    const struct {
        u32 reg;
        int bit;
        u32 flag;
    } kBits[] = {
        {f_1_EDX_, 23, kCpuMMX},   {f_1_EDX_, 25, kCpuSSE},   {f_1_EDX_, 26, kCpuSSE2}, {f_1_ECX_, 0, kCpuSSE3},
        {f_1_ECX_, 19, kCpuSSE41}, {f_1_ECX_, 20, kCpuSSE42}, {f_1_ECX_, 28, kCpuAVX},  {f_7_EBX_, 5, kCpuAVX2},
    };
    for (auto& b : kBits) {
        if (b.reg & (1u << b.bit)) {
            res |= b.flag;
        }
    }
    return res;
#endif
}

// most capable first, so the first match is the latest supported
// clang-format off
static const struct {
    u32 flag;
    Str name;
} kCpuFeatures[] = {
    {kCpuAVX2, StrL("avx2")},   {kCpuAVX, StrL("avx")},   {kCpuSSE42, StrL("sse42")},
    {kCpuSSE41, StrL("sse41")}, {kCpuSSE3, StrL("sse3")}, {kCpuSSE2, StrL("sse2")},
    {kCpuSSE, StrL("sse")},     {kCpuMMX, StrL("mmx")},
    {kCpuArmDotProd, StrL("dotprod")}, {kCpuArmAtomics, StrL("atomics")}, {kCpuArmCrypto, StrL("crypto")},
    {kCpuNEON, StrL("neon")},
};
// clang-format on

Str LatestSupportedSIMD() {
    u32 id = CpuID();
    for (auto& f : kCpuFeatures) {
        if ((id & f.flag) && f.flag != kCpuMMX) {
            return f.name;
        }
    }
    return StrL("none");
}

// space-separated names of every feature the CPU has, for the crash report
TempStr CpuFeaturesTemp() {
    u32 id = CpuID();
    str::Builder sb;
    for (auto& f : kCpuFeatures) {
        if (id & f.flag) {
            sb.Append(f.name);
            sb.AppendChar(' ');
        }
    }
    return ToStrTemp(sb);
}

//--- environment / errors / paths

Str GetLastErrorAsStr(Arena* arena) {
    DWORD err = GetLastError();
    if (!err) {
        return str::Dup(arena, StrL("no error"));
    }
    TempStr msg = GetLastErrorStrTemp(err);
    str::TrimSuffixWhitespace(msg);
    return str::Dup(arena, fmt("0x%08lX '%s'", err, msg));
}

// returns nullptr if not set
TempStr GetEnvVariableTemp(Str name) {
    WCHAR bufStatic[256];
    WCHAR* buf = &bufStatic[0];
    DWORD cchBufSize = dimof(bufStatic);
    WCHAR* nameW = CWStrTemp(name);
    DWORD res = GetEnvironmentVariableW(nameW, buf, cchBufSize);
    if (res == 0) {
        // env variable doesn't exist
        return {};
    }
    if (res >= cchBufSize) {
        // buffer was too small
        cchBufSize = res + 4; // +4 jic
        buf = AllocArrayTemp<WCHAR>((int)cchBufSize);
        res = GetEnvironmentVariableW(nameW, buf, cchBufSize);
        ReportIf(res == 0 || res > cchBufSize);
    }
    return ToUtf8Temp(buf);
}

TempStr GetLastErrorStrTemp(DWORD& err) {
    if (err == 0) {
        err = GetLastError();
    }
    if (err == 0) {
        return StrL("");
    }
    if (err == ERROR_INTERNET_EXTENDED_ERROR) {
        WCHAR buf[4096]{};
        DWORD bufSize = dimof(buf) - 1;
        // ignoring a case where buffer is too small. 4 kB should be enough for everybody
        InternetGetLastResponseInfoW(&err, buf, &bufSize);
        buf[dimof(buf) - 1] = 0;
        return ToUtf8Temp(buf);
    }
    WCHAR* msgBuf = nullptr;
    DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS;
    DWORD lang = MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT);
    DWORD ferr = FormatMessageW(flags, nullptr, err, lang, (LPWSTR)&msgBuf, 0, nullptr);
    if (!ferr || !msgBuf) {
        return StrL("");
    }
    TempStr res = ToUtf8Temp(msgBuf);
    LocalFree(msgBuf);
    return res;
}

void LogLastError(DWORD err) {
    TempStr msg = GetLastErrorStrTemp(err);
    if (str::IsNull(msg)) {
        msg = StrL("");
    }
    str::TrimWSInPlace(msg, str::TrimOpt::Both);
    logf("LogLastError: 0x%x (%d) '%s'\n", (int)err, (int)err, msg);
}

TempStr GetSpecialFolderTemp(int csidl, bool createIfMissing) {
    if (createIfMissing) {
        csidl = csidl | CSIDL_FLAG_CREATE;
    }
    WCHAR path[MAX_PATH]{};
    HRESULT res = SHGetFolderPathW(nullptr, csidl, nullptr, 0, path);
    if (S_OK != res) {
        return {};
    }
    return ToUtf8Temp(path);
}

// temp directory

// GetTempPathW() returns the size the path needs, including the terminator,
// when the buffer is too small, and writes nothing. Retry with that size.
// initialCch is a parameter so tests can force the retry.
// not GetTempPath2W(): it only differs for processes running as SYSTEM,
// which we never are
TempStr GetTempDirTemp(int initialCch) {
    int cchBuf = initialCch < 1 ? 1 : initialCch;
    WCHAR* dir = AllocArrayTemp<WCHAR>(cchBuf + 1);
    if (!dir) {
        return {};
    }
    DWORD cch = GetTempPathW((DWORD)cchBuf, dir);
    if (cch == 0) {
        return {};
    }
    if ((int)cch < cchBuf) {
        return ToUtf8Temp(WStr(dir, (int)cch));
    }
    WCHAR* buf = AllocArrayTemp<WCHAR>((int)cch + 1);
    if (!buf) {
        return {};
    }
    DWORD cch2 = GetTempPathW(cch, buf);
    if (cch2 == 0 || cch2 >= cch) {
        return {};
    }
    return ToUtf8Temp(WStr(buf, (int)cch2));
}

void ChangeCurrDirToDocuments() {
    TempStr dir = GetSpecialFolderTemp(CSIDL_MYDOCUMENTS);
    WCHAR* dirW = CWStrTemp(dir);
    SetCurrentDirectoryW(dirW);
}

TempStr ResolveLnkTemp(Str path) {
    TempWStr pathW = ToWStrTemp(path);
    if (!pathW.s) {
        return {};
    }

    AutoReleaseComPtr<IShellLink> lnk;
    if (!lnk.Create(CLSID_ShellLink)) {
        return {};
    }

    AutoReleaseComQIPtr<IPersistFile> file(lnk);
    if (!file) {
        return {};
    }

    HRESULT hRes = file->Load(pathW.s, STGM_READ);
    if (FAILED(hRes)) {
        return {};
    }

    hRes = lnk->Resolve(nullptr, SLR_UPDATE);
    if (FAILED(hRes)) {
        return {};
    }

    WCHAR newPath[MAX_PATH]{};
    hRes = lnk->GetPath(newPath, MAX_PATH, nullptr, 0);
    if (FAILED(hRes)) {
        return {};
    }

    return ToUtf8Temp(newPath);
}

bool CreateShortcut(Str shortcutPath, Str exePath, Str args, Str description, int iconIndex) {
    TempWStr ws;
    AutoCoUninitialize com;

    AutoReleaseComPtr<IShellLink> lnk;
    if (!lnk.Create(CLSID_ShellLink)) {
        return false;
    }

    AutoReleaseComQIPtr<IPersistFile> file(lnk);
    if (!file) {
        return false;
    }

    ws = ToWStrTemp(exePath);
    HRESULT hr = lnk->SetPath(ws.s);
    if (FAILED(hr)) {
        return false;
    }

    lnk->SetWorkingDirectory(path::GetDirTemp(ws).s);
    // lnk->SetShowCmd(SW_SHOWNORMAL);
    // lnk->SetHotkey(0);
    lnk->SetIconLocation(ws.s, iconIndex);
    if (args) {
        ws = ToWStrTemp(args);
        lnk->SetArguments(ws.s);
    }
    if (description) {
        ws = ToWStrTemp(description);
        lnk->SetDescription(ws.s);
    }

    ws = ToWStrTemp(shortcutPath);
    hr = file->Save(ws.s, TRUE);
    return SUCCEEDED(hr);
}

//--- process launch / shell

// SHAddToRecentDocs blocks while the shell resolves the path and writes
// Recent, ~40 ms for a local file and longer on a network path. Run it off
// the UI thread with COM initialized and a heap-owned path.
static void AddPathToRecentDocsOnThread(WCHAR* pathW) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool comInitedByUs = SUCCEEDED(hr);
    if (!comInitedByUs && hr != RPC_E_CHANGED_MODE) {
        logf("AddPathToRecentDocsOnThread: CoInitializeEx failed hr=0x%08x\n", (unsigned)hr);
        free(pathW);
        return;
    }

    if (pathW) {
        SHAddToRecentDocs(SHARD_PATH, pathW);
    }
    free(pathW);

    if (comInitedByUs) {
        CoUninitialize();
    }
}

void AddPathToRecentDocs(Str path) {
    if (len(path) == 0) {
        return;
    }
    WCHAR* owned = ToWStr(path).s; // heap; thread frees
    if (!owned) {
        return;
    }
    RunAsync(MkFunc0(AddPathToRecentDocsOnThread, owned), StrL("AddPathToRecentDocs"));
}

// based on http://mdb-blog.blogspot.com/2013/01/nsis-lunch-program-as-user-from-uac.html
// uses $WINDIR\explorer.exe to launch cmd
// Other promising approaches:
// - http://blogs.msdn.com/b/oldnewthing/archive/2013/11/18/10468726.aspx
// - http://brandonlive.com/2008/04/27/getting-the-shell-to-run-an-application-for-you-part-2-how/
// - http://www.codeproject.com/Articles/23090/Creating-a-process-with-Medium-Integration-Level-f
// Approaches tried but didn't work:
// - http://stackoverflow.com/questions/3298611/run-my-program-asuser
// - using CreateProcessAsUser() with hand-crafted token
// It'll always run the process, might fail to run non-elevated if fails to find explorer.exe
// Also, if explorer.exe is running elevated, it'll probably run elevated as well.
void RunNonElevated(Str exePath) {
    if (!CanLaunchShell()) {
        return;
    }
    if (!file::Exists(exePath)) {
        logf("RunNonElevated: file '%s' doesn't exist\n", exePath);
        return;
    }
    logf("RunNonElevated: '%s'\n", exePath);
    TempStr cmd;
    TempStr explorerPath;
    WCHAR buf[MAX_PATH] = {};
    uint res = GetWindowsDirectoryW(buf, dimof(buf));
    if (0 == res || res >= dimof(buf)) {
        goto Run;
    }
    explorerPath = ToUtf8Temp(buf);
    explorerPath = path::JoinTemp(explorerPath, StrL("explorer.exe"));
    if (!file::Exists(explorerPath)) {
        goto Run;
    }
    cmd = fmt("\"%s\" \"%s\"", explorerPath, exePath);
Run:
    // LaunchProcessInDir needs the exe quoted: "C:\Program Files\..." would
    // otherwise first try to run C:\Program.exe
    if (len(cmd) == 0) {
        cmd = fmt("\"%s\"", exePath);
    }
    HANDLE h = LaunchProcessInDir(cmd);
    SafeCloseHandle(&h);
}

bool CanLaunchShell() {
    if (GetEnvironmentVariableW(L"SOLOKPDF_BLOCK_SHELL_LAUNCH", nullptr, 0) == 0) {
        return true;
    }
    log(StrL("Blocked shell launch during testing\n"));
    return false;
}

bool LaunchFileShell(Str path, Str params, Str verb, bool hidden) {
    if (!CanLaunchShell()) {
        return false;
    }
    if (len(path) == 0) {
        return false;
    }

    SHELLEXECUTEINFOW sei{};
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_FLAG_NO_UI;
    sei.lpVerb = CWStrTemp(verb);
    sei.lpFile = CWStrTemp(path);
    sei.lpParameters = CWStrTemp(params);
    sei.nShow = hidden ? SW_HIDE : SW_SHOWNORMAL;
    BOOL ok = ShellExecuteExW(&sei);
    if (!ok) {
        DWORD err = GetLastError();
        logf("LaunchFile: ShellExecuteExW path: '%s' params: '%s' verb: '%s'\n", path, params, verb);
        LogLastError(err);
        return false;
    }
    logf("LaunchFileShell: launched '%s'\n", path);
    return true;
}

bool LaunchBrowser(Str url) {
    return LaunchFileShell(url, Str(), StrL("open"));
}

void OpenPathInDefaultFileManager(Str path) {
    if (!CanLaunchShell()) {
        return;
    }
    if (len(path) == 0) {
        return;
    }

    // strip \\?\ prefix — shell APIs (ILCreateFromPath, explorer.exe) don't understand it
    str::TrimPrefix(path, StrL("\\\\?\\"));

    // Use SHOpenFolderAndSelectItems which respects the default file manager
    // (e.g. Directory Opus) instead of hardcoding explorer.exe
    WCHAR* pathW = CWStrTemp(path);
    PIDLIST_ABSOLUTE pidl = ILCreateFromPathW(pathW);
    if (pidl) {
        SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
        ILFree(pidl);
        return;
    }

    // fallback to using explorer.exe
    WCHAR winDir[MAX_PATH]{};
    UINT n = GetWindowsDirectoryW(winDir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return;
    TempStr explorer = ToUtf8Temp(winDir);
    explorer = path::JoinTemp(explorer, StrL("explorer.exe"));
    if (file::Exists(explorer)) return;
    TempStr args = fmt("/select,\"%s\"", path);
    CreateProcessHelper(explorer, args);
}

HANDLE LaunchProcessWithCmdLine(Str exe, Str cmdLine) {
    PROCESS_INFORMATION pi = {nullptr};
    STARTUPINFOW si{};
    si.cb = sizeof(si);

    // first cmd-line argument should be the exe name
    TempStr cmd = fmt("\"%s\" %s", exe, cmdLine);
    WCHAR* cmdLineW = CWStrTemp(cmd);

    WCHAR* exeW = CWStrTemp(exe);
    // note: cmdLineW is modified by CreateProcessW so must be writeable
    BOOL ok = CreateProcessW(exeW, cmdLineW, nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi);
    if (!ok) {
        return nullptr;
    }

    CloseHandle(pi.hThread);
    return pi.hProcess;
}

// cmdLine must contain quoted exe path as first argument
HANDLE LaunchProcessInDir(Str cmdLine, Str currDir, DWORD flags) {
    PROCESS_INFORMATION pi = {nullptr};
    STARTUPINFOW si{};
    si.cb = sizeof(si);

    // CreateProcess() might modify cmd line argument, so make a copy
    // in case caller provides a read-only string
    WCHAR* cmdLineW = CWStrTemp(cmdLine);
    // lpCurrentDirectory must be nullptr (inherit caller's dir) when no dir is
    // given. CWStrTemp() of an empty Str returns a non-null L"" which
    // CreateProcessW rejects (ERROR_DIRECTORY), so map empty -> nullptr.
    WCHAR* dirW = len(currDir) == 0 ? nullptr : CWStrTemp(currDir);
    if (!CreateProcessW(nullptr, cmdLineW, nullptr, nullptr, FALSE, flags, nullptr, dirW, &si, &pi)) {
        return nullptr;
    }

    CloseHandle(pi.hThread);
    return pi.hProcess;
}

bool CreateProcessHelper(Str exe, Str args) {
    if (len(args) == 0) {
        args = StrL("");
    }
    TempStr cmd = fmt("\"%s\" %s", exe, args);
    AutoCloseHandle process = LaunchProcessInDir(cmd);
    return process != nullptr;
}

struct ChildProcess {
    HANDLE process = nullptr;
};

ChildProcess* StartChildProcess(Str cmdLine) {
    HANDLE h = LaunchProcessInDir(cmdLine);
    if (!h) {
        return nullptr;
    }
    auto* p = new ChildProcess();
    p->process = h;
    return p;
}

bool LaunchElevated(Str path, Str cmdline) {
    return LaunchFileShell(path, cmdline, StrL("runas"));
}

//--- console

enum class ConsoleState {
    Uninitialized,
    NoConsole,
    StdoutRedirected,
    AttachedToParent,
    AllocatedNew,
};

static ConsoleState gConsoleState = ConsoleState::Uninitialized;
static HANDLE gOriginalStdout = INVALID_HANDLE_VALUE;
static HANDLE gOriginalStderr = INVALID_HANDLE_VALUE;
static HWND gStartupForegroundWindow = nullptr;
static bool gLoggedToConsole = false;

static void InitConsoleState() {
    if (gConsoleState != ConsoleState::Uninitialized) {
        return;
    }

    gStartupForegroundWindow = GetForegroundWindow();
    gOriginalStdout = GetStdHandle(STD_OUTPUT_HANDLE);
    gOriginalStderr = GetStdHandle(STD_ERROR_HANDLE);
    if (gOriginalStdout != INVALID_HANDLE_VALUE && gOriginalStdout != nullptr) {
        DWORD fileType = GetFileType(gOriginalStdout);
        if (fileType == FILE_TYPE_DISK) {
            gConsoleState = ConsoleState::StdoutRedirected;
            return;
        }
        // PowerShell pipe redirection breaks WriteFile from GUI apps; attach to console instead.
        if (fileType == FILE_TYPE_PIPE && !WasLaunchedByPowershellWithPipeRedirect()) {
            gConsoleState = ConsoleState::StdoutRedirected;
            return;
        }
    }

    gConsoleState = ConsoleState::NoConsole;
}

static bool StdoutRedirected() {
    InitConsoleState();
    return gConsoleState == ConsoleState::StdoutRedirected;
}

// https://www.tillett.info/2013/05/13/how-to-create-a-windows-program-that-works-as-both-as-a-gui-and-console-application/
// TODO: see if https://github.com/apenwarr/fixconsole/blob/master/fixconsole_windows.go would improve things
// a stream whose parent-provided handle is a file or pipe was redirected by the
// parent (`> out.txt`, `| more`) and must keep receiving CRT output even after
// we attach to a console for logging
static bool IsFileOrPipe(HANDLE h) {
    if (h == nullptr || h == INVALID_HANDLE_VALUE) {
        return false;
    }
    DWORD fileType = GetFileType(h);
    return fileType == FILE_TYPE_DISK || fileType == FILE_TYPE_PIPE;
}

static void RedirectStdioToConsole(bool redirectStdin = false) {
    FILE* con{nullptr};
    if (!IsFileOrPipe(gOriginalStdout)) {
        freopen_s(&con, "CONOUT$", "w", stdout);
        setvbuf(stdout, nullptr, _IONBF, 0);
    }
    if (!IsFileOrPipe(gOriginalStderr)) {
        freopen_s(&con, "CONOUT$", "w", stderr);
        setvbuf(stderr, nullptr, _IONBF, 0);
    }
    if (redirectStdin) {
        freopen_s(&con, "CONIN$", "r", stdin);
        setvbuf(stdin, nullptr, _IONBF, 0);
    }
}

// Attaches stdio to the parent's console; with allocIfNone, creates a console
// window when there is no parent console. Returns true when a new one was made.
static bool InitConsole(bool allocIfNone) {
    InitConsoleState();
    if (gConsoleState == ConsoleState::AllocatedNew) {
        return true;
    }
    if (gConsoleState == ConsoleState::AttachedToParent || StdoutRedirected()) {
        return false;
    }
    if (gConsoleState != ConsoleState::NoConsole) {
        return false;
    }

    if (AttachConsole(ATTACH_PARENT_PROCESS)) {
        gConsoleState = ConsoleState::AttachedToParent;
        RedirectStdioToConsole(true);
        return false;
    }
    if (!allocIfNone) {
        return false;
    }

    AllocConsole();
    gConsoleState = ConsoleState::AllocatedNew;
    CONSOLE_SCREEN_BUFFER_INFO coninfo;
    GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &coninfo);
    coninfo.dwSize.Y = 500;
    SetConsoleScreenBufferSize(GetStdHandle(STD_OUTPUT_HANDLE), coninfo.dwSize);
    RedirectStdioToConsole(true);
    return true;
}

// true if stdio now goes to a console (the parent's, one we made, or a pipe)
bool RedirectIOToExistingConsole() {
    InitConsole(false);
    return gConsoleState != ConsoleState::NoConsole || StdoutRedirected();
}

// returns true if had to allocate new console (i.e. show console window)
// false if redirected to existing console, which means it was launched from a shell
bool RedirectIOToConsole() {
    return InitConsole(true);
}

static void SendEnterToParentConsole(HWND foregroundWnd) {
    if (foregroundWnd && IsWindow(foregroundWnd)) {
        SetForegroundWindow(foregroundWnd);
    }
    INPUT inputs[2] = {};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_RETURN;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_RETURN;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, inputs, sizeof(INPUT));
}

void HandleRedirectedConsoleOnShutdown() {
    InitConsoleState();
    if (gConsoleState == ConsoleState::AllocatedNew) {
        system("pause");
    } else if (gConsoleState == ConsoleState::AttachedToParent) {
        SendEnterToParentConsole(nullptr);
    }
}

void LogConsole(Str s) {
    if (s.len <= 0) {
        return;
    }

    InitConsoleState();
    if (StdoutRedirected()) {
        if (gOriginalStdout != INVALID_HANDLE_VALUE) {
            DWORD written;
            // log() holds its mutex here, so a failed write cannot call logf().
            WriteFile(gOriginalStdout, s.s, s.len, &written, nullptr);
        }
        return;
    }

    // passive by design: write only to a console that already exists (inherited
    // or explicitly set up via RedirectIOToConsole / RedirectIOToExistingConsole).
    // never attach to the parent console or allocate one here: logging from a GUI
    // process launched by a script would spray log lines over the terminal of
    // whatever shell happens to be the ancestor
    HANDLE hConsole = GetStdHandle(STD_OUTPUT_HANDLE);
    if (hConsole == nullptr || hConsole == INVALID_HANDLE_VALUE) {
        return;
    }
    DWORD written;
    // fails harmlessly if the handle is not a console (e.g. a pipe we chose not to write to)
    if (WriteConsoleA(hConsole, s.s, s.len, &written, nullptr)) {
        gLoggedToConsole = true;
    }
}

//--- registry

bool gLogRegistryCalls = false;

// return true if a given registry key (path) exists
bool RegKeyExists(HKEY keySub, Str keyName) {
    HKEY hKey;
    WCHAR* keyNameW = CWStrTemp(keyName);
    LONG res = RegOpenKeyW(keySub, keyNameW, &hKey);
    if (ERROR_SUCCESS == res) {
        RegCloseKey(hKey);
        return true;
    }

    // return true for key that exists even if it's not
    // accessible by us
    return ERROR_ACCESS_DENIED == res;
}

TempStr ReadRegStrTemp(HKEY keySub, Str keyName, Str valName) {
    if (!keySub) {
        return {};
    }
    WCHAR* keyNameW = CWStrTemp(keyName);
    WCHAR* valNameW = CWStrTemp(valName);
    WStr val;
    REGSAM access = KEY_READ;
    HKEY hKey;
TryAgainWOW64:
    LONG res = RegOpenKeyEx(keySub, keyNameW, 0, access, &hKey);
    if (ERROR_SUCCESS == res) {
        DWORD valLen;
        res = RegQueryValueEx(hKey, valNameW, nullptr, nullptr, nullptr, &valLen);
        if (ERROR_SUCCESS == res) {
            val = WStr(AllocArray<WCHAR>((int)(valLen / sizeof(WCHAR)) + 1));
            res = RegQueryValueEx(hKey, valNameW, nullptr, nullptr, (LPBYTE)val.s, &valLen);
            if (ERROR_SUCCESS != res) {
                wstr::FreePtr(&val);
            }
        }
        RegCloseKey(hKey);
    }
    if (ERROR_FILE_NOT_FOUND == res && HKEY_LOCAL_MACHINE == keySub && KEY_READ == access) {
// try the (non-)64-bit key as well, as HKLM\Software is not shared between 32-bit and
// 64-bit applications per http://msdn.microsoft.com/en-us/library/aa384253(v=vs.85).aspx
#ifdef _WIN64
        access = KEY_READ | KEY_WOW64_32KEY;
#else
        access = KEY_READ | KEY_WOW64_64KEY;
#endif
        goto TryAgainWOW64;
    }
    TempStr resv = ToUtf8Temp(val.s);
    wstr::Free(val);
    return resv;
}

TempStr LoggedReadRegStrTemp(HKEY keySub, Str keyName, Str valName) {
    auto res = ReadRegStrTemp(keySub, keyName, valName);
    if (!gLogRegistryCalls) {
        return res;
    }
    logf("ReadRegStrTemp(%s, %s, %s) => '%s'\n", RegKeyNameTemp(keySub), keyName, valName, res);
    return res;
}

TempStr ReadRegStr2Temp(Str keyName, Str valName) {
    TempStr res = ReadRegStrTemp(HKEY_LOCAL_MACHINE, keyName, valName);
    if (len(res) == 0) {
        res = ReadRegStrTemp(HKEY_CURRENT_USER, keyName, valName);
    }
    return res;
}

TempStr LoggedReadRegStr2Temp(Str keyName, Str valName) {
    TempStr res = LoggedReadRegStrTemp(HKEY_LOCAL_MACHINE, keyName, valName);
    if (len(res) == 0) {
        res = LoggedReadRegStrTemp(HKEY_CURRENT_USER, keyName, valName);
    }
    return res;
}

// the Logged* registry writers do the plain call and log it when enabled
static void LogRegCall(bool ok, TempStr call) {
    if (!gLogRegistryCalls) {
        return;
    }
    logf("%s => %s\n", call, ok ? StrL("ok") : StrL("failed"));
    if (!ok) {
        LogLastError();
    }
}

bool WriteRegStr(HKEY keySub, Str keyName, Str valName, Str value) {
    WCHAR* keyNameW = CWStrTemp(keyName);
    WCHAR* valNameW = CWStrTemp(valName);
    int cch;
    WCHAR* valueW = CWStrTemp(value, cch);
    DWORD cbData = (DWORD)(cch + 1) * sizeof(WCHAR);
    LSTATUS res = SHSetValueW(keySub, keyNameW, valNameW, REG_SZ, (const void*)valueW, cbData);
    return ERROR_SUCCESS == res;
}

bool LoggedWriteRegStr(HKEY keySub, Str keyName, Str valName, Str value) {
    bool ok = WriteRegStr(keySub, keyName, valName, value);
    LogRegCall(ok, fmt("WriteRegStr(%s, %s, %s, %s)", RegKeyNameTemp(keySub), keyName, valName, value));
    return ok;
}

bool ReadRegDWORD(HKEY keySub, Str keyName, Str valName, DWORD& value) {
    WCHAR* keyNameW = CWStrTemp(keyName);
    WCHAR* valNameW = CWStrTemp(valName);
    DWORD size = sizeof(DWORD);
    LSTATUS res = SHGetValue(keySub, keyNameW, valNameW, nullptr, &value, &size);
    return ERROR_SUCCESS == res && sizeof(DWORD) == size;
}

bool WriteRegDWORD(HKEY keySub, Str keyName, Str valName, DWORD value) {
    WCHAR* keyNameW = CWStrTemp(keyName);
    WCHAR* valNameW = CWStrTemp(valName);
    LSTATUS res = SHSetValueW(keySub, keyNameW, valNameW, REG_DWORD, (const void*)&value, sizeof(DWORD));
    return ERROR_SUCCESS == res;
}

static bool WriteRegNone(HKEY hkey, Str key, Str valName) {
    WCHAR* keyW = CWStrTemp(key);
    WCHAR* valNameW = CWStrTemp(valName);
    LSTATUS res = SHSetValueW(hkey, keyW, valNameW, REG_NONE, nullptr, 0);
    return ERROR_SUCCESS == res;
}

bool LoggedWriteRegDWORD(HKEY keySub, Str keyName, Str valName, DWORD value) {
    bool ok = WriteRegDWORD(keySub, keyName, valName, value);
    LogRegCall(ok, fmt("WriteRegDWORD(%s, %s, %s, %d)", RegKeyNameTemp(keySub), keyName, valName, (int)value));
    return ok;
}

bool LoggedWriteRegNone(HKEY hkey, Str key, Str valName) {
    bool ok = WriteRegNone(hkey, key, valName);
    LogRegCall(ok, fmt("WriteRegNone(%s, %s, %s)", RegKeyNameTemp(hkey), key, valName));
    return ok;
}

bool CreateRegKey(HKEY keySub, Str keyName) {
    WCHAR* keyNameW = CWStrTemp(keyName);
    HKEY hKey;
    LSTATUS res = RegCreateKeyExW(keySub, keyNameW, 0, nullptr, 0, KEY_WRITE, nullptr, &hKey, nullptr);
    if (res != ERROR_SUCCESS) {
        return false;
    }
    RegCloseKey(hKey);
    return true;
}

TempStr RegKeyNameTemp(HKEY key) {
    if (key == HKEY_LOCAL_MACHINE) {
        return StrL("HKEY_LOCAL_MACHINE");
    }
    if (key == HKEY_CURRENT_USER) {
        return StrL("HKEY_CURRENT_USER");
    }
    if (key == HKEY_CLASSES_ROOT) {
        return StrL("HKEY_CLASSES_ROOT");
    }
    return StrL("RegKeyName: unknown key");
}

// Open a registry key's DACL so we can delete protected uninstall/keys.
// Uses an explicit Everyone FULL_CONTROL ACL (not a NULL DACL, which CodeQL flags).
static void ResetRegKeyAcl(HKEY hkey, Str keyName) {
    WCHAR* keyNameW = CWStrTemp(keyName);
    HKEY hKey;
    LONG res = RegOpenKeyEx(hkey, keyNameW, 0, WRITE_DAC, &hKey);
    if (ERROR_SUCCESS != res) {
        return;
    }

    PSID everyoneSid = nullptr;
    PACL dacl = nullptr;
    SID_IDENTIFIER_AUTHORITY worldAuth = SECURITY_WORLD_SID_AUTHORITY;
    if (!AllocateAndInitializeSid(&worldAuth, 1, SECURITY_WORLD_RID, 0, 0, 0, 0, 0, 0, 0, &everyoneSid)) {
        RegCloseKey(hKey);
        return;
    }

    EXPLICIT_ACCESSW ea{};
    ea.grfAccessPermissions = KEY_ALL_ACCESS;
    ea.grfAccessMode = SET_ACCESS;
    ea.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea.Trustee.ptstrName = (LPWSTR)everyoneSid;

    if (SetEntriesInAclW(1, &ea, nullptr, &dacl) != ERROR_SUCCESS) {
        FreeSid(everyoneSid);
        RegCloseKey(hKey);
        return;
    }

    SECURITY_DESCRIPTOR secdesc;
    InitializeSecurityDescriptor(&secdesc, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&secdesc, TRUE, dacl, FALSE);
    RegSetKeySecurity(hKey, DACL_SECURITY_INFORMATION, &secdesc);

    LocalFree(dacl);
    FreeSid(everyoneSid);
    RegCloseKey(hKey);
}

bool DeleteRegKey(HKEY keySub, Str keyName, bool resetACLFirst) {
    if (resetACLFirst) {
        ResetRegKeyAcl(keySub, keyName);
    }
    WCHAR* keyNameW = CWStrTemp(keyName);
    LSTATUS res = SHDeleteKeyW(keySub, keyNameW);
    return ERROR_SUCCESS == res || ERROR_FILE_NOT_FOUND == res;
}

bool LoggedDeleteRegKey(HKEY keySub, Str keyName, bool resetACLFirst) {
    bool ok = DeleteRegKey(keySub, keyName, resetACLFirst);
    LogRegCall(ok, fmt("DeleteRegKey(%s, %s, %d)", RegKeyNameTemp(keySub), keyName, resetACLFirst));
    return ok;
}

bool DeleteRegValue(HKEY keySub, Str keyName, Str val) {
    WCHAR* keyNameW = CWStrTemp(keyName);
    WCHAR* valW = CWStrTemp(val);

    auto res = SHDeleteValueW(keySub, keyNameW, valW);
    return ERROR_SUCCESS == res || ERROR_FILE_NOT_FOUND == res;
}

bool LoggedDeleteRegValue(HKEY keySub, Str keyName, Str val) {
    bool ok = DeleteRegValue(keySub, keyName, val);
    LogRegCall(ok, fmt("DeleteRegValue(%s, %s, %s)", RegKeyNameTemp(keySub), keyName, val));
    return ok;
}

//--- COM / streams / DDE / DLL servers

IStream* CreateStreamFromData(const Str& d) {
    // d is binary bytes; formats like JP2/JXL/TGA legitimately start with a 0 byte
    if (len(d) == 0) {
        return nullptr;
    }

    const void* data = (u8*)d.s;
    size_t dataLen = (size_t)d.len;
    AutoReleaseComPtr<IStream> stream;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream))) {
        return nullptr;
    }

    ULONG n;
    if (FAILED(stream->Write(data, (ULONG)dataLen, &n)) || n != dataLen) {
        return nullptr;
    }

    LARGE_INTEGER zero{};
    stream->Seek(zero, STREAM_SEEK_SET, nullptr);

    stream->AddRef();
    return stream;
}

Str ReadIStream(IStream* stream) {
    if (!stream) {
        return {};
    }

    STATSTG stat;
    HRESULT res = stream->Stat(&stat, STATFLAG_NONAME);
    if (FAILED(res)) {
        return {};
    }
    if (stat.cbSize.QuadPart > INT_MAX - sizeof(WCHAR)) {
        return {};
    }

    int n = (int)stat.cbSize.QuadPart;
    char* d = AllocArray<char>(n + sizeofi(WCHAR));
    if (!d) {
        return {};
    }

    LARGE_INTEGER zero{};
    res = stream->Seek(zero, STREAM_SEEK_SET, nullptr);
    if (FAILED(res)) {
        free(d);
        return {};
    }

    int total = 0;
    while (total < n) {
        ULONG read = 0;
        ULONG toRead = (ULONG)(n - total);
        res = stream->Read(d + total, toRead, &read);
        if (FAILED(res) || read == 0) {
            free(d);
            return {};
        }
        total += (int)read;
    }
    d[n] = 0;
    d[n + 1] = 0;
    return Str(d, n);
}

void VariantInitBstr(VARIANT& urlVar, WStr s) {
    VariantInit(&urlVar);
    urlVar.vt = VT_BSTR;
    urlVar.bstrVal = SysAllocStringLen(s.s, s.len);
}

static HDDEDATA CALLBACK DdeCallback(UINT /*type*/, UINT /*fmt*/, HCONV /*hconv*/, HSZ /*hsz1*/, HSZ /*hsz2*/,
                                     HDDEDATA /*hdata*/, ULONG_PTR /*data1*/, ULONG_PTR /*data2*/) {
    return nullptr;
}

bool DDEExecute(WStr server, WStr topic, WStr command) {
    DWORD inst = 0;
    HSZ hszServer = nullptr, hszTopic = nullptr;
    HCONV hconv = nullptr;
    bool ok = false;
    uint result = 0;
    DWORD cbLen = 0;
    HDDEDATA answer;

    ReportIf(command.len >= INT_MAX - 1);
    if (command.len >= INT_MAX - 1) {
        return false;
    }

    result = DdeInitializeW(&inst, DdeCallback, APPCMD_CLIENTONLY, 0);
    if (result != DMLERR_NO_ERROR) {
        return false;
    }

    hszServer = DdeCreateStringHandleW(inst, server.s, CP_WINNEUTRAL);
    if (!hszServer) {
        goto Exit;
    }
    hszTopic = DdeCreateStringHandleW(inst, topic.s, CP_WINNEUTRAL);
    if (!hszTopic) {
        goto Exit;
    }
    hconv = DdeConnect(inst, hszServer, hszTopic, nullptr);
    if (!hconv) {
        goto Exit;
    }

    cbLen = ((DWORD)command.len + 1) * sizeof(WCHAR);
    answer =
        DdeClientTransaction((BYTE*)command.s, cbLen, hconv, nullptr, CF_UNICODETEXT, XTYP_EXECUTE, 10000, nullptr);
    if (answer) {
        DdeFreeDataHandle(answer);
        ok = true;
    }

Exit:
    if (hconv) {
        DdeDisconnect(hconv);
    }
    if (hszTopic) {
        DdeFreeStringHandle(inst, hszTopic);
    }
    if (hszServer) {
        DdeFreeStringHandle(inst, hszServer);
    }
    DdeUninitialize(inst);

    return ok;
}

/* adapted from http://blogs.msdn.com/oldnewthing/archive/2004/09/20/231739.aspx */

HRESULT CLSIDFromString(Str lpsz, LPCLSID pclsid) {
    WCHAR* ws = CWStrTemp(lpsz);
    return CLSIDFromString(ws, pclsid);
}

// roots of all logical drives: "C:\", "D:\", ...
void ListDriveRoots(StrVec& out) {
    char root[] = "A:\\";
    for (DWORD mask = GetLogicalDrives(); mask; mask >>= 1) {
        if (mask & 1) {
            out.Append(Str(root, 3));
        }
        root[0]++;
    }
}

// Explorer's Quick access (pinned and frequent folders, recent files) as
// file-system paths, in Explorer's order. Slow: the shell resolves every
// entry, so callers cache the result. Needs COM initialized on this thread.
bool ListShellQuickAccess(StrVec& dirsOut, StrVec& filesOut) {
    const WCHAR* kQuickAccess = L"shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}";
    AutoReleaseComPtr<IShellItem> folder;
    HRESULT hr = SHCreateItemFromParsingName(kQuickAccess, nullptr, IID_PPV_ARGS(&folder));
    if (FAILED(hr)) {
        return false;
    }
    AutoReleaseComPtr<IEnumShellItems> items;
    hr = folder->BindToHandler(nullptr, BHID_EnumItems, IID_PPV_ARGS(&items));
    if (FAILED(hr)) {
        return false;
    }
    for (;;) {
        IShellItem* item = nullptr;
        if (items->Next(1, &item, nullptr) != S_OK || !item) {
            break;
        }
        AutoReleaseComPtr<IShellItem> rel(item);
        WCHAR* pathW = nullptr;
        // virtual entries (libraries, network locations) have no path: skip
        if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &pathW)) || !pathW) {
            continue;
        }
        SFGAOF attrs = 0;
        item->GetAttributes(SFGAO_FOLDER, &attrs);
        StrVec& out = (attrs & SFGAO_FOLDER) ? dirsOut : filesOut;
        out.Append(ToUtf8Temp(WStr(pathW)));
        CoTaskMemFree(pathW);
    }
    return true;
}

//--- resources / instance / common controls

// http://blogs.msdn.com/b/oldnewthing/archive/2004/10/25/247180.aspx
EXTERN_C IMAGE_DOS_HEADER __ImageBase;

// A convenient way to grab the same value as HINSTANCE passed to WinMain
HINSTANCE GetInstance() {
    return (HINSTANCE)&__ImageBase;
}

Size ButtonGetIdealSize(HWND hwnd) {
    // adjust to real size and position to the right
    SIZE s{};
    Button_GetIdealSize(hwnd, &s);
    // add padding
    int xPadding = DpiScale(8 * 2);
    int yPadding = DpiScale(2 * 2);
    s.cx += xPadding;
    s.cy += yPadding;
    Size res = {s.cx, s.cy};
    return res;
}

constexpr int kResourceNotFound = -1;

// mod: the module holding the resource, the process exe when null
bool LockDataResource(int resId, LoadedDataResource* res, HMODULE mod) {
    if (res->dataSize != 0) {
        return res->dataSize != kResourceNotFound;
    }

    HMODULE h = mod ? mod : GetModuleHandleW(nullptr);
    WCHAR* name = MAKEINTRESOURCEW(resId);
    HRSRC resSrc = FindResourceW(h, name, RT_RCDATA);
    if (!resSrc) {
        res->dataSize = kResourceNotFound;
        return false;
    }
    HGLOBAL hres = LoadResource(h, resSrc);
    if (!hres) {
        res->dataSize = kResourceNotFound;
        return false;
    }
    res->data = (const u8*)LockResource(hres);
    res->dataSize = (int)SizeofResource(h, resSrc);
    return true;
}

bool IsValidDelayType(int type) {
    return type == TTDT_AUTOPOP || type == TTDT_INITIAL || type == TTDT_RESHOW || type == TTDT_AUTOMATIC;
}

void InitAllCommonControls() {
    INITCOMMONCONTROLSEX cex{};
    cex.dwSize = sizeof(INITCOMMONCONTROLSEX);
    cex.dwICC = ICC_WIN95_CLASSES | ICC_DATE_CLASSES | ICC_USEREX_CLASSES | ICC_COOL_CLASSES;
    InitCommonControlsEx(&cex);
}

void FillWndClassEx(WNDCLASSEX& wcex, WStr clsName, WNDPROC wndproc) {
    ZeroMemory(&wcex, sizeof(WNDCLASSEX));
    wcex.cbSize = sizeof(WNDCLASSEX);
    wcex.style = CS_HREDRAW | CS_VREDRAW;
    wcex.hInstance = GetModuleHandle(nullptr);
    wcex.hCursor = GetCachedCursor(IDC_ARROW);
    wcex.lpszClassName = clsName.s;
    wcex.lpfnWndProc = wndproc;
}

//--- HGLOBAL / atoms

TempStr HGLOBALToStrTemp(HGLOBAL h, bool isUnicode) {
    void* mem = GlobalLock(h);
    if (!mem) {
        return {};
    }

    TempStr res;
    if (isUnicode) {
        res = ToUtf8Temp(WStr((WCHAR*)mem));
    } else {
        res = str::DupTemp(Str((char*)mem));
    }
    GlobalUnlock(h);
    return res;
}

HGLOBAL MemToHGLOBAL(void* src, int n, UINT flags) {
    HGLOBAL h = GlobalAlloc(flags, n);
    if (!h) {
        return nullptr;
    }
    void* d = GlobalLock(h);
    if (d) {
        memcpy(d, src, n);
    }
    GlobalUnlock(h);
    return h;
}

TempStr AtomToStrTemp(ATOM a) {
    WCHAR buf[1024];
    UINT cch = GlobalGetAtomNameW(a, buf, dimofi(buf));
    if (cch == 0) {
        return {};
    }
    return ToUtf8Temp(WStr(buf, (int)cch));
}

//--- misc

uint GuessTextCodepage(Str data, uint defVal) {
    // try to guess the codepage
    AutoReleaseComPtr<IMultiLanguage2> pMLang;
    if (!pMLang.Create(CLSID_CMultiLanguage)) {
        return defVal;
    }

    int ilen = std::min(data.len, INT_MAX);
    int count = 1;
    DetectEncodingInfo info{};
    HRESULT hr = pMLang->DetectInputCodepage(MLDETECTCP_NONE, CP_ACP, data.s, &ilen, &info, &count);
    if (FAILED(hr) || count != 1) {
        return defVal;
    }
    return info.nCodePage;
}

TempStr NormalizeString(Str strA, int /* NORM_FORM */ form) {
    TempWStr str = ToWStrTemp(strA);
    // ::NormalizeString is Win32 (normaliz.dll); this function is our UTF-8 wrapper
    int sizeEst = ::NormalizeString((NORM_FORM)form, str.s, str.len, nullptr, 0);
    if (sizeEst <= 0) {
        return {};
    }
    // according to MSDN the estimate may be off somewhat:
    // http://msdn.microsoft.com/en-us/library/windows/desktop/dd319093(v=vs.85).aspx
    sizeEst = sizeEst * 2;
    WCHAR* res = AllocArrayTemp<WCHAR>(sizeEst);
    sizeEst = ::NormalizeString((NORM_FORM)form, str.s, str.len, res, sizeEst);
    if (sizeEst <= 0) {
        return {};
    }
    return ToUtf8Temp(WStr(res));
}

// Get the name of default printer or nullptr if not exists.
TempStr GetDefaultPrinterNameTemp() {
    WCHAR buf[512] = {};
    DWORD bufSize = dimof(buf);
    if (GetDefaultPrinter(buf, &bufSize)) {
        return ToUtf8Temp(buf);
    }
    return {};
}

// Some 3rd-party DLLs loaded into our process (e.g. ffmpeg-based WIC codecs
// like CopyTrans HEIC, printer drivers, shell extensions) unmask floating-point
// exceptions in the per-thread FPU/MXCSR control word and don't restore it.
// We (and mupdf) rely on the default environment where FP exceptions are masked
// e.g. comparing against NaN must not trap (EXCEPTION_FLT_INVALID_OPERATION).
// Call this after code paths that might run such DLLs.
void MaskFpExceptions() {
    _clearfp();
    uint unused;
    _controlfp_s(&unused, _MCW_EM, _MCW_EM);
}

static const DWORD groupsToCheck[] = {
    DOMAIN_ALIAS_RID_USERS,
    // every user belongs to the users group, hence users come before guests
    DOMAIN_ALIAS_RID_GUESTS,
    DOMAIN_ALIAS_RID_POWER_USERS,
    DOMAIN_ALIAS_RID_ADMINS,
};

void DeferWinPosHelper::SetPos(HWND hWnd, HWND hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags) {
    if (uFlags & SWP_HIDEWINDOW) {
        NotePopupHidden(hWnd);
    }
    hdwp = ::DeferWindowPos(hdwp, hWnd, hWndInsertAfter, x, y, cx, cy, uFlags);
}

void DeferWinPosHelper::SetPos(HWND hwnd, const Rect rc) {
    uint flags = SWP_NOZORDER;
    hdwp = ::DeferWindowPos(hdwp, hwnd, nullptr, rc.x, rc.y, rc.dx, rc.dy, flags);
}

bool BlitHBITMAP(HBITMAP hbmp, HDC hdc, Rect target) {
    HDC bmpDC = CreateCompatibleDC(hdc);
    if (!bmpDC) {
        return false;
    }

    BITMAP bi{};
    GetObject(hbmp, sizeof(BITMAP), &bi);
    int dx = bi.bmWidth;
    int dy = bi.bmHeight;

    HGDIOBJ oldBmp = SelectObject(bmpDC, hbmp);
    if (!oldBmp) {
        DeleteDC(bmpDC);
        return false;
    }
    int x = target.x;
    int y = target.y;
    int tdx = target.dx;
    int tdy = target.dy;
    bool ok = false;
    // StretchBlt(HALFTONE) even at 1:1 smears scanlines; some printer drivers
    // (Xerox PCL) turn that into regular white stripes (issue #919).
    if (tdx == dx && tdy == dy) {
        ok = BitBlt(hdc, x, y, tdx, tdy, bmpDC, 0, 0, SRCCOPY) != 0;
    } else {
        if (IsPrinterDC(hdc)) {
            SetStretchBltMode(hdc, COLORONCOLOR);
        } else {
            SetStretchBltMode(hdc, HALFTONE);
            SetBrushOrgEx(hdc, 0, 0, nullptr);
        }
        ok = StretchBlt(hdc, x, y, tdx, tdy, bmpDC, 0, 0, dx, dy, SRCCOPY) != 0;
    }
    SelectObject(bmpDC, oldBmp);
    DeleteDC(bmpDC);
    return ok;
}

LARGE_INTEGER TimeNow() {
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return now;
}

void DeferWinPosHelper::MoveWindow(HWND hWnd, int x, int y, int cx, int cy, BOOL bRepaint) {
    uint uFlags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER;
    if (!bRepaint) {
        uFlags |= SWP_NOREDRAW;
    }
    SetPos(hWnd, nullptr, x, y, cx, cy, uFlags);
}

// Build id of a PE file: the CodeView PDB GUID and age (what symbol servers key
// on, new on every link), or timestamp and image size without a debug directory.
// Maps the file and touches only its headers, unlike hashing the whole exe.
static TempStr PeBuildIdFromImage(const u8* d, size_t size) {
    auto in = [&](size_t off, size_t n) { return off <= size && n <= size - off; };
    if (!in(0, sizeof(IMAGE_DOS_HEADER))) {
        return {};
    }
    auto dos = (const IMAGE_DOS_HEADER*)d;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
        return {};
    }
    size_t ntOff = (size_t)dos->e_lfanew;
    size_t fileHdrOff = ntOff + sizeof(DWORD);
    size_t optOff = fileHdrOff + sizeof(IMAGE_FILE_HEADER);
    if (!in(ntOff, sizeof(DWORD)) || *(const DWORD*)(d + ntOff) != IMAGE_NT_SIGNATURE || !in(optOff, sizeof(WORD))) {
        return {};
    }
    auto fh = (const IMAGE_FILE_HEADER*)(d + fileHdrOff);
    if (!in(optOff, fh->SizeOfOptionalHeader)) {
        return {};
    }

    const IMAGE_DATA_DIRECTORY* dirs;
    DWORD nDirs;
    DWORD sizeOfImage;
    WORD magic = *(const WORD*)(d + optOff);
    if (magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC && fh->SizeOfOptionalHeader >= sizeof(IMAGE_OPTIONAL_HEADER64)) {
        auto o = (const IMAGE_OPTIONAL_HEADER64*)(d + optOff);
        dirs = o->DataDirectory;
        nDirs = o->NumberOfRvaAndSizes;
        sizeOfImage = o->SizeOfImage;
    } else if (magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC && fh->SizeOfOptionalHeader >= sizeof(IMAGE_OPTIONAL_HEADER32)) {
        auto o = (const IMAGE_OPTIONAL_HEADER32*)(d + optOff);
        dirs = o->DataDirectory;
        nDirs = o->NumberOfRvaAndSizes;
        sizeOfImage = o->SizeOfImage;
    } else {
        return {};
    }
    TempStr res = fmt("%08x%08x", (u32)fh->TimeDateStamp, (u32)sizeOfImage);
    if (nDirs <= IMAGE_DIRECTORY_ENTRY_DEBUG) {
        return res;
    }

    // the debug directory is given as an RVA: locate its section for the file offset
    IMAGE_DATA_DIRECTORY dbg = dirs[IMAGE_DIRECTORY_ENTRY_DEBUG];
    size_t secOff = optOff + fh->SizeOfOptionalHeader;
    if (!in(secOff, (size_t)fh->NumberOfSections * sizeof(IMAGE_SECTION_HEADER))) {
        return res;
    }
    auto secs = (const IMAGE_SECTION_HEADER*)(d + secOff);
    size_t dbgOff = 0;
    for (int i = 0; i < fh->NumberOfSections; i++) {
        const IMAGE_SECTION_HEADER& s = secs[i];
        if (dbg.VirtualAddress >= s.VirtualAddress && dbg.VirtualAddress < s.VirtualAddress + s.SizeOfRawData) {
            dbgOff = (size_t)dbg.VirtualAddress - s.VirtualAddress + s.PointerToRawData;
            break;
        }
    }
    if (dbgOff == 0 || !in(dbgOff, dbg.Size)) {
        return res;
    }

    struct CvRsds {
        DWORD sig;
        GUID guid;
        DWORD age;
    };
    constexpr DWORD kRsdsSig = 0x53445352; // "RSDS"
    auto entries = (const IMAGE_DEBUG_DIRECTORY*)(d + dbgOff);
    int nEntries = (int)(dbg.Size / sizeof(IMAGE_DEBUG_DIRECTORY));
    for (int i = 0; i < nEntries; i++) {
        const IMAGE_DEBUG_DIRECTORY& e = entries[i];
        if (e.Type != IMAGE_DEBUG_TYPE_CODEVIEW || !in(e.PointerToRawData, sizeof(CvRsds))) {
            continue;
        }
        auto cv = (const CvRsds*)(d + e.PointerToRawData);
        if (cv->sig != kRsdsSig) {
            continue;
        }
        char hex[33];
        auto g = (const u8*)&cv->guid;
        for (int k = 0; k < 16; k++) {
            sprintf_s(hex + 2 * k, 3, "%02x", g[k]);
        }
        return fmt("%s%x", Str(hex), (u32)cv->age);
    }
    return res;
}

TempStr GetPeBuildIdTemp(Str path) {
    file::Mapping m;
    if (!file::MemoryMap(path, &m)) {
        return {};
    }
    TempStr res = PeBuildIdFromImage(m.data, (size_t)m.size);
    file::MemoryUnmap(&m);
    return res;
}

#endif
