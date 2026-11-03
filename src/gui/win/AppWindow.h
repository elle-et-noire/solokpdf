/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

enum class WindowRaise {
    Foreground,
    RestoreForeground,
    Active,
    Top
};

void RaiseAppWindow(HWND hwnd, WindowRaise how);
void ShowAppWindow(HWND hwnd, int show);
HWND AppWindowZOrder(HWND hwnd, HWND normal);
