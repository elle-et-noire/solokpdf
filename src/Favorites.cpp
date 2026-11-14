/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/File.h"
#include "base/UITask.h"
#include "base/Win.h"

#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "gui/PlatformFont.h"
#include "gui/Gfx.h"
#include "gui/VirtCtrl.h"

#include "Settings.h"
#include "DisplayMode.h"
#include "DocController.h"
#include "EngineBase.h"
#include "DisplayModel.h"
#include "FileHistory.h"
#include "SumatraPDF.h"
#include "MainWindow.h"
#include "WindowTab.h"
#include "resource.h"
#include "Commands.h"
#include "AppSettings.h"
#include "Menu.h"
#include "SumatraDialogs.h"
#include "Translations.h"
#include "Accelerators.h"
#include "Tabs.h"
#include "Theme.h"
#include "FilterHighlightDraw.h"
#include "PagePosition.h"
#include "SidebarPanel.h"
#include "SidebarTree.h"
#include "SumatraConfig.h"
#include "Favorites.h"
#include "MenuDefs.h"

void MenuAppendString(HMENU m, Str title, int cmdId) {
    auto safeStr = MenuToSafeStringTemp(title);
    WCHAR* ws = CWStrTemp(safeStr);
    AppendMenuW(m, MF_STRING, (UINT_PTR)cmdId, ws);
}

// For easy access, we try to show favorites in the menu, similar to a list of
// recently opened files.
// The first menu items are for currently opened file (up to kMaxFavMenus), based
// on the assumption that user is usually interested in navigating current file.
// Then we have a submenu for each file for which there are bookmarks (up to
// kMaxFavSubmenus), each having up to kMaxFavMenus menu items.
// If not all favorites can be shown, we also enable "Show all favorites" menu which
// will provide a way to see all favorites.
// Note: not sure if that's the best layout. Maybe we should always use submenu and
// put the submenu for current file as the first one (potentially named as "Current file"
// or some such, to make it stand out from other submenus)
void AppendFavMenus(MenuRef m, Str currFilePath) {
    // To minimize mouse movement when navigating current file via favorites
    // menu, put favorites for current file first
    FileState* currFileFav = nullptr;
    if (currFilePath) {
        currFileFav = GetFavByFilePath(currFilePath);
    }

    // sort the files with favorites by base file name of file path
    StrVec filePathsSorted;
    if (CanAccessDisk()) {
        // only show favorites for other files, if we're allowed to open them
        GetSortedFilePaths(filePathsSorted, currFileFav);
    }
    if (currFileFav && len(*currFileFav->favorites) > 0) {
        filePathsSorted.InsertAt(0, currFileFav->filePath);
    }

    if (len(filePathsSorted) == 0) {
        return;
    }

    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);

    int menusCount = len(filePathsSorted);
    menusCount = std::min(menusCount, kMaxFavMenus);

    // collect the favorites that will be shown, so that a single pass over the
    // commands gives all of them their command id
    Vec<FavMenuEntry> favs;
    for (int i = 0; i < menusCount; i++) {
        Str filePath = filePathsSorted[i];
        FileState* f = GetFavByFilePath(filePath);
        if (!f) {
            continue;
        }
        for (int j = 0; j < len(*f->favorites) && j < kMaxFavMenus; j++) {
            Favorite* fn = (*f->favorites)[j];
            VecAppend(favs, FavMenuEntry{filePath, fn->pageNo, 0});
        }
    }
    SetFavCmdIds(favs);

    int favIdx = 0;
    for (int i = 0; i < menusCount; i++) {
        Str filePath = filePathsSorted[i];
        FileState* f = GetFavByFilePath(filePath);
        ReportIf(!f);
        if (!f) {
            continue;
        }
        HMENU sub = m;
        bool combined = (len(*f->favorites) == 1);
        if (!combined) {
            sub = CreateMenu();
        }
        AppendFavMenuItems(sub, f, favs, favIdx, combined, f == currFileFav);
        if (!combined) {
            Str s = Tr("Current file");
            if (f != currFileFav) {
                s = MenuToSafeStringTemp(path::GetBaseNameTemp(filePath));
            }
            AppendMenuW(m, MF_POPUP | MF_STRING, (UINT_PTR)sub, CWStrTemp(s));
        }
    }
}

// the menu item shows the command's shortcut
TempStr FavAddMenuTextTemp(Str addText) {
    return AppendAccelKeyToMenuStringTemp(addText, CmdFavoriteAdd);
}

void GoToFavoritePage(MainWindow* win, Str pageNo, PointF scrollPos) {
    if (!IsMainWindowValidAndNotClosing(win)) {
        return;
    }
    ApplyFavoriteView(win, pageNo, scrollPos, true);
    // we might have been invoked by clicking on a tree view
    // switch focus so that keyboard navigation works, which enables
    // a fluid experience
    win->Focus();
}

void GoToFavForTreeItem(MainWindow* win, TreeItem ti) {
    if (!ti) {
        return;
    }

    FavTreeItem* fti = (FavTreeItem*)ti;
    Favorite* fn = fti->favorite;
    if (!fn) {
        // can happen for top-level node which is not associated with a favorite
        // but only serves a parent node for favorites for a given file
        return;
    }
    FileState* f = GetByFavorite(fn);
    GoToFavorite(win, f, fn);
}

static TempStr GetFavFilterTemp(MainWindow* win) {
    if (!win || !win->favFilterEdit) {
        return {};
    }
    return win->favFilterEdit->GetTextTemp();
}

static bool IsFavoritesTabActive(MainWindow* win) {
    return win && win->CurrentTab() && win->CurrentTab()->IsFavoritesTab();
}

// Expand every branch (used when the full-window Favorites tab is shown).
static void ExpandAllFavTree(MainWindow* win) {
    if (win && win->favTreeView && win->favTreeView->hwnd) {
        win->favTreeView->ExpandAll();
    }
}

static void FocusFavFilterEdit(MainWindow* win) {
    if (!win) {
        return;
    }
    EditSetFocus(win->favFilterEdit);
    EditSetCursorPosAtEnd(win->favFilterEdit);
}

// Select first top-level item's first child when it has children; otherwise the
// first top-level item (Down from the search box).
static void SelectFirstFavTreeItem(MainWindow* win) {
    TreeView* tv = win ? win->favTreeView : nullptr;
    if (!tv || !tv->treeModel || !tv->hwnd) {
        return;
    }
    TreeModel* tm = tv->treeModel;
    TreeItem root = tm->Root();
    if (tm->ChildCount(root) == 0) {
        return;
    }
    TreeItem first = tm->ChildAt(root, 0);
    TreeItem sel = first;
    if (tm->ChildCount(first) > 0) {
        tv->ExpandItem(first);
        sel = tm->ChildAt(first, 0);
    }
    tv->SelectItem(sel);
    tv->EnsureVisible(sel);
}

// set when a mouse click changed the selection and navigated, so the click
// notification that follows doesn't add a second navigation point (E45).
// A rebuild drops that click, so it clears the flag
static bool gFavSelChangedByMouseClick = false;

static void ApplyFavFilter(MainWindow* win) {
    if (!win || !win->favTreeView) {
        return;
    }
    TreeView* treeView = win->favTreeView;
    auto* prevModel = treeView->treeModel;
    TreeModel* newModel = BuildFavTreeModel(win, GetFavFilterTemp(win));
    gFavSelChangedByMouseClick = false;
    treeView->SetTreeModel(newModel);
    delete prevModel;
    if (IsFavoritesTabActive(win)) {
        ExpandAllFavTree(win);
    }
}

static void OnFavFilterTextChanged(MainWindow* win) {
    ApplyFavFilter(win);
}

// Favorites-tab chrome: expand all, layout, focus the search box.
static void PrepareFavoritesTabUi(MainWindow* win) {
    if (!win) {
        return;
    }
    PopulateFavTreeIfNeeded(win);
    ExpandAllFavTree(win);
    LayoutSidebarPanel(win->favoritesTabPanel);
    FocusFavFilterEdit(win);
    if (win->favTreeView) {
        RedrawWindow(win->favTreeView->hwnd, nullptr, nullptr, RDW_ERASE | RDW_INVALIDATE | RDW_ALLCHILDREN);
    }
}

static LRESULT CALLBACK WndProcFavFilterEdit(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR /*subclassId*/,
                                             DWORD_PTR data) {
    MainWindow* win = (MainWindow*)data;
    if (msg == WM_KEYDOWN) {
        if (wp == VK_DOWN) {
            // move into the tree: first child of the first file node (or first row)
            if (win && win->favTreeView) {
                SelectFirstFavTreeItem(win);
                HwndSetFocus(win->favTreeView->hwnd);
            }
            return 0;
        }
        if (wp == VK_ESCAPE) {
            Edit* edit = win ? win->favFilterEdit : nullptr;
            if (edit) {
                TempStr txt = edit->GetTextTemp();
                if (txt && len(txt) > 0) {
                    edit->SetText(StrL(""));
                    // onTextChanged restores the full tree
                    return 0;
                }
                // empty: stay in the edit (Favorites tab) or fall through to tree in sidebar
                if (IsFavoritesTabActive(win)) {
                    return 0;
                }
                if (win->favTreeView) {
                    SetFocus(win->favTreeView->hwnd);
                }
                return 0;
            }
        }
        if (wp == VK_RETURN) {
            // prevent ding; navigation is done from the tree
            return 0;
        }
    }
    if (msg == WM_CHAR && (wp == VK_RETURN || wp == '\r' || wp == '\n')) {
        return 0;
    }
    return DefSubclassProc(hwnd, msg, wp, lp);
}

void PopulateFavTreeIfNeeded(MainWindow* win) {
    TreeView* treeView = win->favTreeView;
    if (treeView->treeModel) {
        return;
    }
    TreeModel* tm = BuildFavTreeModel(win, GetFavFilterTemp(win));
    treeView->SetTreeModel(tm);
}

// in a sidebar panel (independent of the Favorites tab)
void ToggleFavorites(MainWindow* win) {
    if (IsSidebarViewShown(win, SidebarView::Favorites)) {
        HideSidebarView(win, SidebarView::Favorites);
        return;
    }
    ShowSidebarView(win, SidebarView::Favorites);
}

// open/select full-window Favorites tab (can use with sidebar Favorites)
void ToggleFavoritesTab(MainWindow* win) {
    // Full-window Favorites tab (independent of the sidebar Favorites panel).
    // Always switches to / creates the tab (close with the tab's ✕).
    // Requires tabs; falls back to sidebar toggle when tabs are off.
    if (!SettingsUseTabs()) {
        ToggleFavorites(win);
        return;
    }
    WindowTab* favTab = FindFavoritesTab(win);
    if (favTab) {
        int idx = win->GetTabIdx(favTab);
        if (idx >= 0 && !IsCurrentTab(win, favTab)) {
            TabsSelect(win, idx); // LoadModelIntoTab does layout + focus
        } else {
            // already on Favorites: re-layout and focus search
            PrepareFavoritesTabUi(win);
        }
        return;
    }

    // Save the document tab first: AddTabToWindow selects via TabCtrl_SetCurSel,
    // which does not send TCN_SELCHANGE, so we must LoadModelIntoTab ourselves.
    SaveCurrentWindowTab(win);
    auto* tab = new WindowTab(win);
    tab->type = WindowTab::Type::Favorites;
    AddTabToWindow(win, tab);
    LoadModelIntoTab(tab);
}

void UpdateFavoritesTree(MainWindow* win) {
    TreeView* treeView = win->favTreeView;
    // rebuild (honors current search filter if any)
    ApplyFavFilter(win);
    TreeModel* newModel = treeView->treeModel;

    // hide favorites UI if we've removed the last favorite
    bool hasAny = false;
    if (newModel) {
        hasAny = newModel->ChildCount(newModel->Root()) > 0;
    }
    if (!hasAny) {
        if (WindowTab* favTab = FindFavoritesTab(win)) {
            CloseTab(favTab, false);
        }
        if (IsSidebarViewShown(win, SidebarView::Favorites)) {
            HideSidebarView(win, SidebarView::Favorites);
        } else {
            ScheduleUiUpdate(win, kUiForceRelayout | kUiSidebarDirty);
        }
        return;
    }
    // refresh the sidebar only when a panel is supposed to show favorites
    if (IsSidebarViewShown(win, SidebarView::Favorites)) {
        ApplySidebarPanels(win);
    } else if (FindFavoritesTab(win)) {
        ScheduleUiUpdate(win, kUiForceRelayout | kUiSidebarDirty);
    }
}

void RememberFavTreeExpansionState(MainWindow* win) {
    VecReset(win->expandedFavorites);
    TreeView* treeView = win->favTreeView;
    TreeModel* tm = treeView ? treeView->treeModel : nullptr;
    if (!tm) {
        // TODO: remember all favorites as expanded
        return;
    }
    TreeItem root = tm->Root();
    int n = tm->ChildCount(root);
    for (int i = 0; i < n; i++) {
        TreeItem ti = tm->ChildAt(root, i);
        bool isExpanded = treeView->IsExpanded(ti);
        if (isExpanded) {
            FavTreeItem* fti = (FavTreeItem*)ti;
            Favorite* fn = fti->favorite;
            FileState* f = GetByFavorite(fn);
            VecAppend(win->expandedFavorites, f);
        }
    }
}

static void OnFavItemFont(TreeView::ItemFontEvent* ev) {
    auto* item = (FavTreeItem*)ev->treeItem;
    if (!item || item->fileNameOffset < 0 || item->fileNameLen <= 0) return;
    PlatformFont* bold = GetAppTreeFontExForDpi(ev->dpi, true, false);
    if (item->fileNameOffset == 0 && item->fileNameLen == len(item->text)) {
        ev->font = bold;
    } else {
        ev->boldStart = item->fileNameOffset;
        ev->boldLength = item->fileNameLen;
        ev->boldFont = bold;
    }
}

static void OnFavItemStyle(TreeView::ItemStyleEvent* ev) {
    TreeView* tree = ev->treeView;
    if (ev->selected && ev->focused && ThemeUsesHighContrastColors()) {
        ev->bgColor = GetSysColor(COLOR_HIGHLIGHT);
        ev->textColor = GetSysColor(COLOR_HIGHLIGHTTEXT);
        ev->focusOutline = true;
    } else if (ev->selected) {
        Color bg = IsSpecialColor(tree->bgColor) ? ThemeCanvasColor() : tree->bgColor;
        Color text = IsSpecialColor(tree->textColor) ? ThemeWindowTextColor() : tree->textColor;
        ev->bgColor = ThemeSelectionBg(bg);
        ev->textColor = ThemeSelectionText(ev->bgColor, text);
    } else if (ev->hot && !ThemeUsesHighContrastColors()) {
        ev->bgColor = ThemeHoverColorOn(tree->bgColor);
    }
}

static void FavTreeItemClicked(TreeView::ClickEvent* ev) {
    bool handledBySelChange = gFavSelChangedByMouseClick;
    gFavSelChangedByMouseClick = false;
    if (handledBySelChange || ev->treeItem != ev->treeView->GetSelection()) {
        return;
    }
    // Parent rows with children: leave expand/collapse to the tree; only
    // navigate when the click is a leaf (or a single-favorite file row).
    FavTreeItem* fti = (FavTreeItem*)ev->treeItem;
    if (fti && len(fti->children) > 0) {
        return;
    }
    MainWindow* win = FindMainWindowByHwnd(ev->treeView->hwnd);
    ReportIf(!win);
    GoToFavForTreeItem(win, ev->treeItem);
}

static void FavTreeSelectionChanged(TreeView::SelectionChangedEvent* ev) {
    MainWindow* win = FindMainWindowByHwnd(ev->treeView->hwnd);
    ReportIf(!win);

    // Navigate only on a mouse click, not on keyboard selection changes:
    // arrow keys / type-ahead should move the selection so the user can browse
    // favorites without each move jumping the document (and stealing focus to
    // the canvas). Enter navigates, handled in FavTreeKeyDown (#1936).
    if (!ev->byMouse) {
        return;
    }
    FavTreeItem* fti = (FavTreeItem*)ev->selectedItem;
    if (fti && len(fti->children) > 0) {
        // selecting a parent to expand/collapse must not navigate away
        return;
    }
    gFavSelChangedByMouseClick = true;
    GoToFavForTreeItem(win, ev->selectedItem);
}

// in TableOfContents.cpp
extern void TocTreeKeyDown2(TreeView::KeyDownEvent*);

static void FavTreeKeyDown(TreeView::KeyDownEvent* ev) {
    MainWindow* win = FindMainWindowByHwnd(ev->treeView->hwnd);
    // Enter opens the selected favorite (sidebar panel and Favorites tab).
    // Must set result so TreeView skips its default Enter = expand/collapse.
    if (ev->keyCode == VK_RETURN) {
        if (win) {
            GoToFavForTreeItem(win, ev->treeView->GetSelection());
            ev->result = 1; // also prevents the default Windows ding
            return;
        }
    }
    // Esc: clear search and focus the filter (Favorites tab and sidebar)
    if (ev->keyCode == VK_ESCAPE) {
        if (win && win->favFilterEdit) {
            win->favFilterEdit->SetText(StrL(""));
            FocusFavFilterEdit(win);
            ev->result = 1;
            return;
        }
    }
    // Up on the first top-level node: return focus to the search box
    if (ev->keyCode == VK_UP && win && win->favFilterEdit) {
        TreeItem sel = ev->treeView->GetSelection();
        if (sel && sel == ev->treeView->FirstItem()) {
            FocusFavFilterEdit(win);
            ev->result = 1;
            return;
        }
    }
    // reuse the toc tree handler for Tab/focus handling
    TocTreeKeyDown2(ev);
}

static void FavTreeContextMenu(ContextMenuEvent* ev) {
    MainWindow* win = FindMainWindowByHwnd(ev->w->hwnd);
    if (!win) {
        return;
    }

    Point pt{};
    TreeItem ti = GetOrSelectTreeItemAtPos(ev, pt);
    if (!ti) {
        pt = {ev->mouseScreen.x, ev->mouseScreen.y};
    }
    HMENU popup = BuildMenuFromDef(menuDefContextFav, CreatePopupMenu(), nullptr);
    MenuSetChecked(popup, CmdToggleFavoritesSort, gSettings->sortFavoritesByName);
    if (!ti) {
        // Sort By Name works with no selection; Remove needs a favorite row.
        MenuRemove(popup, CmdFavoriteDel);
    }
    MarkMenuOwnerDraw(popup);
    uint flags = TPM_RETURNCMD | TPM_RIGHTBUTTON;
    int cmd = TrackPopupMenu(popup, flags, pt.x, pt.y, 0, win->hwndFrame, nullptr);
    FreeMenuOwnerDrawInfoData(popup);
    DestroyMenu(popup);

    // TODO: it would be nice to have a system for undo-ing things, like in Gmail,
    // so that we can do destructive operations without asking for permission via
    // invasive model dialog boxes but also allow reverting them if were done
    // by mistake
    if (CmdToggleFavoritesSort == cmd) {
        ToggleSortFavoritesByName();
        return;
    }
    if (CmdFavoriteDel == cmd && ti) {
        FavTreeItem* fti = (FavTreeItem*)ti;
        Favorite* toDelete = fti->favorite;
        FileState* f = GetByFavorite(toDelete);
        if (fti->parent) {
            DelFavorite(f, toDelete);
        } else {
            RememberFavTreeExpansionStateForAllWindows();
            RemoveAllFavForFile(f->filePath);
            UpdateFavoritesTreeForAllWindows();
            ScheduleSaveSettings();
        }
    }
}

// The Favorites view; a sidebar panel or the Favorites tab shows it (SidebarPanel.cpp)
void CreateFavorites(MainWindow* win) {
    HWND parent = win->sidebarBottom->hwnd;
    auto* filterEdit = new Edit();
    {
        Edit::CreateArgs eargs;
        eargs.parent = parent;
        eargs.withBorder = true;
        eargs.cueText = Tr("Search Favorites");
        eargs.font = GetAppFont();
        filterEdit->Create(eargs);
    }
    win->favFilterEdit = filterEdit;
    SetSidebarSearchMargins(filterEdit, parent);
    filterEdit->onTextChanged = MkFunc0(OnFavFilterTextChanged, win);
    SetWindowSubclass(filterEdit->hwnd, WndProcFavFilterEdit, NextSubclassId(), (DWORD_PTR)win);

    TreeView* treeView = CreateVirtualSidebarTree(SidebarTreeKind::Favorites, Tr("Favorites"));
    TreeView::CreateArgs args;
    args.parent = parent;
    args.font = GetAppTreeFont();
    args.fullRowSelect = true;
    args.exStyle = 0;
    args.isRtl = IsUIRtl();

    auto fn = MkFunc1Void(FavTreeContextMenu);
    treeView->onContextMenu = fn;
    treeView->onSelectionChanged = MkFunc1Void(FavTreeSelectionChanged);
    treeView->onKeyDown = MkFunc1Void(FavTreeKeyDown);
    treeView->onClick = MkFunc1Void(FavTreeItemClicked);
    treeView->onGetItemFont = MkFunc1Void(OnFavItemFont);
    treeView->onGetItemStyle = MkFunc1Void(OnFavItemStyle);

    treeView->Create(args);
    ReportIf(!treeView->hwnd);

    win->favTreeView = treeView;

    // the filter edit over the tree, which takes the remaining height
    auto* vbox = new VBox();
    vbox->alignMain = MainAxisAlign::MainStart;
    vbox->alignCross = CrossAxisAlign::Stretch;
    vbox->AddChild(PadSidebarItem(filterEdit, parent));
    vbox->AddChild(PadSidebarTree(treeView, parent), 1);
    win->favViewLayout = vbox;

    UpdateControlsColors(win);
}
