/* Copyright 2026 the SolokPDF project authors (see AUTHORS file).
   License: GPLv3 */

struct MainWindow;

void ClearKeyCount(MainWindow* win);
int TakeVimKeyCount(MainWindow* win, int cmdId);
void RunVimKeyCommand(MainWindow* win, int cmdId);
void ResizeVimCommand(MainWindow* win);
bool VimKeysPreTranslate(MainWindow* win, MSG& msg);
bool VimLinkHintsCapture(MSG& msg);
TempStr VimKeysTestResultTemp(Str action, Str key, int* exitCode);
