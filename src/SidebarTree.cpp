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
    Str name;
    VirtTree tree;
    SidebarTreeGuard* guards = nullptr;
    Tooltip* tooltip = nullptr;
    VirtTreeRef tipItem;

    SidebarTree(SidebarTreeKind kind, Str name) : kind(kind), name(str::Dup(name)) {}
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
    str::Free(name);
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
    if (!tree.Create(hwnd, className, nullptr, args.font, kSidebarPadY)) {
        Destroy();
        return nullptr;
    }
    SetWindowTextW(tree.host->native, CWStrTemp(ToWStrTemp(name)));
    tree.rtl = args.isRtl;
    HwndSetRtl(tree.host->native, args.isRtl);
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
    if (tree.host && tree.host->native) tree.SetBounds(HwndClientRect(hwnd));
}

void SidebarTree::SetColors(Color text, Color bg) {
    ControlBase::SetColors(text, bg);
    tree.textColor = textColor;
    tree.bgColor = bgColor;
    if (tree.host && tree.host->native) tree.host->Invalidate();
}

void SidebarTree::SetDirection(TreeDirection direction) {
    HideTip();
    bool rtl = direction == TreeDirection::RightToLeft;
    HwndSetRtl(hwnd, rtl);
    tree.rtl = rtl;
    HwndSetRtl(tree.host->native, rtl);
    tree.SetMode(tree.mode);
}

void SidebarTree::SetTreeFont(PlatformFont* treeFont, int dpi) {
    HideTip();
    font = treeFont;
    if (tooltip) tooltip->SetFont(treeFont);
    tree.SetFont(treeFont, dpi, kSidebarPadY);
}

void SidebarTree::SetAccessibleName(Str value) {
    if (str::Eq(name, value)) return;
    SidebarTreeGuard guard(this);
    HWND window = tree.host ? tree.host->native : nullptr;
    BSTR before = window ? VirtTreeName(window) : nullptr;
    str::ReplaceWithCopy(&name, value);
    if (window) SetWindowTextW(window, CWStrTemp(ToWStrTemp(name)));
    if (!guard.tree || !tree.host || tree.host->native != window) {
        SysFreeString(before);
        return;
    }
    BSTR after = window ? VirtTreeName(window) : nullptr;
    VirtTreeUiaNameChanged(tree.uia, before, after);
    if (guard.tree && tree.host && tree.host->native == window && window)
        NotifyWinEvent(EVENT_OBJECT_NAMECHANGE, window, OBJID_CLIENT, CHILDID_SELF);
    SysFreeString(before);
    SysFreeString(after);
}

HWND SidebarTree::FocusHwnd() {
    return tree.host && tree.host->native ? tree.host->native : hwnd;
}

void SidebarTree::UpdateScrollbars() {
    VirtTreeBarMode mode = SidebarBarMode();
    if (tree.mode != mode) {
        HideTip();
        tree.SetMode(mode);
    }
}

bool SidebarTree::IsExpanded(TreeItem item) {
    int node = tree.state.FindNode(item);
    return node >= 0 && tree.state.nodes[node].expanded;
}

TreeItemExpansion SidebarTree::GetLoadedExpansion(TreeItem item) {
    int node = tree.state.FindNode(item);
    if (node < 0) return TreeItemExpansion::Unavailable;
    return tree.state.nodes[node].expanded ? TreeItemExpansion::Expanded : TreeItemExpansion::Collapsed;
}

bool SidebarTree::GetItemRect(TreeItem item, bool justText, Rect& rect) {
    return tree.GetItemRect(item, justText ? VirtTreeRect::Text : VirtTreeRect::Row, rect);
}

TreeItem SidebarTree::GetSelection() {
    return tree.state.selected;
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
    VirtTreeExpandEvent ev{item, VirtTreeExpansion::Expand};
    tree.Expand(&ev);
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
    return len(tree.state.nodes) ? tree.state.nodes[0].item : TreeModel::kNullItem;
}

TreeItem SidebarTree::FirstVisible() {
    return tree.FirstVisible();
}

TreeItem SidebarTree::NextVisible(TreeItem item) {
    return tree.NextVisible(item);
}

int SidebarTree::ItemHeight() {
    return tree.rowDy;
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
    if (!tree.host || !tree.host->native) return;
    if (ev->msg == WM_SETFOCUS) {
        ::SetFocus(tree.host->native);
    } else if (ev->msg == WM_MOUSEWHEEL || ev->msg == WM_MOUSEHWHEEL) {
        ev->result = SendMessageW(tree.host->native, ev->msg, ev->wparam, ev->lparam);
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
        int row = (int)ev->wp;
        int offset = (int)ev->lp;
        ev->res = 0;
        if (row >= 0 && row < len(tree.state.rows) && offset >= 0) {
            TreeItem item = tree.state.nodes[tree.state.rows[row]].item;
            Str text = tree.state.model->Text(item);
            if (offset < len(text)) ev->res = (u8)text.s[offset] + 1;
        }
        ev->didHandle = true;
        return;
    }
    if (ev->msg == WM_APP + 102) {
        switch (ev->wp) {
            case 0:
                ev->res = len(tree.state.rows);
                break;
            case 1:
                ev->res = tree.state.FindRow(tree.state.selected);
                break;
            case 2:
                ev->res = tree.scrollY.pos;
                break;
            case 3:
                ev->res = tree.rowDy;
                break;
            case 4:
                ev->res = tree.rtl;
                break;
            case 5: {
                int row = (int)ev->lp;
                if (row < 0 || row >= len(tree.state.rows)) {
                    ev->res = -1;
                } else {
                    ev->res = tree.metrics.fonts[tree.state.rows[row]] != tree.font;
                }
                break;
            }
            case 6: {
                int row = (int)ev->lp;
                if (row < 0 || row >= len(tree.state.rows)) {
                    ev->res = -1;
                } else {
                    VirtTreeStyle style;
                    style.item = tree.state.nodes[tree.state.rows[row]].item;
                    style.textColor = tree.textColor;
                    style.bgColor = tree.bgColor;
                    QueryStyle(&style);
                    ev->res = style.textColor;
                }
                break;
            }
            case 7:
                ev->res = (int)tree.mode;
                break;
            case 8:
                ev->res = tooltip ? tooltip->Count() : 0;
                break;
            case 9:
                SetTreeFont(GetAppTreeFontForDpi((int)ev->lp), (int)ev->lp);
                break;
            case 10:
                ev->res = DpiGetForHwnd(tree.host->native);
                break;
            case 11: {
                int row = (int)ev->lp;
                ev->res = row >= 0 && row < len(tree.state.rows) ? tree.metrics.boldLengths[tree.state.rows[row]] : -1;
                break;
            }
            case 12: {
                int row = (int)ev->lp;
                ev->res = row >= 0 && row < len(tree.state.rows) ? tree.metrics.layoutBold[tree.state.rows[row]] : -1;
                break;
            }
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
                if (row < 0 || row >= len(tree.state.rows)) {
                    ev->res = 0;
                    break;
                }
                TreeItem item = tree.state.nodes[tree.state.rows[row]].item;
                ev->res = SelectItem(item);
                break;
            }
            case 16:
                ev->res = tree.barY ? (int)tree.barY->state : -1;
                break;
            case 17:
                ev->res = tree.barY ? (LRESULT)tree.barY->hwnd : 0;
                break;
            case 18:
                ev->res = (GetForegroundWindow() == GetAncestor(tree.host->native, GA_ROOT) ? 1 : 0) |
                          (GetCapture() ? 2 : 0) | (gOverlayScrollbarSuppressThick ? 4 : 0) |
                          (HasTestCursorPosition() ? 8 : 0) |
                          (tree.barY && tree.barY->hwndOwner == tree.host->native ? 16 : 0);
                break;
            case 19:
                ev->res = (LRESULT)GetForegroundWindow();
                break;
            case kSidebarCountItems:
                ev->res = len(tree.state.nodes);
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
        KillTimer(tree.host->native, kSidebarTipTimer);
        ShowTip();
        ev->didHandle = true;
        return;
    }
    if (ev->msg == WM_MOUSEMOVE) {
        TreeItem item = GetItemAt(GET_X_LPARAM(ev->lp), GET_Y_LPARAM(ev->lp));
        if (item != tipItem.item || tipItem.generation != tree.state.generation) {
            HideTip();
            tipItem = tree.state.MakeRef(item);
            if (item) SetTimer(tree.host->native, kSidebarTipTimer, UiTooltipDelayMs(), nullptr);
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
    if (tree.host && tree.host->native) KillTimer(tree.host->native, kSidebarTipTimer);
    if (tooltip) tooltip->Delete();
    tipItem = {};
}

void SidebarTree::ShowTip() {
    if (tree.state.FindRef(tipItem) < 0) return;
    Point cursor = HwndMapWindowPoint(HWND_DESKTOP, tree.host->native, GetCursorPosition());
    if (GetItemAt(cursor.x, cursor.y) != tipItem.item) {
        HideTip();
        return;
    }
    TreeView::GetTooltipEvent ev;
    ev.treeView = this;
    ev.treeItem = tipItem.item;
    SidebarTreeGuard guard(this);
    u64 generation = tree.state.generation;
    auto notify = onGetTooltip;
    notify.Call(&ev);
    if (!guard.tree || tree.state.generation != generation || !tree.host->native) return;
    cursor = HwndMapWindowPoint(HWND_DESKTOP, tree.host->native, GetCursorPosition());
    if (GetItemAt(cursor.x, cursor.y) != ev.treeItem) {
        HideTip();
        return;
    }
    Rect label;
    if (!GetItemRect(ev.treeItem, true, label)) return;
    Rect client = tree.host->ClientRect();
    if (len(ev.text) == 0 && (label.x < 0 || (i64)label.x + label.dx > client.dx)) {
        ev.text = treeModel->Text(ev.treeItem);
    }
    if (len(ev.text) == 0) return;
    if (!tooltip) {
        tooltip = new Tooltip();
        Tooltip::CreateArgs args;
        args.parent = tree.host->native;
        args.font = tree.font;
        args.isRtl = tree.rtl;
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
    click.mouseScreen = HwndClientToScreen(tree.host->native, ev->position);
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
