/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

enum class VirtTreeExpansion {
    Collapse,
    Expand
};

struct VirtTreeNode {
    TreeItem item = TreeModel::kNullItem;
    int parent = -1;
    int previous = -1;
    int end = 0;
    int depth = 0;
    int childCount = 0;
    bool expanded = false;
};

struct VirtTreeIndex {
    TreeItem item = TreeModel::kNullItem;
    int node = -1;
};

struct VirtTreeRef {
    TreeItem item = TreeModel::kNullItem;
    u64 generation = 0;
};

struct VirtTreeScroll {
    int extent = 0;
    int viewport = 0;
    int pos = 0;

    int MaxPos() const;
    void SetMetrics(int extent, int viewport);
    bool SetPos(int pos);
    bool MoveBy(int delta);
    bool EnsureVisible(int start, int end);
};

int VirtTreeRowEnd(int row, int rowCount, int rowDy, int bottomPad, int viewport);

struct VirtTreeState {
    TreeModel* model = nullptr;
    Vec<VirtTreeNode> nodes;
    Vec<VirtTreeIndex> index;
    Vec<int> rows;
    TreeItem selected = TreeModel::kNullItem;
    u64 generation = 0;
    u64 rowsGeneration = 0;

    void SetModel(TreeModel* tm);
    int FindNode(TreeItem item) const;
    int FindRow(TreeItem item) const;
    VirtTreeRef MakeRef(TreeItem item) const;
    int FindRef(VirtTreeRef ref) const;
    bool SetExpanded(TreeItem item, VirtTreeExpansion expansion);
    bool SetSubtree(TreeItem item, VirtTreeExpansion expansion);
    bool SetRange(int first, int end, VirtTreeExpansion expansion);
    void ExpandLevels(int level);
    void RebuildRows();
};
