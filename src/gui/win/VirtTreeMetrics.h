/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

struct VirtTreeFontQuery {
    TreeItem item = TreeModel::kNullItem;
    PlatformFont* font = nullptr;
    int dpi = 0;
    int boldStart = -1;
    int boldLength = 0;
    PlatformFont* boldFont = nullptr;
};

struct VirtTreeMetrics {
    Vec<int> widths;
    Vec<PlatformFont*> fonts;
    Vec<int> boldStarts;
    Vec<int> boldLengths;
    Vec<u8> layoutBold;
    int extent = 0;

    void UpdateExtent(const VirtTreeState&, int rowDy);
};
