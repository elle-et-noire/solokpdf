/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

enum class SidebarTreeKind {
    Bookmarks,
    Favorites
};
TreeView* CreateVirtualSidebarTree(SidebarTreeKind, Str name);
