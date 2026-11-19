/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

void StartSumatraControl(Str pipeName);
void StartActivationTrace();
#if OS_WIN
void TraceTestPageNav(Str event, HWND hwnd, int value, Str url = {});
void TraceTestMenu(Str event, HWND hwnd, uintptr_t value = 0);
#endif
