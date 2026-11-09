/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

#include "base/Base.h"
#include "gui/UIModels.h"
#include "gui/win/VirtTreeState.h"

struct TreeBuildFrame {
    TreeItem item;
    int node;
    int next;
    int count;
    int previous;
};

static int CompareTreeIndex(const VirtTreeIndex* a, const VirtTreeIndex* b) {
    return (a->item > b->item) - (a->item < b->item);
}

int VirtTreeRowEnd(int row, int rowCount, int rowDy, int bottomPad, int viewport) {
    if (row < 0 || row >= rowCount) return 0;
    i64 end = ((i64)row + 1) * rowDy;
    if (row == rowCount - 1) end += std::min(bottomPad, std::max(0, viewport - rowDy));
    return (int)std::min(end, (i64)INT_MAX);
}

int VirtTreeScroll::MaxPos() const {
    return std::max(0, extent - viewport);
}

void VirtTreeScroll::SetMetrics(int newExtent, int newViewport) {
    extent = std::max(0, newExtent);
    viewport = std::max(0, newViewport);
    SetPos(pos);
}

bool VirtTreeScroll::SetPos(int newPos) {
    newPos = ClampI(newPos, 0, MaxPos());
    if (newPos == pos) {
        return false;
    }
    pos = newPos;
    return true;
}

bool VirtTreeScroll::MoveBy(int delta) {
    i64 next = (i64)pos + delta;
    next = std::max((i64)0, std::min(next, (i64)MaxPos()));
    return SetPos((int)next);
}

bool VirtTreeScroll::EnsureVisible(int start, int end) {
    if (viewport <= 0 || end <= start) {
        return false;
    }
    if (start < pos) {
        return SetPos(start);
    }
    if ((i64)end > (i64)pos + viewport) {
        return SetPos(end - viewport);
    }
    return false;
}

void VirtTreeState::SetModel(TreeModel* tm) {
    model = tm;
    generation++;
    selected = TreeModel::kNullItem;
    VecReset(nodes);
    VecReset(index);
    VecReset(rows);
    if (!tm || tm->Root() == TreeModel::kNullItem) {
        return;
    }

    TreeItem root = tm->Root();
    Vec<TreeBuildFrame> stack;
    VecAppend(stack, {root, -1, 0, tm->ChildCount(root), -1});
    while (len(stack) > 0) {
        TreeBuildFrame& frame = stack[len(stack) - 1];
        if (frame.next == frame.count) {
            if (frame.node >= 0) {
                nodes[frame.node].end = len(nodes);
            }
            VecPop(stack);
            continue;
        }
        TreeItem child = tm->ChildAt(frame.item, frame.next++);
        int parent = frame.node;
        int previous = frame.previous;
        int count = tm->ChildCount(child);
        int node = len(nodes);
        frame.previous = node;
        VecAppend(nodes, {child, parent, previous, 0, len(stack) - 1, count, count > 0 && tm->IsExpanded(child)});
        VecAppend(index, {child, node});
        VecAppend(stack, {child, node, 0, count, -1});
    }
    VecSort(index, CompareTreeIndex);
    RebuildRows();
}

int VirtTreeState::FindNode(TreeItem item) const {
    int lo = 0;
    int hi = len(index);
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (index[mid].item < item) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo < len(index) && index[lo].item == item ? index[lo].node : -1;
}

int VirtTreeState::FindRow(TreeItem item) const {
    int node = FindNode(item);
    int lo = 0;
    int hi = len(rows);
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (rows[mid] < node) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo < len(rows) && rows[lo] == node ? lo : -1;
}

VirtTreeRef VirtTreeState::MakeRef(TreeItem item) const {
    if (FindNode(item) < 0) {
        return {};
    }
    return {item, generation};
}

int VirtTreeState::FindRef(VirtTreeRef ref) const {
    if (ref.generation != generation) {
        return -1;
    }
    return FindNode(ref.item);
}

bool VirtTreeState::SetExpanded(TreeItem item, VirtTreeExpansion expansion) {
    int node = FindNode(item);
    if (node < 0 || nodes[node].childCount == 0) {
        return false;
    }
    bool expanded = expansion == VirtTreeExpansion::Expand;
    if (nodes[node].expanded == expanded) {
        return false;
    }
    nodes[node].expanded = expanded;
    if (!expanded) {
        int selectedNode = FindNode(selected);
        if (selectedNode > node && selectedNode < nodes[node].end) {
            selected = item;
        }
    }
    RebuildRows();
    return true;
}

bool VirtTreeState::SetSubtree(TreeItem item, VirtTreeExpansion expansion) {
    int node = FindNode(item);
    if (node < 0) return false;
    return SetRange(node, nodes[node].end, expansion);
}

bool VirtTreeState::SetRange(int first, int end, VirtTreeExpansion expansion) {
    if (first < 0 || end > len(nodes) || first >= end) return false;
    bool expanded = expansion == VirtTreeExpansion::Expand;
    bool changed = false;
    for (int i = first; i < end; i++) {
        if (nodes[i].childCount && nodes[i].expanded != expanded) {
            nodes[i].expanded = expanded;
            changed = true;
        }
    }
    if (changed) {
        RebuildRows();
        int selectedNode = FindNode(selected);
        while (selectedNode >= 0 && FindRow(nodes[selectedNode].item) < 0) {
            selectedNode = nodes[selectedNode].parent;
        }
        if (selectedNode >= 0) selected = nodes[selectedNode].item;
    }
    return changed;
}

void VirtTreeState::RebuildRows() {
    rowsGeneration++;
    VecReset(rows);
    for (int i = 0; i < len(nodes);) {
        VecAppend(rows, i);
        i = nodes[i].expanded ? i + 1 : nodes[i].end;
    }
}
