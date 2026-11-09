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
#include "OverlayScrollbar.h"
#include <uiautomation.h>
#include "TreeUia.h"
#include "VirtTree.h"

static constexpr u64 kTypeAheadTimeoutMs = 1000;

struct VirtTreeGuard {
    VirtTree* tree;
    VirtTreeGuard* previous;
    u64 generation;
    u64 rowsGeneration;
    HWND window;
    explicit VirtTreeGuard(VirtTree* t)
        : tree(t),
          previous(t->guards),
          generation(t->state.generation),
          rowsGeneration(t->state.rowsGeneration),
          window(t->host ? t->host->native : nullptr) {
        t->guards = this;
    }
    ~VirtTreeGuard() {
        if (tree) tree->guards = previous;
    }
    bool SameModel() const {
        return tree && tree->state.generation == generation && tree->host && tree->host->native == window;
    }
    bool SameRows() const { return SameModel() && tree->state.rowsGeneration == rowsGeneration; }
};

VirtTree::~VirtTree() {
    for (VirtTreeGuard* guard = guards; guard; guard = guard->previous) guard->tree = nullptr;
    FreeAccess();
    OverlayScrollbarDestroy(barX);
    OverlayScrollbarDestroy(barY);
    if (host) host->Dispose();
}

bool VirtTree::Create(HWND parent, WStr className, TreeModel* model, PlatformFont* initialFont) {
    VirtHost::CreateArgs args;
    args.parent = parent;
    args.className = className;
    host = VirtHost::Create(args);
    if (!host) return false;
    font = initialFont;
    state.SetModel(model);
    hotItem = TreeModel::kNullItem;
    if (!Measure()) return false;
    uiaData.hwnd = host->native;
    uiaData.state = &state;
    uiaData.scrollX = &scrollX;
    uiaData.scrollY = &scrollY;
    uiaData.rowDy = &rowDy;
    uiaData.bottomPad = &bottomPad;
    uiaData.onScroll = MkMethod0<VirtTree, &VirtTree::UiaScrolled>(this);
    uiaData.onSelect = MkMethod1<VirtTree, VirtTreeSelectEvent*, &VirtTree::Select>(this);
    uiaData.onExpand = MkMethod1<VirtTree, VirtTreeExpandEvent*, &VirtTree::Expand>(this);
    host->onPaint = MkMethod1<VirtTree, VirtHostPaintEvent*, &VirtTree::Paint>(this);
    host->onNativeMsg = MkMethod1<VirtTree, VirtHostNativeMsg*, &VirtTree::Message>(this);
    SetMode(VirtTreeBarMode::Windows);
    return true;
}

void VirtTree::SetModel(TreeModel* model) {
    state.SetModel(model);
    scrollX.SetPos(0);
    scrollY.SetPos(0);
    hotItem = TreeModel::kNullItem;
    if (!Measure()) return;
    VecReset(search);
    if (!UpdateBars()) return;
    host->Invalidate();
    VirtTreeUiaReset(uia);
    NotifyWinEvent(EVENT_OBJECT_REORDER, host->native, OBJID_CLIENT, CHILDID_SELF);
}

void VirtTree::SetBounds(Rect bounds) {
    host->SetBounds(bounds);
    UpdateBars();
}

bool VirtTree::EnsureVisible(TreeItem item) {
    VirtTreeGuard guard(this);
    u64 generation = state.generation;
    HWND window = host->native;
    int node = state.FindNode(item);
    if (node < 0) return false;
    Vec<int> expanded;
    for (int parent = state.nodes[node].parent; parent >= 0; parent = state.nodes[parent].parent) {
        if (!state.nodes[parent].expanded) {
            state.nodes[parent].expanded = true;
            VecAppend(expanded, parent);
        }
    }
    if (len(expanded)) {
        state.RebuildRows();
        MeasureExtent();
        VirtTreeGuard update(this);
        if (!UpdateBars() || !update.SameRows()) return false;
        for (int parent : expanded) {
            NotifyWinEvent(EVENT_OBJECT_STATECHANGE, host->native, OBJID_CLIENT, parent + 1);
            if (!update.SameRows()) return false;
            VirtTreeUiaExpanded(uia, state.nodes[parent].item, VirtTreeExpansion::Expand);
            if (!update.SameRows()) return false;
        }
        NotifyWinEvent(EVENT_OBJECT_REORDER, host->native, OBJID_CLIENT, CHILDID_SELF);
        if (!update.SameRows()) return false;
    }
    int row = state.FindRow(item);
    i64 top = (i64)row * rowDy;
    int start = (int)std::min(top, (i64)INT_MAX);
    int end = VirtTreeRowEnd(row, len(state.rows), rowDy, bottomPad, scrollY.viewport);
    bool scrolled = scrollY.EnsureVisible(start, end);
    if (len(expanded) || scrolled) {
        u64 rowsGeneration = state.rowsGeneration;
        if (!UpdateBars() || !guard.tree || state.generation != generation || state.rowsGeneration != rowsGeneration ||
            host->native != window)
            return false;
        host->Invalidate();
    }
    return true;
}

bool VirtTree::SelectItem(TreeItem item) {
    if (item && !EnsureVisible(item)) return false;
    VirtTreeSelectEvent ev{item, false, VirtTreeSelectReason::Programmatic};
    Select(&ev);
    return true;
}

void VirtTree::FreeAccess() {
    FreeVirtTreeUia(uia);
    uia = nullptr;
    FreeVirtTreeMsaa(msaa);
    msaa = nullptr;
}

void VirtTree::Select(VirtTreeSelectEvent* ev) {
    int node = state.FindNode(ev->item);
    if (ev->item && node < 0) return;
    TreeItem old = state.selected;
    bool changed = state.selected != ev->item;
    bool hadFocus = ::GetFocus() == host->native;
    state.selected = ev->item;
    if (ev->focus) ::SetFocus(host->native);
    if (changed) {
        if (ev->item) {
            NotifyWinEvent(EVENT_OBJECT_SELECTION, host->native, OBJID_CLIENT, node + 1);
            VirtTreeUiaSelected(uia, ev->item);
        } else {
            NotifyWinEvent(EVENT_OBJECT_SELECTIONWITHIN, host->native, OBJID_CLIENT, CHILDID_SELF);
            VirtTreeUiaRemoved(uia, old);
        }
    }
    if (hadFocus && (ev->focus || changed) && ::GetFocus() == host->native) {
        NotifyWinEvent(EVENT_OBJECT_FOCUS, host->native, OBJID_CLIENT, ev->item ? node + 1 : CHILDID_SELF);
        if (ev->item)
            VirtTreeUiaFocused(uia, ev->item);
        else
            VirtTreeUiaFocusRoot(uia);
    }
    host->Invalidate();
    if (changed && onSelectionChanged.IsValid()) {
        VirtTreeSelectionChanged event{old, ev->item, ev->reason};
        auto notify = onSelectionChanged;
        notify.Call(&event);
    }
}

void VirtTree::Expand(VirtTreeExpandEvent* ev) {
    TreeItem before = state.selected;
    int node = state.FindNode(ev->item);
    if (node < 0 || !state.SetExpanded(ev->item, ev->expansion)) return;
    MeasureExtent();
    if (!UpdateBars()) return;
    VirtTreeGuard guard(this);
    host->Invalidate();
    NotifyWinEvent(EVENT_OBJECT_STATECHANGE, host->native, OBJID_CLIENT, node + 1);
    if (!guard.SameRows()) return;
    NotifyWinEvent(EVENT_OBJECT_REORDER, host->native, OBJID_CLIENT, CHILDID_SELF);
    if (!guard.SameRows()) return;
    VirtTreeUiaExpanded(uia, ev->item, ev->expansion);
    if (!guard.SameRows()) return;
    if (state.selected != before) {
        NotifyWinEvent(EVENT_OBJECT_SELECTION, host->native, OBJID_CLIENT, node + 1);
        if (!guard.SameRows()) return;
        VirtTreeUiaSelected(uia, state.selected);
        if (!guard.SameRows()) return;
        if (::GetFocus() == host->native) {
            NotifyWinEvent(EVENT_OBJECT_FOCUS, host->native, OBJID_CLIENT, node + 1);
            if (!guard.SameRows()) return;
            VirtTreeUiaFocused(uia, state.selected);
            if (!guard.SameRows()) return;
        }
        if (onSelectionChanged.IsValid()) {
            VirtTreeSelectionChanged event{before, state.selected, ev->reason};
            auto notify = onSelectionChanged;
            notify.Call(&event);
        }
    }
}

// Keep the collapse phase separate to preserve selection and notification order.
void VirtTree::ExpandToLevel(int level) {
    if (level < 1) return;
    VirtTreeGuard guard(this);
    ExpandRange(0, len(state.nodes), VirtTreeExpansion::Collapse);
    if (!guard.SameModel()) return;
    state.ExpandLevels(level);
    MeasureExtent();
    if (!UpdateBars()) return;
    host->Invalidate();
    VirtTreeUiaReset(uia);
    NotifyWinEvent(EVENT_OBJECT_REORDER, host->native, OBJID_CLIENT, CHILDID_SELF);
}

void VirtTree::CollapseSiblings(TreeItem item) {
    VirtTreeGuard guard(this);
    int node = state.FindNode(item ? item : state.selected);
    int parent = node >= 0 ? state.nodes[node].parent : -1;
    int first = parent >= 0 ? parent + 1 : 0;
    int end = parent >= 0 ? state.nodes[parent].end : len(state.nodes);
    for (int i = first; i < end; i = state.nodes[i].end) {
        VirtTreeExpandEvent ev{state.nodes[i].item, VirtTreeExpansion::Collapse};
        Expand(&ev);
        if (!guard.SameModel()) return;
    }
}

void VirtTree::ExpandAll() {
    ExpandRange(0, len(state.nodes), VirtTreeExpansion::Expand);
}

void VirtTree::ExpandBranch(TreeItem item, VirtTreeExpansion expansion, VirtTreeSelectReason reason) {
    int node = state.FindNode(item);
    if (node < 0) return;
    ExpandRange(node, state.nodes[node].end, expansion, reason);
}

void VirtTree::ExpandRange(int first, int end, VirtTreeExpansion expansion, VirtTreeSelectReason reason) {
    if (first < 0 || first >= len(state.nodes) || first >= end) return;
    bool expanded = expansion == VirtTreeExpansion::Expand;
    Vec<int> changed;
    for (int i = first; i < end && i < len(state.nodes); i++) {
        if (state.nodes[i].childCount && state.nodes[i].expanded != expanded) VecAppend(changed, i);
    }
    TreeItem previous = state.selected;
    if (!state.SetRange(first, end, expansion)) return;
    MeasureExtent();
    if (!UpdateBars()) return;
    VirtTreeGuard guard(this);
    host->Invalidate();
    for (int node : changed) {
        NotifyWinEvent(EVENT_OBJECT_STATECHANGE, host->native, OBJID_CLIENT, node + 1);
        if (!guard.SameRows()) return;
        VirtTreeUiaExpanded(uia, state.nodes[node].item, expansion);
        if (!guard.SameRows()) return;
    }
    VirtTreeUiaReset(uia);
    if (!guard.SameRows()) return;
    NotifyWinEvent(EVENT_OBJECT_REORDER, host->native, OBJID_CLIENT, CHILDID_SELF);
    if (!guard.SameRows()) return;
    if (previous != state.selected) {
        int selected = state.FindNode(state.selected);
        NotifyWinEvent(EVENT_OBJECT_SELECTION, host->native, OBJID_CLIENT, selected + 1);
        if (!guard.SameRows()) return;
        VirtTreeUiaSelected(uia, state.selected);
        if (!guard.SameRows()) return;
        if (::GetFocus() == host->native) {
            NotifyWinEvent(EVENT_OBJECT_FOCUS, host->native, OBJID_CLIENT, selected + 1);
            if (!guard.SameRows()) return;
            VirtTreeUiaFocused(uia, state.selected);
            if (!guard.SameRows()) return;
        }
        if (onSelectionChanged.IsValid()) {
            VirtTreeSelectionChanged event{previous, state.selected, reason};
            auto notify = onSelectionChanged;
            notify.Call(&event);
        }
    }
}

void VirtTree::UiaScrolled() {
    if (!UpdateBars()) return;
    host->Invalidate();
}

static bool IsTextBoundary(Str text, int offset) {
    return offset == 0 || offset == len(text) || ((u8)text.s[offset] & 0xc0) != 0x80;
}

bool VirtTree::Measure(int dpi) {
    VirtTreeGuard guard(this);
    u64 generation = state.generation;
    u64 measure = ++measureGeneration;
    DpiScope scope(host->native);
    if (dpi <= 0) dpi = DpiGetForHwnd(host->native);
    int height = PlatformFontMeasureText(font, StrL("Ag")).dy + DpiScaleByDpi(dpi, 6);
    Vec<int> widths;
    Vec<PlatformFont*> fonts;
    Vec<int> boldStarts;
    Vec<int> boldLengths;
    Vec<u8> layoutBold;
    int count = len(state.nodes);
    for (int i = 0; i < count; i++) {
        AutoArenaSavepoint temp;
        VirtTreeFontQuery query{state.nodes[i].item, font, dpi};
        auto notify = onGetFont;
        notify.Call(&query);
        if (!guard.tree || state.generation != generation || measureGeneration != measure || !host->native) {
            return false;
        }
        if (!query.font) query.font = font;
        Str text = state.model->Text(query.item);
        bool hasBold = query.boldFont && query.boldStart >= 0 && query.boldLength > 0 && query.boldStart < len(text) &&
                       query.boldLength <= len(text) - query.boldStart && IsTextBoundary(text, query.boldStart) &&
                       IsTextBoundary(text, query.boldStart + query.boldLength);
        int start = hasBold ? query.boldStart : 0;
        int boldLength = hasBold ? query.boldLength : 0;
        int width = PlatformFontMeasureText(query.font, text).dx;
        bool useLayout = false;
        if (hasBold) {
            Size layoutSize = D2DMeasureBoldText(query.font, text, start, boldLength);
            if (!layoutSize.IsEmpty()) {
                width = std::max(width, layoutSize.dx);
                useLayout = true;
            }
        }
        VecAppend(fonts, query.font);
        VecAppend(boldStarts, start);
        VecAppend(boldLengths, boldLength);
        VecAppend(layoutBold, (u8)useLayout);
        VecAppend(widths, width);
    }
    rowDy = height;
    metrics.fonts = fonts;
    metrics.boldStarts = boldStarts;
    metrics.boldLengths = boldLengths;
    metrics.layoutBold = layoutBold;
    metrics.widths = widths;
    metrics.UpdateExtent(state, rowDy);
    contentDx = metrics.extent;
    return true;
}

void VirtTree::MeasureExtent() {
    metrics.UpdateExtent(state, rowDy);
    contentDx = metrics.extent;
}

bool VirtTree::UpdateBars() {
    if (!host || !host->native) {
        return false;
    }
    VirtTreeGuard guard(this);
    HWND window = host->native;
    u64 generation = state.generation;
    u64 rowsGeneration = state.rowsGeneration;
    u64 bars = barsGeneration;
    auto valid = [&] {
        return guard.tree && state.generation == generation && state.rowsGeneration == rowsGeneration &&
               barsGeneration == bars && host->native == window;
    };
    for (int pass = 0; pass < 3; pass++) {
        Rect rc = host->ClientRect();
        scrollX.SetMetrics(contentDx, rc.dx);
        i64 height = (i64)len(state.rows) * rowDy;
        if (height > 0) height += bottomPad;
        scrollY.SetMetrics((int)std::min(height, (i64)INT_MAX), rc.dy);
        for (int axis = 0; axis < 2; axis++) {
            VirtTreeScroll& scroll = axis == 0 ? scrollX : scrollY;
            SCROLLINFO si{sizeof(si), SIF_RANGE | SIF_PAGE | SIF_POS};
            si.nMin = 0;
            si.nMax = std::max(0, scroll.extent - 1);
            si.nPage = scroll.viewport;
            si.nPos = scroll.pos;
            if (mode == VirtTreeBarMode::Windows) {
                SetScrollInfo(host->native, axis == 0 ? SB_HORZ : SB_VERT, &si, TRUE);
                if (!valid()) return false;
            } else if (barX && barY) {
                OverlayScrollbar* bar = axis == 0 ? barX : barY;
                OverlayScrollbarSetInfo(bar, &si, true);
                if (!valid()) return false;
                OverlayScrollbarUpdatePos(bar);
                if (!valid()) return false;
                OverlayScrollbarShow(bar, scroll.MaxPos() > 0);
                if (!valid()) return false;
            }
        }
        Rect after = host->ClientRect();
        if (rc.dx == after.dx && rc.dy == after.dy) {
            break;
        }
    }
    bool changed =
        haveReportedScroll && (scrollX.pos != reportedX.pos || scrollY.pos != reportedY.pos ||
                               scrollX.extent != reportedX.extent || scrollY.extent != reportedY.extent ||
                               scrollX.viewport != reportedX.viewport || scrollY.viewport != reportedY.viewport);
    VirtTreeScroll oldX = reportedX;
    VirtTreeScroll oldY = reportedY;
    reportedX = scrollX;
    reportedY = scrollY;
    haveReportedScroll = true;
    if (changed) {
        VirtTreeUiaScrolled(uia, oldX, oldY, scrollX, scrollY);
        if (!valid()) return false;
        NotifyWinEvent(EVENT_OBJECT_LOCATIONCHANGE, host->native, OBJID_CLIENT, CHILDID_SELF);
    }
    return valid();
}

void VirtTree::Paint(VirtHostPaintEvent* ev) {
    VirtTreeGuard guard(this);
    u64 generation = state.generation;
    u64 rowsGeneration = state.rowsGeneration;
    u64 measure = measureGeneration;
    Rect rc = ev->clientRect;
    Color bg = IsSpecialColor(bgColor) ? GetSysColor(COLOR_WINDOW) : bgColor;
    Color defaultText = IsSpecialColor(textColor) ? GetSysColor(COLOR_WINDOWTEXT) : textColor;
    ev->gfx->FillRect(rc, bg);
    if (rowDy <= 0) {
        return;
    }
    int first = scrollY.pos / rowDy;
    int last = (int)std::min((i64)len(state.rows), ((i64)scrollY.pos + rc.dy + rowDy - 1) / rowDy);
    for (int i = first; i < last; i++) {
        int nodeIndex = state.rows[i];
        VirtTreeNode node = state.nodes[nodeIndex];
        Rect row{0, (int)((i64)i * rowDy - scrollY.pos), rc.dx, rowDy};
        bool selected = state.selected == node.item;
        VirtTreeStyle style{node.item,
                            selected ? GetSysColor(COLOR_HIGHLIGHTTEXT) : defaultText,
                            selected ? GetSysColor(COLOR_HIGHLIGHT) : bg,
                            selected,
                            ::GetFocus() == host->native,
                            node.item == hotItem};
        auto queryStyle = onGetStyle;
        queryStyle.Call(&style);
        if (!guard.tree || state.generation != generation || state.rowsGeneration != rowsGeneration ||
            measureGeneration != measure || !host->native)
            return;
        if (style.bgColor != bg) ev->gfx->FillRect(row, style.bgColor);
        i64 x64 = ((i64)node.depth + 1) * rowDy - scrollX.pos;
        if (x64 < INT_MIN / 2 || x64 > INT_MAX / 2) {
            if (style.focusOutline) ev->gfx->DrawRect(row, style.textColor);
            continue;
        }
        int x = (int)x64;
        Color color = style.textColor;
        if (node.childCount > 0) {
            int iconX = rtl ? rc.dx - x : x - rowDy;
            ev->gfx->DrawText(node.expanded ? StrL("-") : StrL("+"), {iconX, row.y, rowDy, row.dy},
                              gfxTextCenter | gfxTextVCenter, font, color);
        }
        int textWidth = metrics.widths[nodeIndex];
        i64 textLeft = rtl ? (i64)rc.dx - x - textWidth : x;
        if (textLeft < INT_MIN || textLeft > INT_MAX) {
            if (style.focusOutline) ev->gfx->DrawRect(row, style.textColor);
            continue;
        }
        Rect textRect{(int)textLeft, row.y, textWidth, row.dy};
        u32 flags = gfxTextVCenter | (rtl ? gfxTextRight | gfxTextRtl : gfxTextLeft);
        Str text = state.model->Text(node.item);
        int boldLen = metrics.boldLengths[nodeIndex];
        bool drawn = false;
        if (boldLen != 0 && metrics.layoutBold[nodeIndex]) {
            int start = metrics.boldStarts[nodeIndex];
            drawn = D2DDrawBoldText(ev->gfx, text, textRect, row, flags, metrics.fonts[nodeIndex], start, boldLen,
                                    color, style.bgColor);
        }
        if (!drawn) {
            ev->gfx->DrawText(text, textRect, flags, metrics.fonts[nodeIndex], color);
        }
        if (style.focusOutline) ev->gfx->DrawRect(row, style.textColor);
    }
}

void VirtTree::SetMode(VirtTreeBarMode newMode) {
    VirtTreeGuard guard(this);
    barsGeneration++;
    u64 bars = barsGeneration;
    HWND window = host->native;
    auto valid = [&] { return guard.tree && barsGeneration == bars && host->native == window; };
    OverlayScrollbar* old = barX;
    barX = nullptr;
    OverlayScrollbarDestroy(old);
    if (!valid()) return;
    old = barY;
    barY = nullptr;
    OverlayScrollbarDestroy(old);
    if (!valid()) return;
    mode = newMode;
    LONG_PTR style = GetWindowLongPtrW(host->native, GWL_STYLE);
    style &= ~(WS_HSCROLL | WS_VSCROLL);
    if (mode == VirtTreeBarMode::Windows) {
        style |= WS_HSCROLL | WS_VSCROLL;
    }
    SetWindowLongPtrW(host->native, GWL_STYLE, style);
    if (!valid()) return;
    SetWindowPos(host->native, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    if (!valid()) return;
    if (mode == VirtTreeBarMode::Overlay || mode == VirtTreeBarMode::Smart) {
        auto barMode = mode == VirtTreeBarMode::Smart ? OverlayScrollbar::Mode::Smart : OverlayScrollbar::Mode::Thick;
        old = OverlayScrollbarCreate(host->native, OverlayScrollbar::Type::Horz, barMode);
        if (!valid()) {
            OverlayScrollbarDestroy(old);
            return;
        }
        barX = old;
        old = OverlayScrollbarCreate(host->native, OverlayScrollbar::Type::Vert, barMode);
        if (!valid()) {
            OverlayScrollbarDestroy(old);
            return;
        }
        barY = old;
        auto layout = rtl ? OverlayScrollbar::Layout::RightToLeft : OverlayScrollbar::Layout::LeftToRight;
        barX->layout = barY->layout = layout;
    }
    if (!UpdateBars()) return;
    host->Invalidate();
}

void VirtTree::Scroll(UINT message, WPARAM wp) {
    bool horizontal = message == WM_HSCROLL;
    VirtTreeScroll& scroll = horizontal ? scrollX : scrollY;
    int delta = horizontal ? rowDy : rowDy * 3;
    int code = LOWORD(wp);
    if (horizontal && rtl) {
        if (code == SB_LINELEFT)
            code = SB_LINERIGHT;
        else if (code == SB_LINERIGHT)
            code = SB_LINELEFT;
        else if (code == SB_PAGELEFT)
            code = SB_PAGERIGHT;
        else if (code == SB_PAGERIGHT)
            code = SB_PAGELEFT;
        else if (code == SB_LEFT)
            code = SB_RIGHT;
        else if (code == SB_RIGHT)
            code = SB_LEFT;
    }
    if (code == SB_LINEUP) {
        scroll.MoveBy(-delta);
    } else if (code == SB_LINEDOWN) {
        scroll.MoveBy(delta);
    } else if (code == SB_PAGEUP) {
        scroll.MoveBy(-scroll.viewport);
    } else if (code == SB_PAGEDOWN) {
        scroll.MoveBy(scroll.viewport);
    } else if (code == SB_TOP) {
        scroll.SetPos(0);
    } else if (code == SB_BOTTOM) {
        scroll.SetPos(scroll.MaxPos());
    } else if (code == SB_THUMBTRACK || code == SB_THUMBPOSITION) {
        SCROLLINFO si{sizeof(si), SIF_TRACKPOS};
        OverlayScrollbar* bar = horizontal ? barX : barY;
        if (bar) {
            OverlayScrollbarGetInfo(bar, &si);
        } else {
            GetScrollInfo(host->native, horizontal ? SB_HORZ : SB_VERT, &si);
        }
        scroll.SetPos(si.nTrackPos);
    }
    if (!UpdateBars()) return;
    host->Invalidate();
}

bool VirtTree::KeyDown(int key) {
    VirtTreeGuard guard(this);
    u64 generation = state.generation;
    HWND window = host->native;
    int row = state.FindRow(state.selected);
    int target = row;
    if (key == VK_HOME)
        target = 0;
    else if (key == VK_END)
        target = len(state.rows) - 1;
    else if (key == VK_DOWN)
        target = std::min(row + 1, len(state.rows) - 1);
    else if (key == VK_UP)
        target = row < 0 ? 0 : std::max(0, row - 1);
    else if (key == VK_PRIOR)
        target = row < 0 ? 0 : std::max(0, row - std::max(1, scrollY.viewport / rowDy));
    else if (key == VK_NEXT)
        target = row < 0 ? 0 : std::min(len(state.rows) - 1, row + std::max(1, scrollY.viewport / rowDy));
    else if (key == VK_LEFT || key == VK_RIGHT || key == VK_RETURN || key == VK_ADD || key == VK_SUBTRACT) {
        if (row < 0) return true;
        VirtTreeNode node = state.nodes[state.rows[row]];
        bool right = key == (rtl ? VK_LEFT : VK_RIGHT);
        bool left = key == (rtl ? VK_RIGHT : VK_LEFT);
        if (key == VK_ADD || key == VK_SUBTRACT) {
            VirtTreeExpandEvent ev{node.item, key == VK_ADD ? VirtTreeExpansion::Expand : VirtTreeExpansion::Collapse,
                                   VirtTreeSelectReason::Keyboard};
            Expand(&ev);
        } else if (key == VK_RETURN && node.childCount) {
            VirtTreeExpansion expansion = node.expanded ? VirtTreeExpansion::Collapse : VirtTreeExpansion::Expand;
            if (IsShiftPressed()) {
                int index = state.FindNode(node.item);
                int end = node.parent < 0 ? len(state.nodes) : state.nodes[node.parent].end;
                ExpandRange(index, end, expansion, VirtTreeSelectReason::Keyboard);
            } else {
                VirtTreeExpandEvent ev{node.item, expansion, VirtTreeSelectReason::Keyboard};
                Expand(&ev);
            }
        } else if (right && node.childCount && !node.expanded) {
            VirtTreeExpandEvent ev{node.item, VirtTreeExpansion::Expand, VirtTreeSelectReason::Keyboard};
            Expand(&ev);
        } else if (left && node.expanded) {
            VirtTreeExpandEvent ev{node.item, VirtTreeExpansion::Collapse, VirtTreeSelectReason::Keyboard};
            Expand(&ev);
        } else if (right && node.expanded && node.childCount) {
            target = row + 1;
        } else if (left && node.parent >= 0) {
            target = state.FindRow(state.nodes[node.parent].item);
        }
    } else if (key == VK_MULTIPLY || key == VK_DIVIDE) {
        VirtTreeExpansion expansion = key == VK_MULTIPLY ? VirtTreeExpansion::Expand : VirtTreeExpansion::Collapse;
        if (IsShiftPressed()) {
            int first = 0;
            int count = len(state.nodes);
            if (key == VK_DIVIDE && count > 0 && state.nodes[0].end == count) first = 1;
            ExpandRange(first, count, expansion, VirtTreeSelectReason::Keyboard);
        } else if (row >= 0) {
            TreeItem item = state.nodes[state.rows[row]].item;
            ExpandBranch(item, expansion, VirtTreeSelectReason::Keyboard);
        }
    } else {
        return false;
    }
    if (!guard.tree || state.generation != generation || host->native != window) return true;
    VecReset(search);
    if (target >= 0 && target < len(state.rows) && target != row) {
        VirtTreeSelectEvent ev{state.nodes[state.rows[target]].item, false, VirtTreeSelectReason::Keyboard};
        Select(&ev);
        if (!guard.tree || state.generation != generation || host->native != window) return true;
    }
    int selectedRow = state.FindRow(state.selected);
    if (selectedRow >= 0) {
        i64 top = (i64)selectedRow * rowDy;
        int start = (int)std::min(top, (i64)INT_MAX);
        int end = VirtTreeRowEnd(selectedRow, len(state.rows), rowDy, bottomPad, scrollY.viewport);
        if (scrollY.EnsureVisible(start, end)) {
            if (!UpdateBars()) return true;
            host->Invalidate();
        }
    }
    return true;
}

void VirtTree::Search(WCHAR ch) {
    u64 now = GetTickCount64();
    bool repeat = len(search) == 1 && CompareStringOrdinal(search.els, 1, &ch, 1, TRUE) == CSTR_EQUAL;
    bool fresh = len(search) == 0 || now - lastSearch > kTypeAheadTimeoutMs || repeat;
    if (fresh) VecReset(search);
    lastSearch = now;
    VecAppend(search, ch);
    if (ch >= 0xd800 && ch <= 0xdbff) return;
    int count = len(state.rows);
    if (count == 0) return;
    int selected = state.FindRow(state.selected);
    int start = fresh ? selected + 1 : std::max(0, selected);
    for (int i = 0; i < count; i++) {
        AutoArenaSavepoint temp;
        int row = (start + i) % count;
        TreeItem item = state.nodes[state.rows[row]].item;
        WStr text = ToWStrTemp(state.model->Text(item));
        if (len(text) < len(search) ||
            CompareStringOrdinal(text.s, len(search), search.els, len(search), TRUE) != CSTR_EQUAL) {
            continue;
        }
        i64 top = (i64)row * rowDy;
        int first = (int)std::min(top, (i64)INT_MAX);
        int end = VirtTreeRowEnd(row, len(state.rows), rowDy, bottomPad, scrollY.viewport);
        scrollY.EnsureVisible(first, end);
        if (!UpdateBars()) return;
        VirtTreeSelectEvent ev{item, false, VirtTreeSelectReason::Keyboard};
        Select(&ev);
        return;
    }
}

void VirtTree::Message(VirtHostNativeMsg* ev) {
    VirtTreeGuard guard(this);
    if (ev->msg == WM_DESTROY) {
        barsGeneration++;
        FreeAccess();
        OverlayScrollbarDestroy(barX);
        OverlayScrollbarDestroy(barY);
        barX = barY = nullptr;
    }
    if (onNativeMsg.IsValid()) {
        HWND window = host->native;
        u64 generation = state.generation;
        auto notify = onNativeMsg;
        notify.Call(ev);
        if (!guard.tree) {
            ev->didHandle = true;
            return;
        }
        if (ev->didHandle) return;
        if (host->native != window || state.generation != generation) {
            ev->didHandle = true;
            return;
        }
    }
    if (ev->msg == WM_KEYDOWN) suppressChar = 0;
    if (ev->msg == WM_GETOBJECT && (long)ev->lp == (long)UiaRootObjectId) {
        if (!uia) {
            uia = CreateVirtTreeUia(&uiaData);
        }
        ev->res = VirtTreeUiaObject(uia, ev->wp, ev->lp);
    } else if (ev->msg == WM_GETOBJECT && (long)ev->lp == OBJID_CLIENT) {
        if (!IsVirtTreeMsaaLive(msaa)) {
            FreeVirtTreeMsaa(msaa);
            msaa = CreateVirtTreeMsaa(&uiaData);
        }
        ev->res = VirtTreeMsaaObject(msaa, ev->wp);
    } else if (ev->msg == WM_VSCROLL || ev->msg == WM_HSCROLL) {
        Scroll(ev->msg, ev->wp);
    } else if (ev->msg == WM_MOUSEWHEEL) {
        scrollY.MoveBy(-GET_WHEEL_DELTA_WPARAM(ev->wp) * rowDy / WHEEL_DELTA * 3);
        if (!UpdateBars()) {
            ev->didHandle = true;
            return;
        }
        host->Invalidate();
    } else if (ev->msg == WM_MOUSEHWHEEL) {
        i64 delta = (i64)GET_WHEEL_DELTA_WPARAM(ev->wp) * rowDy * 3 / WHEEL_DELTA;
        if (rtl) delta = -delta;
        delta = std::max((i64)INT_MIN, std::min(delta, (i64)INT_MAX));
        scrollX.MoveBy((int)delta);
        if (!UpdateBars()) {
            ev->didHandle = true;
            return;
        }
        host->Invalidate();
    } else if (ev->msg == WM_MOUSEMOVE || ev->msg == WM_MOUSELEAVE) {
        TreeItem hot = TreeModel::kNullItem;
        if (ev->msg == WM_MOUSEMOVE && rowDy > 0) {
            i64 y = (i64)GET_Y_LPARAM(ev->lp) + scrollY.pos;
            i64 row = y / rowDy;
            if (y >= 0 && row < len(state.rows)) hot = state.nodes[state.rows[(int)row]].item;
        }
        if (hot != hotItem) {
            hotItem = hot;
            host->Invalidate();
        }
    } else if (ev->msg == WM_KEYDOWN && KeyDown((int)ev->wp)) {
        if (!guard.tree) {
            ev->didHandle = true;
            return;
        }
        if (ev->wp == VK_ADD)
            suppressChar = '+';
        else if (ev->wp == VK_SUBTRACT)
            suppressChar = '-';
        else if (ev->wp == VK_MULTIPLY)
            suppressChar = '*';
        else if (ev->wp == VK_DIVIDE)
            suppressChar = '/';
    } else if (ev->msg == WM_CHAR && (ev->wp == VK_RETURN || ev->wp == suppressChar)) {
        suppressChar = 0;
    } else if (ev->msg == WM_CHAR && ev->wp >= 32 && ev->wp <= 0xffff) {
        Search((WCHAR)ev->wp);
    } else if (ev->msg == WM_SETFOCUS || ev->msg == WM_KILLFOCUS) {
        host->Invalidate();
        if (ev->msg == WM_SETFOCUS) {
            int node = state.FindNode(state.selected);
            NotifyWinEvent(EVENT_OBJECT_FOCUS, host->native, OBJID_CLIENT, node >= 0 ? node + 1 : CHILDID_SELF);
            if (node >= 0)
                VirtTreeUiaFocused(uia, state.selected);
            else
                VirtTreeUiaFocusRoot(uia);
        }
    } else if (ev->msg == WM_LBUTTONDOWN || ev->msg == WM_LBUTTONDBLCLK) {
        bool doubleClick = ev->msg == WM_LBUTTONDBLCLK;
        i64 y = (i64)GET_Y_LPARAM(ev->lp) + scrollY.pos;
        i64 row = rowDy > 0 ? y / rowDy : -1;
        if (y >= 0 && row >= 0 && row < len(state.rows)) {
            VirtTreeNode node = state.nodes[state.rows[(int)row]];
            u64 generation = state.generation;
            HWND window = host->native;
            VirtTreeSelectEvent select{node.item, true, VirtTreeSelectReason::Mouse};
            Select(&select);
            if (!guard.tree || state.generation != generation || host->native != window) {
                ev->didHandle = true;
                return;
            }
            i64 x = (i64)GET_X_LPARAM(ev->lp) + scrollX.pos;
            if (node.childCount > 0 && (doubleClick || x < ((i64)node.depth + 1) * rowDy)) {
                VirtTreeExpandEvent expand{node.item,
                                           node.expanded ? VirtTreeExpansion::Collapse : VirtTreeExpansion::Expand,
                                           VirtTreeSelectReason::Mouse};
                Expand(&expand);
                if (!guard.tree || state.generation != generation || host->native != window) {
                    ev->didHandle = true;
                    return;
                }
            }
            host->Invalidate();
            if (onClick.IsValid()) {
                VirtTreeClick click{node.item, {GET_X_LPARAM(ev->lp), GET_Y_LPARAM(ev->lp)}, doubleClick};
                auto notify = onClick;
                notify.Call(&click);
                if (!guard.tree) {
                    ev->didHandle = true;
                    return;
                }
            }
        }
    } else {
        return;
    }
    ev->didHandle = true;
}
