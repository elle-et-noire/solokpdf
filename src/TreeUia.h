/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

enum class VirtTreeSelectReason {
    Programmatic,
    Keyboard,
    Mouse,
    Accessibility
};

struct VirtTreeSelectEvent {
    TreeItem item = TreeModel::kNullItem;
    bool focus = false;
    VirtTreeSelectReason reason = VirtTreeSelectReason::Programmatic;
};

struct VirtTreeExpandEvent {
    TreeItem item = TreeModel::kNullItem;
    VirtTreeExpansion expansion = VirtTreeExpansion::Collapse;
    VirtTreeSelectReason reason = VirtTreeSelectReason::Programmatic;
};

struct VirtTreeUiaData {
    HWND hwnd = nullptr;
    VirtTreeState* state = nullptr;
    VirtTreeScroll* scrollX = nullptr;
    VirtTreeScroll* scrollY = nullptr;
    int* rowDy = nullptr;
    int* bottomPad = nullptr;
    Func0 onScroll;
    Func1<VirtTreeSelectEvent*> onSelect;
    Func1<VirtTreeExpandEvent*> onExpand;
#if IS_DEBUG
    Func0 onTestScrollEvent;
#endif
};

struct VirtTreeUia;
BSTR VirtTreeName(HWND hwnd);
VirtTreeUia* CreateVirtTreeUia(VirtTreeUiaData* data);
void FreeVirtTreeUia(VirtTreeUia* uia);
LRESULT VirtTreeUiaObject(VirtTreeUia* uia, WPARAM wp, LPARAM lp);
void VirtTreeUiaSelected(VirtTreeUia* uia, TreeItem item);
void VirtTreeUiaRemoved(VirtTreeUia* uia, TreeItem item);
void VirtTreeUiaFocused(VirtTreeUia* uia, TreeItem item);
void VirtTreeUiaFocusRoot(VirtTreeUia* uia);
void VirtTreeUiaReset(VirtTreeUia* uia);
void VirtTreeUiaNameChanged(VirtTreeUia* uia, BSTR before, BSTR after);
void VirtTreeUiaExpanded(VirtTreeUia* uia, TreeItem item, VirtTreeExpansion expansion);
void VirtTreeUiaScrolled(VirtTreeUia* uia, VirtTreeScroll oldX, VirtTreeScroll oldY, VirtTreeScroll newX,
                         VirtTreeScroll newY);

struct VirtTreeMsaa;
VirtTreeMsaa* CreateVirtTreeMsaa(VirtTreeUiaData* data);
void FreeVirtTreeMsaa(VirtTreeMsaa* msaa);
bool IsVirtTreeMsaaLive(VirtTreeMsaa* msaa);
LRESULT VirtTreeMsaaObject(VirtTreeMsaa* msaa, WPARAM wp);
