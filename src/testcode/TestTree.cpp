#include "base/Base.h"
#include "base/Win.h"
#include "gui/Dpi.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "gui/PlatformFont.h"
#include "gui/Gfx.h"
#include "gui/VirtHost.h"
#include "gui/win/VirtTreeState.h"
#include "gui/win/VirtTreeMetrics.h"
#include "OverlayScrollbar.h"
#include "TreeUia.h"
#include "VirtTree.h"

static constexpr int kTreeRoots = 4000;
static constexpr int kTreeFirstItem = 10;
static constexpr int kTreeChildren = 2;
static constexpr int kTreeGroup = kTreeChildren + 1;

struct TestTreeModel : TreeModel {
    int rootCount = kTreeRoots;
    TreeItem Root() override { return 1; }
    Str Text(TreeItem item) override {
        if (item == 11) {
            return StrL(
                "Item 11: a nested title that is longer than every root item so collapsing it reduces the "
                "horizontal range and expanding it restores that range");
        }
        if (item == 13) {
            return StrL("Item 13: a much longer title than the final item, used to check the horizontal scroll extent");
        }
        return fmt("Item %d: a long title for horizontal scrolling and scrollbar testing", (int)item);
    }
    TreeItem Parent(TreeItem item) override {
        int offset = (int)item - kTreeFirstItem;
        return offset % kTreeGroup == 0 ? Root() : item - offset % kTreeGroup;
    }
    int ChildCount(TreeItem item) override {
        if (item == Root()) {
            return rootCount;
        }
        return ((int)item - kTreeFirstItem) % kTreeGroup == 0 ? kTreeChildren : 0;
    }
    TreeItem ChildAt(TreeItem item, int idx) override {
        return item == Root() ? kTreeFirstItem + idx * kTreeGroup : item + idx + 1;
    }
    bool IsExpanded(TreeItem) override { return false; }
    void SetUserData(TreeItem, uintptr_t) override {}
    uintptr_t GetUserData(TreeItem) override { return 0; }
};

struct TestTreeWindow : WindowBase, VirtTree {
    TestTreeModel model;
    int selectionCount = 0;
    int selectionAction = 0;
    int nestedMessages = 0;
    int fontAction = 0;
    int styleAction = 0;
    int expandAction = 0;
    int scrollAction = 0;
    bool testFocusOutline = false;
    VirtHost* probeHost = nullptr;
    VirtTreeSelectReason lastReason = VirtTreeSelectReason::Programmatic;

    void LayoutHost(WindowBase::SizeEvent* ev);
    void Moved(WindowBase::MoveEvent* ev);
    void DpiChanged(WindowBase::DpiChangedEvent* ev);
    void Destroyed(WindowBase::DestroyEvent* ev);
    void TestMessage(VirtHostNativeMsg* ev);
    void SelectionChanged(VirtTreeSelectionChanged* ev);
    void ProbeMessage(VirtHostNativeMsg* ev);
    void QueryFont(VirtTreeFontQuery*);
    void QueryStyle(VirtTreeStyle*);
    void TestExpand(VirtTreeExpandEvent*);
    void TestScroll();
#if IS_DEBUG
    void DeleteOnScrollEvent();
#endif
};

#if IS_DEBUG
void TestTreeWindow::DeleteOnScrollEvent() {
    delete this;
}
#endif

static HWINEVENTHOOK gTreeTestHook = nullptr;
static TestTreeWindow* gTreeTestTarget = nullptr;
static bool gTreeTestDelete = false;
static bool gTreeTestHideBars = false;

static void CALLBACK TreeTestWinEvent(HWINEVENTHOOK hook, DWORD, HWND, LONG, LONG, DWORD, DWORD) {
    UnhookWinEvent(hook);
    gTreeTestHook = nullptr;
    TestTreeWindow* target = gTreeTestTarget;
    gTreeTestTarget = nullptr;
    if (gTreeTestDelete)
        delete target;
    else if (gTreeTestHideBars)
        target->SetMode(VirtTreeBarMode::Hidden);
    else
        target->SetModel(&target->model);
}

void TestTreeWindow::TestExpand(VirtTreeExpandEvent* ev) {
    int action = expandAction;
    expandAction = 0;
    if (action == 1) return SetModel(&model);
    if (action == 2) return delete this;
    ExpandItem(ev->item, ev->expansion, ev->reason);
}

void TestTreeWindow::TestScroll() {
    int action = scrollAction;
    scrollAction = 0;
    if (action == 1) return SetModel(&model);
    if (action == 2) return delete this;
    RefreshScroll();
}

void TestTreeWindow::QueryFont(VirtTreeFontQuery*) {
    int action = fontAction;
    fontAction = 0;
    if (action == 1) SetModel(&model);
    if (action == 2) delete this;
}

void TestTreeWindow::QueryStyle(VirtTreeStyle* style) {
    style->focusOutline = testFocusOutline && style->selected && style->focused;
    if (!styleAction) return;
    int action = styleAction;
    styleAction = 0;
    if (action == 2) {
        delete this;
        return;
    }
    ExpandItem(kTreeFirstItem, VirtTreeExpansion::Collapse);
}

void TestTreeWindow::ProbeMessage(VirtHostNativeMsg* ev) {
    if (ev->msg == WM_APP + 111) {
        nestedMessages++;
    } else if (ev->msg == WM_APP + 110) {
        HWND probe = probeHost->native;
        VirtHost* doomed = probeHost;
        probeHost = nullptr;
        if (ev->wp)
            doomed->Dispose();
        else
            delete doomed;
        SendMessageW(probe, WM_APP + 111, 0, 0);
    } else {
        return;
    }
    ev->didHandle = true;
}

void TestTreeWindow::SelectionChanged(VirtTreeSelectionChanged* ev) {
    selectionCount++;
    lastReason = ev->reason;
    int action = selectionAction;
    selectionAction = 0;
    if (action == 1) SetModel(&model);
    if (action == 2) DestroyWindow(Hwnd());
    if (action == 3) delete this;
}

void TestTreeWindow::TestMessage(VirtHostNativeMsg* ev) {
    if (ev->msg == WM_APP + 101) {
        auto info = TestInfo();
        switch (ev->wp) {
            case 0:
                ev->res = (int)GetMode();
                break;
            case 1:
                ev->res = info.scrollX;
                break;
            case 2:
                ev->res = info.scrollY;
                break;
            case 3:
                ev->res = info.maxX;
                break;
            case 4:
                ev->res = info.maxY;
                break;
            case 5:
                ev->res = info.rowCount;
                break;
            case 6:
                ev->res = (LRESULT)info.barY;
                break;
            case 7:
                SetModel(&model);
                ev->res = (LRESULT)TestInfo().generation;
                break;
            case 8:
                ev->res = (LRESULT)info.barX;
                break;
            case 9:
                ev->res = (LRESULT)GetSelection();
                break;
            case 10: {
                gDpiOverride = (int)ev->lp;
                RECT rc{};
                GetWindowRect(hwnd, &rc);
                WindowBase::DpiChangedEvent dpi;
                dpi.w = this;
                dpi.dpiX = dpi.dpiY = DpiGetForHwnd(hwnd);
                dpi.suggested = &rc;
                DpiChanged(&dpi);
                break;
            }
            case 11:
                ev->res = ItemHeight();
                break;
            case 12:
                ev->res = info.contentWidth;
                break;
            case 13:
                ev->res = PlatformFontMeasureText(VirtTree::GetFont(), model.Text(13)).dx + ItemHeight();
                break;
            case 14:
                ev->res = info.viewportHeight;
                break;
            case 15:
                DestroyWindow(Hwnd());
                break;
            case 16:
                ev->res = (int)lastReason;
                break;
            case 17:
                ev->res = selectionCount;
                break;
            case 18:
                ev->res = SelectItem((TreeItem)ev->lp);
                break;
            case 19:
                ev->res = EnsureVisible((TreeItem)ev->lp);
                break;
            case 20:
                selectionAction = (int)ev->lp;
                break;
            case 22: {
                ExpandItem((TreeItem)ev->lp, VirtTreeExpansion::Collapse);
                break;
            }
            case 23: {
                nestedMessages = 0;
                VirtHost::CreateArgs args;
                args.parent = hwnd;
                args.className = WStrL(L"SumatraTreeDisposeProbe");
                probeHost = VirtHost::Create(args);
                if (!probeHost) {
                    ev->res = -1;
                    break;
                }
                probeHost->onNativeMsg =
                    MkMethod1<TestTreeWindow, VirtHostNativeMsg*, &TestTreeWindow::ProbeMessage>(this);
                SendMessageW(probeHost->native, WM_APP + 110, ev->lp, 0);
                ev->res = nestedMessages;
                break;
            }
            case 24: {
                model.rootCount = 1;
                SetModel(&model);
                ExpandItem(kTreeFirstItem, VirtTreeExpansion::Expand);
                break;
            }
            case 25:
                fontAction = (int)ev->lp;
                break;
            case 26:
                ev->res = TestMeasure();
                break;
            case 27:
                styleAction = ev->lp ? (int)ev->lp : 1;
                Repaint();
                break;
            case 28:
                model.rootCount = kTreeRoots;
                SetModel(&model);
                break;
            case 29:
                testFocusOutline = ev->lp != 0;
                SetActiveWindow(hwnd);
                ::SetFocus(ev->lp == 2 ? hwnd : Hwnd());
                Repaint();
                ev->res = ::GetFocus() == (ev->lp == 2 ? hwnd : Hwnd());
                break;
            case 30:
                expandAction = (int)ev->lp;
                break;
            case 31:
                scrollAction = (int)ev->lp;
                break;
            case 32:
                gTreeTestTarget = this;
                gTreeTestDelete = (ev->lp & 0x10000) != 0;
                gTreeTestHideBars = (ev->lp & 0x20000) != 0;
                gTreeTestHook =
                    SetWinEventHook((DWORD)ev->lp & 0xffff, (DWORD)ev->lp & 0xffff, GetModuleHandleW(nullptr),
                                    TreeTestWinEvent, GetCurrentProcessId(), GetCurrentThreadId(), WINEVENT_INCONTEXT);
                ev->res = gTreeTestHook != nullptr;
                break;
            case 33:
                ev->res = gTreeTestHook == nullptr;
                break;
#if IS_DEBUG
            case 34: {
                TestScrollEvent(MkMethod0<TestTreeWindow, &TestTreeWindow::DeleteOnScrollEvent>(this));
                break;
            }
#endif
            case 35:
                SetAccessibleName(StrL("Changed name"));
                break;
            default:
                ev->res = -1;
        }
    } else if (ev->msg == WM_KEYDOWN && ev->wp >= '1' && ev->wp <= '4') {
        SetMode((VirtTreeBarMode)(ev->wp - '1'));
    } else if (ev->msg == WM_KEYDOWN && ev->wp == 'R') {
        SetDirection(GetDirection() == TreeDirection::LeftToRight ? TreeDirection::RightToLeft
                                                                  : TreeDirection::LeftToRight);

    } else {
        return;
    }
    ev->didHandle = true;
}

void TestTreeWindow::Destroyed(WindowBase::DestroyEvent*) {
    ScheduleDelete();
}

void TestTreeWindow::Moved(WindowBase::MoveEvent*) {
    UpdateScrollbars();
}

void TestTreeWindow::DpiChanged(WindowBase::DpiChangedEvent* ev) {
    if (!ApplyDpiChangedRect(hwnd, ev, Hwnd() != nullptr)) {
        return;
    }
    DpiScope scope(hwnd);
    VirtTree::SetFont(GetDefaultGuiFont(), 0, 0);
}

void TestTreeWindow::LayoutHost(WindowBase::SizeEvent* ev) {
    if (Hwnd()) {
        VirtTree::SetBounds({0, 0, ev->size.dx, ev->size.dy});
    }
}

void TestTree() {
    auto* w = new TestTreeWindow();
    w->onSize = MkMethod1<TestTreeWindow, WindowBase::SizeEvent*, &TestTreeWindow::LayoutHost>(w);
    w->onMove = MkMethod1<TestTreeWindow, WindowBase::MoveEvent*, &TestTreeWindow::Moved>(w);
    w->onDpiChanged = MkMethod1<TestTreeWindow, WindowBase::DpiChangedEvent*, &TestTreeWindow::DpiChanged>(w);
    w->onDestroy = MkMethod1<TestTreeWindow, WindowBase::DestroyEvent*, &TestTreeWindow::Destroyed>(w);
    CreateCustomArgs args;
    args.pos = {CW_USEDEFAULT, CW_USEDEFAULT, 500, 500};
    args.title = StrL("Tree prototype: 1 windows, 2 overlay, 3 smart, 4 hidden");
    w->CreateCustom(args);
    if (!w->VirtTree::Create(w->hwnd, WStrL(L"SumatraTreePrototype"), &w->model, GetDefaultGuiFont())) {
        w->Destroy();
        delete w;
        return;
    }
    w->onNativeMsg = MkMethod1<TestTreeWindow, VirtHostNativeMsg*, &TestTreeWindow::TestMessage>(w);
    w->onSelectionChanged = MkMethod1<TestTreeWindow, VirtTreeSelectionChanged*, &TestTreeWindow::SelectionChanged>(w);
    w->onGetFont = MkMethod1<TestTreeWindow, VirtTreeFontQuery*, &TestTreeWindow::QueryFont>(w);
    w->onGetStyle = MkMethod1<TestTreeWindow, VirtTreeStyle*, &TestTreeWindow::QueryStyle>(w);
    w->SetTestAccessHooks(MkMethod1<TestTreeWindow, VirtTreeExpandEvent*, &TestTreeWindow::TestExpand>(w),
                          MkMethod0<TestTreeWindow, &TestTreeWindow::TestScroll>(w));
    Rect rc = HwndClientRect(w->hwnd);
    w->VirtTree::SetBounds(rc);
    w->SetIsVisible(true);
}
