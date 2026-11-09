/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

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
#include "Settings.h"
#include "AppSettings.h"
#include "SumatraConfig.h"
#include "OverlayScrollbar.h"
#include "TreeUia.h"
#include "VirtTree.h"
#include "shared/SidebarMetrics.h"
#include "SidebarTree.h"

struct SidebarTreeGuard;

struct SidebarTree : TreeView {
    SidebarTreeKind kind;
    VirtTree tree;
    SidebarTreeGuard* guards = nullptr;
    Tooltip* tooltip = nullptr;
    VirtTreeRef tipItem;

    SidebarTree(SidebarTreeKind kind, Str name) : kind(kind) { tree.SetAccessibleName(name); }
    ~SidebarTree() override;

    HWND Create(const CreateArgs&) override;
    void SetBounds(Rect) override;
    void SetColors(Color, Color) override;
    void SetDirection(TreeDirection) override;
    void SetTreeFont(PlatformFont*, int dpi) override;
    void SetAccessibleName(Str) override;
    HWND FocusHwnd() override;
    void UpdateScrollbars() override;
    bool IsExpanded(TreeItem) override;
    TreeItemExpansion GetLoadedExpansion(TreeItem) override;
    bool GetItemRect(TreeItem, bool, Rect&) override;
    TreeItem GetSelection() override;
    bool SelectItem(TreeItem) override;
    bool EnsureVisible(TreeItem) override;
    void ExpandItem(TreeItem) override;
    void ExpandToLevel(int) override;
    void CollapseSiblings(TreeItem) override;
    void ExpandSubtree(TreeItem, TreeExpansion) override;
    TreeItem FirstItem() override;
    TreeItem FirstVisible() override;
    TreeItem NextVisible(TreeItem) override;
    int ItemHeight() override;
    void ExpandAll() override;
    void Clear() override;
    TreeItem GetItemAt(int, int) override;
    void SetTreeModel(TreeModel*) override;
    void SetWrapText(bool) override;
    void RemeasureItems() override;

    void WindowMessage(ControlBase::WndProcEvent*);
    void TreeMessage(VirtHostNativeMsg*);
#if IS_DEBUG
    void TestMessage(VirtHostNativeMsg*);
#endif
    void SelectionChanged(VirtTreeSelectionChanged*);
    void Clicked(VirtTreeClick*);
    void QueryFont(VirtTreeFontQuery*);
    void QueryStyle(VirtTreeStyle*);
    void HideTip();
    void ShowTip();
};

struct SidebarTreeGuard {
    SidebarTree* tree;
    SidebarTreeGuard* previous;
    explicit SidebarTreeGuard(SidebarTree* t) : tree(t), previous(t->guards) { t->guards = this; }
    ~SidebarTreeGuard() {
        if (tree) tree->guards = previous;
    }
};

SidebarTree::~SidebarTree() {
    for (SidebarTreeGuard* guard = guards; guard; guard = guard->previous) guard->tree = nullptr;
    delete tooltip;
}

static constexpr int kSidebarTipTimer = 12637;

static VirtTreeBarMode SidebarBarMode() {
    if (str::EqI(gSettings->scrollbars, StrL("smart"))) return VirtTreeBarMode::Smart;
    if (str::EqI(gSettings->scrollbars, StrL("overlay"))) return VirtTreeBarMode::Overlay;
    if (str::EqI(gSettings->scrollbars, StrL("hidden"))) return VirtTreeBarMode::Hidden;
    return VirtTreeBarMode::Windows;
}

HWND SidebarTree::Create(const CreateArgs& args) {
    idealSize = {48, 120};
    fullRowSelect = args.fullRowSelect;
    onWndProc = MkMethod1<SidebarTree, ControlBase::WndProcEvent*, &SidebarTree::WindowMessage>(this);
    CreateCustomArgs outer;
    outer.parent = args.parent;
    outer.font = args.font;
    outer.style = WS_CHILD | WS_TABSTOP | WS_CLIPCHILDREN;
    outer.exStyle = args.exStyle;
    if (!ControlBase::CreateCustom(outer)) return nullptr;
    WStr className = kind == SidebarTreeKind::Bookmarks ? WStrL(L"SumatraVirtualBookmarksTree")
                                                        : WStrL(L"SumatraVirtualFavoritesTree");
    auto direction = args.isRtl ? TreeDirection::RightToLeft : TreeDirection::LeftToRight;
    if (!tree.Create(hwnd, className, nullptr, args.font, kSidebarPadY, direction)) {
        Destroy();
        return nullptr;
    }
    tree.onNativeMsg = MkMethod1<SidebarTree, VirtHostNativeMsg*, &SidebarTree::TreeMessage>(this);
    tree.onSelectionChanged = MkMethod1<SidebarTree, VirtTreeSelectionChanged*, &SidebarTree::SelectionChanged>(this);
    tree.onClick = MkMethod1<SidebarTree, VirtTreeClick*, &SidebarTree::Clicked>(this);
    tree.onGetFont = MkMethod1<SidebarTree, VirtTreeFontQuery*, &SidebarTree::QueryFont>(this);
    tree.onGetStyle = MkMethod1<SidebarTree, VirtTreeStyle*, &SidebarTree::QueryStyle>(this);
    tree.SetMode(SidebarBarMode());
    tree.SetBounds(HwndClientRect(hwnd));
    return hwnd;
}

void SidebarTree::SetBounds(Rect bounds) {
    HideTip();
    ControlBase::SetBounds(bounds);
    if (tree.Hwnd()) tree.SetBounds(HwndClientRect(hwnd));
}

void SidebarTree::SetColors(Color text, Color bg) {
    ControlBase::SetColors(text, bg);
    tree.SetColors(textColor, bgColor);
}

void SidebarTree::SetDirection(TreeDirection direction) {
    HideTip();
    bool rtl = direction == TreeDirection::RightToLeft;
    HwndSetRtl(hwnd, rtl);
    tree.SetDirection(direction);
}

void SidebarTree::SetTreeFont(PlatformFont* treeFont, int dpi) {
    HideTip();
    font = treeFont;
    if (tooltip) tooltip->SetFont(treeFont);
    tree.SetFont(treeFont, dpi, kSidebarPadY);
}

void SidebarTree::SetAccessibleName(Str value) {
    tree.SetAccessibleName(value);
}

HWND SidebarTree::FocusHwnd() {
    HWND window = tree.Hwnd();
    return window ? window : hwnd;
}

void SidebarTree::UpdateScrollbars() {
    VirtTreeBarMode mode = SidebarBarMode();
    if (tree.GetMode() != mode) {
        HideTip();
        tree.SetMode(mode);
    }
}

bool SidebarTree::IsExpanded(TreeItem item) {
    return tree.GetExpansion(item) == TreeItemExpansion::Expanded;
}

TreeItemExpansion SidebarTree::GetLoadedExpansion(TreeItem item) {
    return tree.GetExpansion(item);
}

bool SidebarTree::GetItemRect(TreeItem item, bool justText, Rect& rect) {
    return tree.GetItemRect(item, justText ? VirtTreeRect::Text : VirtTreeRect::Row, rect);
}

TreeItem SidebarTree::GetSelection() {
    return tree.GetSelection();
}
bool SidebarTree::SelectItem(TreeItem item) {
    HideTip();
    return tree.SelectItem(item);
}
bool SidebarTree::EnsureVisible(TreeItem item) {
    HideTip();
    return tree.EnsureVisible(item);
}

void SidebarTree::ExpandItem(TreeItem item) {
    HideTip();
    tree.ExpandItem(item, VirtTreeExpansion::Expand);
}

void SidebarTree::ExpandToLevel(int level) {
    if (level < 1) return;
    HideTip();
    tree.ExpandToLevel(level);
}

void SidebarTree::CollapseSiblings(TreeItem item) {
    HideTip();
    tree.CollapseSiblings(item);
}

void SidebarTree::ExpandSubtree(TreeItem item, TreeExpansion expansion) {
    HideTip();
    auto how = expansion == TreeExpansion::Expand ? VirtTreeExpansion::Expand : VirtTreeExpansion::Collapse;
    tree.ExpandBranch(item, how);
}

TreeItem SidebarTree::FirstItem() {
    return tree.FirstItem();
}

TreeItem SidebarTree::FirstVisible() {
    return tree.FirstVisible();
}

TreeItem SidebarTree::NextVisible(TreeItem item) {
    return tree.NextVisible(item);
}

int SidebarTree::ItemHeight() {
    return tree.ItemHeight();
}
void SidebarTree::ExpandAll() {
    HideTip();
    tree.ExpandAll();
}
void SidebarTree::Clear() {
    SetTreeModel(nullptr);
}

TreeItem SidebarTree::GetItemAt(int x, int y) {
    return tree.GetItemAt({x, y});
}

void SidebarTree::SetTreeModel(TreeModel* model) {
    HideTip();
    treeModel = model;
    tree.SetModel(model);
}

void SidebarTree::SetWrapText(bool) {}
void SidebarTree::RemeasureItems() {
    HideTip();
    tree.Remeasure();
}

void SidebarTree::WindowMessage(ControlBase::WndProcEvent* ev) {
    if (!tree.Hwnd()) return;
    if (ev->msg == WM_SETFOCUS) {
        ::SetFocus(tree.Hwnd());
    } else if (ev->msg == WM_MOUSEWHEEL || ev->msg == WM_MOUSEHWHEEL) {
        ev->result = SendMessageW(tree.Hwnd(), ev->msg, ev->wparam, ev->lparam);
    } else {
        return;
    }
    ev->didHandle = true;
}

#if IS_DEBUG
static constexpr WPARAM kSidebarCountItems = 20;

void SidebarTree::TestMessage(VirtHostNativeMsg* ev) {
    if (!gForTesting) return;
    if (ev->msg == WM_APP + 103) {
        ev->res = tree.TestTextByte((int)ev->wp, (int)ev->lp);
        ev->didHandle = true;
        return;
    }
    if (ev->msg == WM_APP + 102) {
        auto info = tree.TestInfo();
        switch (ev->wp) {
            case 0:
                ev->res = info.rowCount;
                break;
            case 1:
                ev->res = info.selectedRow;
                break;
            case 2:
                ev->res = info.scrollY;
                break;
            case 3:
                ev->res = tree.ItemHeight();
                break;
            case 4:
                ev->res = tree.GetDirection() == TreeDirection::RightToLeft;
                break;
            case 5:
                ev->res = tree.TestRow((int)ev->lp).customFont;
                break;
            case 6: {
                TreeItem item = tree.TestRow((int)ev->lp).item;
                if (!item) {
                    ev->res = -1;
                } else {
                    ev->res = tree.TestTextColor(item);
                }
                break;
            }
            case 7:
                ev->res = (int)tree.GetMode();
                break;
            case 8:
                ev->res = tooltip ? tooltip->Count() : 0;
                break;
            case 9:
                SetTreeFont(GetAppTreeFontForDpi((int)ev->lp), (int)ev->lp);
                break;
            case 10:
                ev->res = DpiGetForHwnd(tree.Hwnd());
                break;
            case 11:
                ev->res = tree.TestRow((int)ev->lp).boldLength;
                break;
            case 12:
                ev->res = tree.TestRow((int)ev->lp).layoutBold;
                break;
            case 13:
                SetAccessibleName(StrL("Changed name"));
                ev->res = 1;
                break;
            case 14: {
                int row = (int)ev->lp;
                if (row == -1) {
                    ev->res = SelectItem(TreeModel::kNullItem);
                    break;
                }
                TreeItem item = tree.TestRow(row).item;
                if (!item) {
                    ev->res = 0;
                    break;
                }
                ev->res = SelectItem(item);
                break;
            }
            case 16:
                ev->res = info.barYState;
                break;
            case 17:
                ev->res = (LRESULT)info.barY;
                break;
            case 18:
                ev->res = (GetForegroundWindow() == GetAncestor(tree.Hwnd(), GA_ROOT) ? 1 : 0) |
                          (GetCapture() ? 2 : 0) | (gOverlayScrollbarSuppressThick ? 4 : 0) |
                          (HasTestCursorPosition() ? 8 : 0) | (info.barYOwned ? 16 : 0);
                break;
            case 19:
                ev->res = (LRESULT)GetForegroundWindow();
                break;
            case kSidebarCountItems:
                ev->res = info.itemCount;
                break;
            default:
                ev->res = -1;
        }
        ev->didHandle = true;
        return;
    }
}
#endif

void SidebarTree::TreeMessage(VirtHostNativeMsg* ev) {
    if (ev->msg == WM_DESTROY) {
        HideTip();
        delete tooltip;
        tooltip = nullptr;
        return;
    }
#if IS_DEBUG
    TestMessage(ev);
    if (ev->didHandle) return;
#endif
    if (ev->msg == WM_TIMER && ev->wp == kSidebarTipTimer) {
        KillTimer(tree.Hwnd(), kSidebarTipTimer);
        ShowTip();
        ev->didHandle = true;
        return;
    }
    if (ev->msg == WM_MOUSEMOVE) {
        TreeItem item = GetItemAt(GET_X_LPARAM(ev->lp), GET_Y_LPARAM(ev->lp));
        if (item != tipItem.item || !tree.IsCurrent(tipItem)) {
            HideTip();
            tipItem = tree.MakeRef(item);
            if (item) SetTimer(tree.Hwnd(), kSidebarTipTimer, UiTooltipDelayMs(), nullptr);
        }
    } else if (ev->msg == WM_MOUSELEAVE || ev->msg == WM_LBUTTONDOWN || ev->msg == WM_KEYDOWN ||
               ev->msg == WM_MOUSEWHEEL || ev->msg == WM_MOUSEHWHEEL || ev->msg == WM_VSCROLL ||
               ev->msg == WM_HSCROLL) {
        HideTip();
    }
    if (ev->msg != WM_KEYDOWN || !onKeyDown.IsValid()) return;
    TreeView::KeyDownEvent key;
    key.treeView = this;
    key.keyCode = (int)ev->wp;
    key.flags = (u32)ev->lp;
    auto notify = onKeyDown;
    notify.Call(&key);
    if (key.result) ev->didHandle = true;
}

void SidebarTree::HideTip() {
    if (tree.Hwnd()) KillTimer(tree.Hwnd(), kSidebarTipTimer);
    if (tooltip) tooltip->Delete();
    tipItem = {};
}

void SidebarTree::ShowTip() {
    if (!tree.IsValid(tipItem)) return;
    Point cursor = HwndMapWindowPoint(HWND_DESKTOP, tree.Hwnd(), GetCursorPosition());
    if (GetItemAt(cursor.x, cursor.y) != tipItem.item) {
        HideTip();
        return;
    }
    TreeView::GetTooltipEvent ev;
    ev.treeView = this;
    ev.treeItem = tipItem.item;
    SidebarTreeGuard guard(this);
    VirtTreeRef current = tipItem;
    auto notify = onGetTooltip;
    notify.Call(&ev);
    if (!guard.tree || !tree.IsCurrent(current) || !tree.Hwnd()) return;
    cursor = HwndMapWindowPoint(HWND_DESKTOP, tree.Hwnd(), GetCursorPosition());
    if (GetItemAt(cursor.x, cursor.y) != ev.treeItem) {
        HideTip();
        return;
    }
    Rect label;
    if (!GetItemRect(ev.treeItem, true, label)) return;
    Rect client = tree.ClientRect();
    if (len(ev.text) == 0 && (label.x < 0 || (i64)label.x + label.dx > client.dx)) {
        ev.text = treeModel->Text(ev.treeItem);
    }
    if (len(ev.text) == 0) return;
    if (!tooltip) {
        tooltip = new Tooltip();
        Tooltip::CreateArgs args;
        args.parent = tree.Hwnd();
        args.font = tree.GetFont();
        args.isRtl = tree.GetDirection() == TreeDirection::RightToLeft;
        if (!tooltip->Create(args)) {
            delete tooltip;
            tooltip = nullptr;
            return;
        }
    }
    tooltip->SetSingle(ev.text, label, true);
}

void SidebarTree::SelectionChanged(VirtTreeSelectionChanged* ev) {
    HideTip();
    if (!onSelectionChanged.IsValid()) return;
    TreeView::SelectionChangedEvent selection;
    selection.treeView = this;
    selection.prevSelectedItem = ev->previous;
    selection.selectedItem = ev->selected;
    selection.byKeyboard = ev->reason == VirtTreeSelectReason::Keyboard;
    selection.byMouse = ev->reason == VirtTreeSelectReason::Mouse;
    auto notify = onSelectionChanged;
    notify.Call(&selection);
}

void SidebarTree::Clicked(VirtTreeClick* ev) {
    if (!onClick.IsValid()) return;
    TreeView::ClickEvent click;
    click.treeView = this;
    click.treeItem = ev->item;
    click.isDblClick = ev->doubleClick;
    click.mouseWindow = ev->position;
    click.mouseScreen = HwndClientToScreen(tree.Hwnd(), ev->position);
    auto notify = onClick;
    notify.Call(&click);
}

void SidebarTree::QueryFont(VirtTreeFontQuery* ev) {
    if (!onGetItemFont.IsValid()) return;
    TreeView::ItemFontEvent item;
    item.treeView = this;
    item.treeItem = ev->item;
    item.font = ev->font;
    item.dpi = ev->dpi;
    onGetItemFont.Call(&item);
    ev->font = item.font;
    ev->boldStart = item.boldStart;
    ev->boldLength = item.boldLength;
    ev->boldFont = item.boldFont;
}

void SidebarTree::QueryStyle(VirtTreeStyle* ev) {
    if (!onGetItemStyle.IsValid()) return;
    TreeView::ItemStyleEvent item;
    item.treeView = this;
    item.treeItem = ev->item;
    item.textColor = ev->textColor;
    item.bgColor = ev->bgColor;
    item.selected = ev->selected;
    item.focused = ev->focused;
    item.hot = ev->hot;
    onGetItemStyle.Call(&item);
    ev->textColor = item.textColor;
    ev->bgColor = item.bgColor;
    ev->focusOutline = item.focusOutline;
}

TreeView* CreateVirtualSidebarTree(SidebarTreeKind kind, Str name) {
    return new SidebarTree(kind, name);
}
