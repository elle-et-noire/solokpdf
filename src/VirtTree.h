/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

enum class VirtTreeBarMode {
    Windows,
    Overlay,
    Smart,
    Hidden
};

enum class VirtTreeRect {
    Row,
    Text
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

#if IS_DEBUG
struct VirtTreeTestInfo {
    int scrollX = 0;
    int scrollY = 0;
    int maxX = 0;
    int maxY = 0;
    int rowCount = 0;
    int itemCount = 0;
    int selectedRow = -1;
    int contentWidth = 0;
    int viewportHeight = 0;
    u64 generation = 0;
    HWND barX = nullptr;
    HWND barY = nullptr;
    int barYState = -1;
    bool barYOwned = false;
};

struct VirtTreeTestRow {
    TreeItem item = TreeModel::kNullItem;
    int customFont = -1;
    int boldLength = -1;
    int layoutBold = -1;
};
#endif

struct VirtTree {
    Func1<VirtHostNativeMsg*> onNativeMsg;
    Func1<VirtTreeSelectionChanged*> onSelectionChanged;
    Func1<VirtTreeClick*> onClick;
    Func1<VirtTreeFontQuery*> onGetFont;
    Func1<VirtTreeStyle*> onGetStyle;

    ~VirtTree();
    bool Create(HWND parent, WStr className, TreeModel*, PlatformFont*, int bottomPaddingDip = 0,
                TreeDirection direction = TreeDirection::LeftToRight);
    HWND Hwnd() const;
    Rect ClientRect() const;
    PlatformFont* GetFont() const;
    int ItemHeight() const;
    VirtTreeBarMode GetMode() const;
    TreeDirection GetDirection() const;
    void SetColors(Color text, Color bg);
    void SetDirection(TreeDirection);
    void SetAccessibleName(Str);
    void SetBounds(Rect);
    void SetModel(TreeModel*);
    void SetFont(PlatformFont*, int dpi, int bottomPaddingDip);
    void Remeasure(int dpi = 0);
    bool GetItemRect(TreeItem, VirtTreeRect, Rect&);
    TreeItem GetItemAt(Point);
    TreeItemExpansion GetExpansion(TreeItem) const;
    TreeItem GetSelection() const;
    TreeItem FirstItem() const;
    VirtTreeRef MakeRef(TreeItem) const;
    bool IsCurrent(VirtTreeRef) const;
    bool IsValid(VirtTreeRef) const;
    TreeItem FirstVisible();
    TreeItem NextVisible(TreeItem);
    bool EnsureVisible(TreeItem);
    bool SelectItem(TreeItem);
    bool UpdateScrollbars();
    void Repaint();
    void SetMode(VirtTreeBarMode newMode);
    void RefreshScroll();
    void ExpandItem(TreeItem, VirtTreeExpansion, VirtTreeSelectReason = VirtTreeSelectReason::Programmatic);
    void ExpandToLevel(int level);
    void CollapseSiblings(TreeItem item);
    void ExpandAll();
    void ExpandBranch(TreeItem item, VirtTreeExpansion expansion,
                      VirtTreeSelectReason reason = VirtTreeSelectReason::Programmatic);
#if IS_DEBUG
    VirtTreeTestInfo TestInfo() const;
    VirtTreeTestRow TestRow(int row) const;
    Color TestTextColor(TreeItem);
    int TestTextByte(int row, int offset) const;
    bool TestMeasure();
    void SetTestAccessHooks(Func1<VirtTreeExpandEvent*>, Func0);
    void TestScrollEvent(Func0);
#endif

  private:
    struct Guard;
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
    Str name;
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
    Guard* guards = nullptr;

    void FreeAccess();
    void Paint(VirtHostPaintEvent* ev);
    void Message(VirtHostNativeMsg* ev);
    bool UpdateBars();
    void Scroll(UINT message, WPARAM wp);
    bool Measure(int dpi = 0);
    void MeasureExtent();
    void Select(VirtTreeSelectEvent* ev);
    void Expand(VirtTreeExpandEvent* ev);
    void ExpandRange(int first, int end, VirtTreeExpansion, VirtTreeSelectReason = VirtTreeSelectReason::Programmatic);
    bool KeyDown(int key);
    void Search(WCHAR ch);
};
