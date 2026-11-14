/* Copyright 2026 the SolokPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/Win.h"
#include <imm.h>
#include "gui/Dpi.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/PlatformFont.h"
#include "gui/Gfx.h"
#include "gui/VirtCtrl.h"
#include "gui/win/WinGui.h"
#include "Settings.h"
#include "DisplayMode.h"
#include "DocProperties.h"
#include "DocController.h"
#include "EngineBase.h"
#include "DisplayModel.h"
#include "FileHistory.h"
#include "Notifications.h"
#include "MainWindow.h"
#include "WindowTab.h"
#include "Commands.h"
#include "AppSettings.h"
#include "Accelerators.h"
#include "CommandPalette.h"
#include "Canvas.h"
#include "LinkFollow.h"
#include "ReadingAutoScroll.h"
#include "SearchAndDDECommon.h"
#include "SumatraConfig.h"
#include "Tabs.h"
#include "SumatraPDF.h"
#include "VimKeys.h"
#include "SumatraLog.h"

#pragma comment(lib, "imm32.lib")

static Kind kNotifCountPrefix = "countPrefix";
static constexpr int kVimCommandHeight = 30;
static constexpr int kVimCommandInset = 8;

static PendingKeys TakePendingKeys(MainWindow* win) {
    if (!win) {
        return {};
    }

    PendingKeys keys = win->keyInput.Take();
    if (keys.count || keys.prefix) {
        RemoveNotificationsForGroup(win, kNotifCountPrefix);
    }
    return keys;
}

void ClearKeyCount(MainWindow* win) {
    TakePendingKeys(win);
}

static void ShowPendingKeys(MainWindow* win) {
    PendingKeys keys = win->keyInput.Get();
    NotificationCreateArgs args;
    args.win = win;
    args.groupId = kNotifCountPrefix;
    if (keys.count && keys.prefix) {
        args.msg = fmt("%d%c", keys.count, keys.prefix);
    } else if (keys.prefix) {
        args.msg = fmt("%c", keys.prefix);
    } else {
        args.msg = fmt("%d", keys.count);
    }
    args.corner = NotifCorner::BottomRight;
    ShowNotification(args);
}

static void SetKeyPrefix(MainWindow* win, char prefix) {
    win->keyInput.SetPrefix(prefix);
    ShowPendingKeys(win);
}

static VimMark CurrentVimMark(MainWindow* win) {
    VimMark mark;
    DisplayModel* dm = win->AsFixed();
    if (dm) {
        ScrollState state = dm->GetScrollState();
        mark.page = state.page;
        mark.x = state.x;
        mark.y = state.y;
    }
    return mark;
}

static void LoadVimMarks(MainWindow* win) {
    WindowTab* tab = win->CurrentTab();
    if (!tab || tab->vimMarksLoaded) {
        return;
    }
    tab->vimMarksLoaded = true;
    FileState* fs = FileHistoryFindByPath(tab->filePath);
    if (!fs) {
        return;
    }
    Str data = fs->vimMarks;
    if (!len(data)) {
        return;
    }
    int start = 0;
    for (int i = 0; i <= len(data); i++) {
        if (i < len(data) && data.s[i] != ';') {
            continue;
        }
        Str entry(data.s + start, i - start);
        char letter = 0;
        VimMark mark;
        if (sscanf_s(CStrTemp(entry), "%c,%d,%lf,%lf", &letter, 1, &mark.page, &mark.x, &mark.y) == 4 &&
            letter >= 'a' && letter <= 'z') {
            tab->vimMarks[letter - 'a'] = mark;
        }
        start = i + 1;
    }
}

static void SaveVimMarks(MainWindow* win) {
    WindowTab* tab = win->CurrentTab();
    FileState* fs = tab ? FileHistoryFindByPath(tab->filePath) : nullptr;
    if (!fs) {
        return;
    }
    str::Builder out;
    for (int i = 0; i < kVimMarkCount; i++) {
        VimMark mark = tab->vimMarks[i];
        if (!mark.page) {
            continue;
        }
        if (len(out)) {
            out.Append(StrL(";"));
        }
        out.Append(fmt("%c,%d,%.15g,%.15g", (char)('a' + i), mark.page, mark.x, mark.y));
    }
    str::ReplaceWithCopy(&fs->vimMarks, ToStrTemp(out));
    ScheduleSaveSettings();
}

static void VimGoPage(MainWindow* win, int page) {
    if (!win->ctrl || page < 1 || page > win->ctrl->PageCount()) {
        return;
    }
    WindowTab* tab = win->CurrentTab();
    if (tab) {
        tab->vimJumpBack = CurrentVimMark(win);
    }
    win->ctrl->GoToPage(page, true);
}

static void VimJumpMark(MainWindow* win, VimMark mark) {
    DisplayModel* dm = win->AsFixed();
    WindowTab* tab = win->CurrentTab();
    if (!dm || !tab || !mark.page || !dm->ValidPageNo(mark.page)) {
        return;
    }
    VimMark before = CurrentVimMark(win);
    dm->AddNavPoint();
    dm->SetScrollState(ScrollState(mark.page, mark.x, mark.y));
    tab->vimJumpBack = before;
}

static void VimAlignPage(MainWindow* win, char align) {
    DisplayModel* dm = win->AsFixed();
    if (!dm || !IsContinuous(dm->GetDisplayMode())) {
        return;
    }

    Rect view = dm->GetViewPort();
    int page = win->ctrl->CurrentPageNo();
    if (align == 'z') {
        int centered = dm->GetPageNoByPoint(Point(view.dx / 2, view.dy / 2));
        if (dm->ValidPageNo(centered)) {
            page = centered;
        }
    }
    PageInfo* info = dm->GetPageInfo(page);
    if (!info) {
        return;
    }

    int y = info->pos.y;
    if (align == 'z') {
        y += (info->pos.dy - view.dy) / 2;
    } else if (align == 'b') {
        y += info->pos.dy - view.dy;
    }
    dm->ScrollYTo(y);
}

static void VimCopyPageText(MainWindow* win, int count) {
    DisplayModel* dm = win->AsFixed();
    if (!dm || !HasPermission(Perm::CopySelection) ||
        (!gDisableDocumentRestrictions && !dm->GetEngine()->allowsCopyingText)) {
        return;
    }

    int page = win->ctrl->CurrentPageNo();
    int last = std::min(dm->PageCount(), page + (count ? count : 1) - 1);
    str::Builder text;
    for (int i = page; i <= last; i++) {
        if (i > page) {
            text.Append(StrL("\r\n"));
        }
        text.Append(dm->GetEngine()->GetTextForPage(i));
    }
    if (!len(text) || !CopyTextToClipboard(ToStrTemp(text))) {
        return;
    }

    ShowTemporaryNotification(
        win, page == last ? fmt("Copied page %d text", page) : fmt("Copied pages %d-%d text", page, last));
}

static void CloseVimCommand(MainWindow* win) {
    HWND edit = win->vimCmdEdit;
    win->vimCmdEdit = nullptr;
    win->vimCmdComposing = false;
    if (edit) {
        DestroyWindow(edit);
    }
    if (IsWindow(win->hwndFrame)) {
        HwndSetFocus(win->hwndFrame);
    }
}

static void RunVimCommand(MainWindow* win, Str input) {
    str::TrimWs(input);
    str::TrimPrefix(input, StrL(":"));
    str::TrimWs(input);
    if (!len(input)) {
        return;
    }

    VecAppend(win->vimCmdHistory, str::Dup(input));
    win->vimCmdHistoryPos = len(win->vimCmdHistory);
    bool digits = true;
    for (int i = 0; i < len(input); i++) {
        if (!str::IsDigit(input.s[i])) {
            digits = false;
            break;
        }
    }
    if (digits) {
        VimGoPage(win, ParseInt(input));
    } else if (str::Eq(input, StrL("q"))) {
        HwndSendCommand(win->hwndFrame, CmdClose);
    } else if (str::Eq(input, StrL("qa"))) {
        HwndSendCommand(win->hwndFrame, CmdExit);
    } else if (str::Eq(input, StrL("w"))) {
        HwndSendCommand(win->hwndFrame, CmdSaveAs);
    } else if (str::Eq(input, StrL("tabn"))) {
        HwndSendCommand(win->hwndFrame, CmdNextTab);
    } else if (str::Eq(input, StrL("tabp"))) {
        HwndSendCommand(win->hwndFrame, CmdPrevTab);
    } else if (str::Eq(input, StrL("set vim"))) {
        if (!gSettings->vimKeys) {
            HwndSendCommand(win->hwndFrame, CmdToggleVimKeys);
        }
    } else if (str::Eq(input, StrL("set novim"))) {
        if (gSettings->vimKeys) {
            HwndSendCommand(win->hwndFrame, CmdToggleVimKeys);
        }
    } else {
        RunCommandPalette(win, input, 0);
    }
}

static LRESULT CALLBACK VimCommandProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR, DWORD_PTR ref) {
    auto* win = (MainWindow*)ref;
    if (HandleTestEditClipboard(hwnd, msg)) {
        return 0;
    }
    if (msg == WM_IME_STARTCOMPOSITION) {
        win->vimCmdComposing = true;
    } else if (msg == WM_IME_ENDCOMPOSITION) {
        win->vimCmdComposing = false;
    }
    if (msg == WM_KEYDOWN) {
        if (wp == VK_ESCAPE && !win->vimCmdComposing) {
            CloseVimCommand(win);
            return 0;
        }
        if (wp == VK_RETURN && !win->vimCmdComposing) {
            int n = GetWindowTextLengthW(hwnd);
            WCHAR* buf = AllocArrayTemp<WCHAR>(n + 1);
            GetWindowTextW(hwnd, buf, n + 1);
            TempStr input = ToUtf8Temp(WStr(buf, n));
            CloseVimCommand(win);
            RunVimCommand(win, input);
            return 0;
        }
        if ((wp == VK_UP || wp == VK_DOWN) && !win->vimCmdComposing) {
            int n = len(win->vimCmdHistory);
            if (wp == VK_UP && win->vimCmdHistoryPos > 0) {
                win->vimCmdHistoryPos--;
            } else if (wp == VK_DOWN && win->vimCmdHistoryPos < n) {
                win->vimCmdHistoryPos++;
            }
            Str text = win->vimCmdHistoryPos < n ? fmt(":%s", win->vimCmdHistory[win->vimCmdHistoryPos]) : StrL(":");
            HwndSetText(hwnd, text);
            SendMessageW(hwnd, EM_SETSEL, (WPARAM)-1, (LPARAM)-1);
            return 0;
        }
    }
    if (msg == WM_KILLFOCUS && win->vimCmdEdit == hwnd) {
        win->vimCmdEdit = nullptr;
        win->vimCmdComposing = false;
        DestroyWindow(hwnd);
        return 0;
    }
    return DefSubclassProc(hwnd, msg, wp, lp);
}

static void OpenVimCommand(MainWindow* win) {
    if (win->vimCmdEdit) {
        return;
    }
    Rect rc = HwndClientRect(win->hwndFrame);
    int height = DpiScale(kVimCommandHeight);
    int inset = DpiScale(kVimCommandInset);
    HWND edit = CreateWindowExW(0, L"EDIT", L":", WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL, inset,
                                rc.dy - height - inset, rc.dx - 2 * inset, height, win->hwndFrame, nullptr,
                                GetModuleHandleW(nullptr), nullptr);
    if (!edit) {
        return;
    }
    win->vimCmdEdit = edit;
    win->vimCmdComposing = false;
    win->vimCmdHistoryPos = len(win->vimCmdHistory);
    SendMessageW(edit, WM_SETFONT, (WPARAM)GetStockObject(DEFAULT_GUI_FONT), TRUE);
    SetWindowSubclass(edit, VimCommandProc, 0, (DWORD_PTR)win);
    HwndSetFocus(edit);
    SendMessageW(edit, EM_SETSEL, (WPARAM)-1, (LPARAM)-1);
}

int TakeVimKeyCount(MainWindow* win, int cmdId) {
    int count = win->keyInput.Get().count;
    if (!count) {
        return 1;
    }
    count = TakePendingKeys(win).count;
    bool repeatable = cmdId == CmdScrollUp || cmdId == CmdScrollDown || cmdId == CmdScrollUpHalfPage ||
                      cmdId == CmdScrollDownHalfPage || cmdId == CmdScrollUpPage || cmdId == CmdScrollDownPage ||
                      cmdId == CmdGoToPrevPage || cmdId == CmdGoToNextPage || cmdId == CmdScrollLeft ||
                      cmdId == CmdScrollRight || cmdId == CmdVimScrollDownLine || cmdId == CmdVimScrollUpLine;
    return repeatable ? count : 1;
}

void RunVimKeyCommand(MainWindow* win, int cmdId) {
    if (cmdId == CmdToggleVimKeys) {
        ToggleSettingsBool(&gSettings->vimKeys);
        ClearKeyCount(win);
        NotificationCreateArgs args;
        args.win = win;
        args.msg = gSettings->vimKeys ? StrL("Vim Key Mode: On") : StrL("Vim Key Mode: Off");
        ShowNotification(args);
        return;
    }
    if (cmdId == CmdVimPrefixG || cmdId == CmdVimSetMark || cmdId == CmdVimJumpMark) {
        if (gSettings->vimKeys) {
            SetKeyPrefix(win, cmdId == CmdVimPrefixG ? 'g' : cmdId == CmdVimSetMark ? 'm' : '\'');
        }
        return;
    }
    if (cmdId == CmdVimCommandLine) {
        if (gSettings->vimKeys) {
            OpenVimCommand(win);
        }
        return;
    }
    if (gSettings->vimKeys && win->IsDocLoaded()) {
        CanvasScrollByKey(win, cmdId == CmdVimScrollDownLine ? SB_LINEDOWN : SB_LINEUP, 1);
    }
}

void ResizeVimCommand(MainWindow* win) {
    if (!win->vimCmdEdit) {
        return;
    }
    Rect rc = HwndClientRect(win->hwndFrame);
    int height = DpiScale(kVimCommandHeight);
    int inset = DpiScale(kVimCommandInset);
    SetWindowPos(win->vimCmdEdit, HWND_TOP, inset, rc.dy - height - inset, rc.dx - 2 * inset, height, SWP_NOACTIVATE);
}

static bool HasUserKey(int vk, bool shift, bool ctrl) {
    KeyShortcut key(
        (u8)(KeyShortcut::kVirtKey | (shift ? KeyShortcut::kShiftKey : 0) | (ctrl ? KeyShortcut::kCtrlKey : 0)),
        (u16)vk);
    return HasCustomShortcut(key);
}

constexpr int kVimShift = 1;
constexpr int kVimCtrl = 2;
constexpr uint kNoDeadKeyChange = 4;

static int VimKeyChar(MSG& msg, int mods, HKL layout) {
    BYTE state[256]{};
    GetKeyboardState(state);
    state[VK_SHIFT] = (mods & kVimShift) ? 0x80 : 0;
    state[VK_CONTROL] = 0;
    WCHAR chars[4]{};
    int vk = (int)msg.wParam;
    uint scan = (uint)((msg.lParam >> 16) & 0xff);
    if (!scan) {
        scan = MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, layout);
    }
    int n = ToUnicodeEx(vk, scan, state, chars, dimof(chars), kNoDeadKeyChange, layout);
    return n == 1 ? chars[0] : 0;
}

static bool VimHintCapturesKey(MainWindow* win, MSG& msg, HKL layout) {
    if (KeyboardLinkFollowingCapturesKey(win, (int)msg.wParam)) {
        return true;
    }
    return win && win->vimLinkHints && KeyboardLinkFollowingActive(win) && VimKeyChar(msg, 0, layout) == ';';
}

static bool HasUserChar(int ch) {
    if (!ch) {
        return false;
    }
    KeyShortcut key(0, (u16)ch);
    return HasCustomShortcut(key);
}

static bool IsDocKeyInput(MainWindow* win, MSG& msg) {
    return msg.message == WM_KEYDOWN && win && win->IsDocLoaded() && IsDocKeyTarget(win, msg.hwnd) &&
           IsDocKeyTarget(win, GetFocus());
}

// Shift, Ctrl and Win send keydowns of their own before the key they modify
static bool IsModifierVk(WPARAM vk) {
    switch (vk) {
        case VK_SHIFT:
        case VK_CONTROL:
        case VK_LSHIFT:
        case VK_RSHIFT:
        case VK_LCONTROL:
        case VK_RCONTROL:
        case VK_LWIN:
        case VK_RWIN:
            return true;
    }
    return false;
}

static bool HandleVimKey(MainWindow* win, MSG& msg, int mods, HKL layout) {
    if (!gSettings->vimKeys || !IsDocKeyInput(win, msg) || IsModifierVk(msg.wParam)) {
        return false;
    }

    int vk = (int)msg.wParam;
    bool ctrl = (mods & kVimCtrl) != 0;
    bool shift = (mods & kVimShift) != 0;
    if (ctrl) {
        if (HasUserKey(vk, shift, true)) {
            ClearKeyCount(win);
            return false;
        }
        if (vk == 'D' || vk == 'U' || vk == 'F' || vk == 'B') {
            return false;
        }
        if (vk == VK_TAB && ((msg.lParam >> 16) & 0xff) == MapVirtualKeyW('I', MAPVK_VK_TO_VSC)) {
            ClearKeyCount(win);
            HwndSendCommand(win->hwndFrame, CmdNavigateForward);
            return true;
        }
        int line = vk == 'E' ? SB_LINEDOWN : vk == 'Y' ? SB_LINEUP : 0;
        int count = TakePendingKeys(win).count;
        if (!line) {
            return false;
        }
        CanvasScrollByKey(win, line, count ? count : 1);
        return true;
    }
    int ch = VimKeyChar(msg, mods, layout);
    if (HasUserKey(vk, shift, false) || HasUserChar(ch)) {
        ClearKeyCount(win);
        return false;
    }

    PendingKeys pending = win->keyInput.Get();
    int count = pending.count;
    char prefix = pending.prefix;
    if (prefix) {
        PendingKeys keys = TakePendingKeys(win);
        count = keys.count;
        prefix = keys.prefix;
        if (prefix == 'z' && (ch == 'z' || ch == 't' || ch == 'b')) {
            VimAlignPage(win, (char)ch);
            return true;
        }
        if (prefix == 'y' && ch == 'y') {
            VimCopyPageText(win, count);
            return true;
        }
        if (prefix == 'g' && !shift && vk == 'G') {
            VimGoPage(win, count ? count : 1);
            return true;
        }
        if (prefix == 'g' && vk == 'T') {
            if (count && !shift && count <= win->TabCount()) {
                TabsSelect(win, count - 1);
            } else {
                HwndSendCommand(win->hwndFrame, shift ? CmdPrevTab : CmdNextTab);
            }
            return true;
        }
        if (prefix == 'm' && !shift && vk >= 'A' && vk <= 'Z') {
            LoadVimMarks(win);
            win->CurrentTab()->vimMarks[vk - 'A'] = CurrentVimMark(win);
            SaveVimMarks(win);
            return true;
        }
        if (prefix == '\'' || prefix == '`') {
            if (ch == prefix) {
                VimJumpMark(win, win->CurrentTab()->vimJumpBack);
                return true;
            }
            if (!shift && vk >= 'A' && vk <= 'Z') {
                LoadVimMarks(win);
                VimJumpMark(win, win->CurrentTab()->vimMarks[vk - 'A']);
                return true;
            }
        }
        return true;
    }

    if (shift && vk == 'G') {
        count = TakePendingKeys(win).count;
        VimGoPage(win, count ? count : win->ctrl->PageCount());
        return true;
    }
    if (vk == 'G' || (!shift && vk == 'M') || ch == '\'' || ch == '`' || ch == 'z' || ch == 'y') {
        SetKeyPrefix(win, vk == 'G' ? 'g' : vk == 'M' ? 'm' : (char)ch);
        return true;
    }
    if (vk == 'N') {
        ClearKeyCount(win);
        if (!HasFindText(win)) {
            MaybeDelayedWarningNotification(StrL("No previous search"));
            return true;
        }
        win->CurrentTab()->vimJumpBack = CurrentVimMark(win);
        HwndSendCommand(win->hwndFrame, shift ? CmdFindPrev : CmdFindNext);
        return true;
    }
    if (vk == 'F' && !shift) {
        ClearKeyCount(win);
        win->vimLinkHints = !win->linkFollowActive;
        ToggleKeyboardLinkFollowing(win);
        return true;
    }
    if (ch == ':') {
        ClearKeyCount(win);
        OpenVimCommand(win);
        return true;
    }
    if (ch == '/') {
        ClearKeyCount(win);
        HwndSendCommand(win->hwndFrame, CmdFindFirst);
        return true;
    }
    if (ch == '?') {
        ClearKeyCount(win);
        HwndSendCommand(win->hwndFrame, CmdToggleKeyboardHelp);
        return true;
    }
    return false;
}

static HWND gTestImeEdit = nullptr;
static bool gTestImeWasOpen = false;

static TempStr TestImeTemp(MainWindow* win, Str action, int* exitCode) {
    if (!gForTesting) {
        *exitCode = 1;
        return StrL("ERROR testing-required");
    }
    if (str::Eq(action, StrL("ime-start")) && gTestImeEdit && IsWindow(gTestImeEdit)) {
        *exitCode = 1;
        return StrL("ERROR ime-test-active");
    }
    HWND edit = str::Eq(action, StrL("ime-start")) ? GetFocus() : gTestImeEdit;
    HWND findEdit = win->findEdit ? CbEditHwnd(win->findEdit->hwnd) : nullptr;
    if (!edit || (edit != win->vimCmdEdit && edit != findEdit) || !IsWindow(edit)) {
        *exitCode = 1;
        return StrL("ERROR no-focused-edit");
    }
    HKL layout = GetKeyboardLayout(0);
    HIMC context = ImmGetContext(edit);
    if (!context || LOWORD((uintptr_t)layout) != MAKELANGID(LANG_JAPANESE, SUBLANG_DEFAULT) || !ImmIsIME(layout) ||
        !(ImmGetProperty(layout, IGP_SETCOMPSTR) & SCS_CAP_COMPSTR)) {
        if (context) {
            ImmReleaseContext(edit, context);
        }
        *exitCode = 2;
        return StrL("UNAVAILABLE no-japanese-ime");
    }
    bool ok = true;
    if (str::Eq(action, StrL("ime-start"))) {
        gTestImeEdit = edit;
        gTestImeWasOpen = ImmGetOpenStatus(context) != 0;
        ok = ImmSetOpenStatus(context, TRUE) != 0;
        WStr text = WStrL(L"かな");
        ok = ok && ImmSetCompositionStringW(context, SCS_SETSTR, text.s, len(text) * sizeof(WCHAR), nullptr, 0);
        if (!ok) {
            ImmSetOpenStatus(context, gTestImeWasOpen);
            gTestImeEdit = nullptr;
        }
    } else if (str::Eq(action, StrL("ime-commit"))) {
        ok = ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_COMPLETE, 0) != 0;
    } else if (str::Eq(action, StrL("ime-cancel"))) {
        ok = ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0) != 0;
    } else if (str::Eq(action, StrL("ime-close"))) {
        ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
        ok = ImmSetOpenStatus(context, gTestImeWasOpen) != 0;
        gTestImeEdit = nullptr;
    } else if (!str::Eq(action, StrL("ime-state"))) {
        ok = false;
    }
    WCHAR buf[128]{};
    LONG size = ImmGetCompositionStringW(context, GCS_COMPSTR, buf, sizeof(buf));
    TempStr composition = size > 0 ? ToUtf8Temp(WStr(buf, size / sizeof(WCHAR))) : StrL("");
    int composing = win->vimCmdComposing ? 1 : 0;
    ImmReleaseContext(edit, context);
    *exitCode = ok ? 0 : 1;
    return fmt("ok=%d composing=%d bytes=%d text=%s", ok ? 1 : 0, composing, (int)size, composition);
}

TempStr VimKeysTestResultTemp(Str action, Str key, int* exitCode) {
    if (len(gWindows) == 0 || !gWindows[0]) {
        *exitCode = 2;
        return StrL("NOTREADY no-window");
    }
    MainWindow* win = gWindows[0];
    if (str::StartsWith(action, StrL("ime-"))) {
        return TestImeTemp(win, action, exitCode);
    }
    if (str::Eq(action, StrL("jis-hint"))) {
        HKL layout = LoadKeyboardLayoutW(L"00000411", KLF_NOTELLSHELL);
        if (!layout || !str::Eq(key, StrL(";"))) {
            *exitCode = 1;
            return StrL("ERROR no-jis-semicolon");
        }
        SHORT mapped = VkKeyScanExW(L';', layout);
        MSG msg{};
        msg.hwnd = win->hwndFrame;
        msg.message = WM_KEYDOWN;
        msg.wParam = mapped & 0xff;
        msg.lParam = (LPARAM)MapVirtualKeyExW((uint)msg.wParam, MAPVK_VK_TO_VSC, layout) << 16;
        *exitCode = 0;
        return fmt("capture=%d", VimHintCapturesKey(win, msg, layout) ? 1 : 0);
    }
    if (str::Eq(action, StrL("key")) || str::Eq(action, StrL("jis"))) {
        HKL layout = GetKeyboardLayout(0);
        if (str::Eq(action, StrL("jis"))) {
            layout = LoadKeyboardLayoutW(L"00000411", KLF_NOTELLSHELL);
            if (!layout) {
                *exitCode = 1;
                return StrL("ERROR no-jis-layout");
            }
        }
        int mods = 0;
        if (str::TrimPrefix(key, StrL("Ctrl+"))) {
            mods |= kVimCtrl;
        }
        if (str::TrimPrefix(key, StrL("Shift+"))) {
            mods |= kVimShift;
        }
        int vk = 0;
        if (len(key) == 1 && key.s[0] >= 'A' && key.s[0] <= 'Z') {
            vk = key.s[0];
        } else if (len(key) == 1) {
            SHORT mapped = VkKeyScanExW((WCHAR)key.s[0], layout);
            if (mapped != -1) {
                vk = mapped & 0xff;
                mods |= (mapped & 0x100) ? kVimShift : 0;
                mods |= (mapped & 0x200) ? kVimCtrl : 0;
            }
        }
        if (!vk) {
            *exitCode = 1;
            return StrL("ERROR unknown-key");
        }
        HwndSetFocus(win->hwndFrame);
        MSG msg{};
        msg.hwnd = win->hwndFrame;
        msg.message = WM_KEYDOWN;
        msg.wParam = vk;
        msg.lParam = (LPARAM)MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, layout) << 16;
        if (!HandleVimKey(win, msg, mods, layout)) {
            int n = 0;
            const Accel* accels = GetAcceleratorTable(n);
            u8 flags = KeyShortcut::kVirtKey | ((mods & kVimShift) ? KeyShortcut::kShiftKey : 0) |
                       ((mods & kVimCtrl) ? KeyShortcut::kCtrlKey : 0);
            KeyShortcut shortcut(flags, (u16)vk);
            for (int i = 0; i < n; i++) {
                if (accels[i].sc.SameKey(shortcut)) {
                    HwndSendCommand(win->hwndFrame, accels[i].cmd);
                    break;
                }
            }
        }
    } else if (!str::Eq(action, StrL("state"))) {
        *exitCode = 1;
        return StrL("ERROR unknown-action");
    }
    *exitCode = 0;
    int page = win->ctrl ? win->ctrl->CurrentPageNo() : 0;
    PendingKeys keys = win->keyInput.Get();
    return fmt("mode=%d page=%d focus=%d count=%d prefix=%c hints=%d edit=%lld", gSettings->vimKeys ? 1 : 0, page,
               IsDocKeyTarget(win, GetFocus()) ? 1 : 0, keys.count, keys.prefix ? keys.prefix : '-',
               win->linkFollowActive ? 1 : 0, (i64)win->vimCmdEdit);
}

bool VimKeysPreTranslate(MainWindow* countWin, MSG& msg) {
    PendingKeys pending = countWin ? countWin->keyInput.Get() : PendingKeys{};
    if (countWin && (pending.count || pending.prefix) &&
        (msg.message == WM_LBUTTONDOWN || msg.message == WM_RBUTTONDOWN || msg.message == WM_MBUTTONDOWN ||
         (msg.message == WM_KEYDOWN && msg.wParam == VK_ESCAPE) ||
         (msg.message == WM_KEYDOWN && !IsDocKeyTarget(countWin, msg.hwnd)))) {
        ClearKeyCount(countWin);
    }
    if (countWin && countWin->vimLinkHints && msg.message == WM_KEYDOWN && !IsCtrlPressed() && !IsAltPressed() &&
        !IsShiftPressed() && msg.wParam != VK_ESCAPE && !VimHintCapturesKey(countWin, msg, GetKeyboardLayout(0))) {
        StopKeyboardLinkFollowing(countWin);
        return true;
    }
    if (IsDocKeyInput(countWin, msg) && !countWin->keyInput.Get().prefix && msg.wParam >= '0' && msg.wParam <= '9' &&
        !IsCtrlPressed() && !IsAltPressed() && !IsShiftPressed() && !ReadingAutoScrollAcceptsKeys(countWin)) {
        if (!HasDigitShortcut((u16)msg.wParam) && countWin->keyInput.AddDigit((int)msg.wParam)) {
            ShowPendingKeys(countWin);
            return true;
        }
    }

    if (!IsAltPressed() &&
        HandleVimKey(countWin, msg, (IsShiftPressed() ? kVimShift : 0) | (IsCtrlPressed() ? kVimCtrl : 0),
                     GetKeyboardLayout(0))) {
        return true;
    }

    return false;
}

void VimKeysUntranslated(MainWindow* win, MSG& msg) {
    if (win && msg.message == WM_KEYDOWN && !IsModifierVk(msg.wParam)) {
        ClearKeyCount(win);
    }
}

bool VimLinkHintsCapture(MSG& msg) {
    // Vimium-style link hints: letter keys type the hint, so skip letter
    // accelerators ('a' = highlight, 'n' = next page, …). Ctrl/Alt/Shift
    // shortcuts still work (Shift+F toggles the mode off). Issue #6019.
    if (msg.message == WM_KEYDOWN && !IsCtrlPressed() && !IsAltPressed() && !IsShiftPressed()) {
        if (VimHintCapturesKey(FindMainWindowByHwnd(msg.hwnd), msg, GetKeyboardLayout(0))) {
            return true;
        }
    }

    return false;
}
