/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

enum class VirtTreeBarMode {
    Windows,
    Overlay,
    Smart,
    Hidden
};

struct VirtTreeSelectionChanged {
    TreeItem previous = TreeModel::kNullItem;
    TreeItem selected = TreeModel::kNullItem;
    VirtTreeSelectReason reason = VirtTreeSelectReason::Programmatic;
};

struct VirtTreeClick {
    TreeItem item = TreeModel::kNullItem;
    Point position;
    bool doubleClick = false;
};

struct VirtTreeStyle {
    TreeItem item = TreeModel::kNullItem;
    Color textColor = kColorUnset;
    Color bgColor = kColorUnset;
    bool selected = false;
    bool focused = false;
    bool hot = false;
    bool focusOutline = false;
};

struct VirtTreeGuard;

struct VirtTree {
    VirtTreeState state;
    VirtTreeScroll scrollX;
    VirtTreeScroll scrollY;
    VirtTreeScroll reportedX;
    VirtTreeScroll reportedY;
    bool haveReportedScroll = false;
    VirtHost* host = nullptr;
    OverlayScrollbar* barX = nullptr;
    OverlayScrollbar* barY = nullptr;
    VirtTreeUiaData uiaData;
    VirtTreeUia* uia = nullptr;
    VirtTreeMsaa* msaa = nullptr;
    PlatformFont* font = nullptr;
    Color textColor = kColorUnset;
    Color bgColor = kColorUnset;
    VirtTreeBarMode mode = VirtTreeBarMode::Windows;
    bool rtl = false;
    int rowDy = 0;
    int bottomPad = 0;
    int contentDx = 0;
    VirtTreeMetrics metrics;
    u64 measureGeneration = 0;
    u64 barsGeneration = 0;
    TreeItem hotItem = TreeModel::kNullItem;
    Vec<WCHAR> search;
    u64 lastSearch = 0;
    WCHAR suppressChar = 0;
    Func1<VirtHostNativeMsg*> onNativeMsg;
    Func1<VirtTreeSelectionChanged*> onSelectionChanged;
    Func1<VirtTreeClick*> onClick;
    Func1<VirtTreeFontQuery*> onGetFont;
    Func1<VirtTreeStyle*> onGetStyle;
    VirtTreeGuard* guards = nullptr;

    ~VirtTree();
    bool Create(HWND parent, WStr className, TreeModel*, PlatformFont*);
    void SetBounds(Rect);
    void SetModel(TreeModel*);
    bool EnsureVisible(TreeItem);
    bool SelectItem(TreeItem);
    void FreeAccess();
    void Paint(VirtHostPaintEvent* ev);
    void Message(VirtHostNativeMsg* ev);
    bool UpdateBars();
    void SetMode(VirtTreeBarMode newMode);
    void Scroll(UINT message, WPARAM wp);
    bool Measure(int dpi = 0);
    void MeasureExtent();
    void UiaScrolled();
    void Select(VirtTreeSelectEvent* ev);
    void Expand(VirtTreeExpandEvent* ev);
    void ExpandBranch(TreeItem item, VirtTreeExpansion expansion);
    void ExpandRange(int first, int end, VirtTreeExpansion expansion,
                     VirtTreeSelectReason reason = VirtTreeSelectReason::Programmatic);
    bool KeyDown(int key);
    void Search(WCHAR ch);
};
