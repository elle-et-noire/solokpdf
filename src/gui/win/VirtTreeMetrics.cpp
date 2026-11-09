/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

#include "base/Base.h"
#include "gui/UIModels.h"
#include "gui/PlatformFont.h"
#include "gui/win/VirtTreeState.h"
#include "gui/win/VirtTreeMetrics.h"

void VirtTreeMetrics::UpdateExtent(const VirtTreeState& state, int rowDy) {
    extent = 0;
    for (int index : state.rows) {
        const VirtTreeNode& node = state.nodes[index];
        i64 dx = (i64)widths[index] + ((i64)node.depth + 2) * rowDy;
        extent = std::max(extent, (int)std::min(dx, (i64)INT_MAX));
    }
}
