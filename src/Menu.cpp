/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/AutoWin.h"
#include "base/CmdLineArgs.h"
#include "base/File.h"
#include "gui/Dpi.h"
#include "base/Win.h"
#include "base/Pixmap.h"
#include "base/GdiPlusUtil.h"

#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/Gfx.h"
#include "gui/PlatformFont.h"
#include "gui/VirtCtrl.h"

#include "Settings.h"
#include "AppSettings.h"
#include "DisplayMode.h"
#include "DocController.h"
#include "EngineBase.h"
#include "base/GuessFileType.h"
#include "EngineAll.h"
#include "DisplayModel.h"
#include "FileHistory.h"
#include "Theme.h"
#include "Annotation.h"
#include "AnnotTextPopup.h"
#include "SumatraConfig.h"
#include "SumatraPDF.h"
#include "Canvas.h"
#include "MainWindow.h"
#include "AIChatTypes.h"
#include "WindowTab.h"
#include "Commands.h"
#include "ExternalViewers.h"
#include "Favorites.h"
#include "FileThumbnails.h"
#include "HomePage.h"
#include "Translations.h"
#include "Toolbar.h"
#include "PagePosition.h"
#include "resource.h"
#include "DarkMode.h"
#include "Tabs.h"
#include "Accelerators.h"
#include "ImageSaveCropResize.h"
#include "GoogleLens.h"
#include "CommandAvailability.h"
#include "ReadAloud.h"
#include "ReadingAutoScroll.h"
#include "ReadingBar.h"
#include "TableOfContents.h"
#include "SidebarPanel.h"
#include "SumatraControl.h"
#include "Menu.h"
#include "MenuCommon.h"
#include "MenuDefs.h"

static bool gAddCrashMeMenu = false;

// clang-format off
static MenuDef menuDefZoomShort[] = {
    {
        TrN("Fit &Page"),
        CmdZoomFitPage,
    },
    {
        TrN("&Actual Size"),
        CmdZoomActualSize,
    },
    {
        TrN("Fit &Width"),
        CmdZoomFitWidth,
    },
    {
        TrN("Fit &Height"),
        CmdZoomFitHeight,
    },
    {
        TrN("Fit by &Orientation"),
        CmdZoomFitByOrientation,
    },
    {
        TrN("Fit &Content"),
        CmdZoomFitContent,
    },
    {
        TrN("Fit &Visible"),
        CmdZoomFitVisible,
    },
    {
        TrN("&Shrink To Fit"),
        CmdZoomShrinkToFit,
    },
    {
        TrN("Custom &Zoom..."),
        CmdZoomCustom,
    },
    {
        TrN("&To Selection"),
        CmdZoomToSelection,
    },
    {
        StrL(kMenuSeparator),
        0,
    },
    {
        {},
        0,
    },
};

//[ ACCESSKEY_GROUP Context Menu (Selection)
static MenuDef menuDefSelection[] = {
    {
        TrN("&Copy To Clipboard"),
        CmdCopySelection,
    },
    {
        TrN("Copy As &Image To Clipboard"),
        CmdCopySelectionAsImage,
    },
    {
        TrN("&Save As Image..."),
        CmdSaveSelectionAsImage,
    },
    {
        TrN("&Print Selection..."),
        CmdPrintSelection,
    },
    {
        TrN("Visual Search With Google &Lens"),
        CmdSearchGoogleLens,
    },
    {
        TrN("&Zoom To Selection"),
        CmdZoomToSelection,
    },
    {
        TrN("&Trim Pages To Selection"),
        CmdTrimPagesToSelection,
    },
    {
        TrN("Count &Words"),
        CmdCountWords,
    },
    {
        TrN("Show Selected Te&xt"),
        CmdShowSelectedText,
    },
    {
        StrL(kMenuSeparator),
        kMenuSeparatorID,
    },
    {
        TrN("&Translate with"),
        (UINT_PTR)menuDefTranslateWith,
    },
    {
        TrN("S&earch with"),
        (UINT_PTR)menuDefSearchWith,
    },
    {
        TrN("Select C&urrent Page"),
        CmdSelectCurrentPage,
    },
    {
        TrN("Select &All"),
        CmdSelectAll,
    },
    {
        {},
        0,
    },
};
//] ACCESSKEY_GROUP Context Menu (Selection)

//[ ACCESSKEY_GROUP Context Menu (Main)
static MenuDef menuDefContext[] = {
    {
        TrN("S&election"),
        (UINT_PTR)menuDefSelection,
    },
    {
        TrN("Visual Search With Google &Lens"),
        (UINT_PTR)menuDefGoogleLens,
    },
    {
        TrN("Copy Link &Address"),
        CmdCopyLinkTarget,
    },
    {
        TrN("Copy Co&mment"),
        CmdCopyComment,
    },
    {
        TrN("Sho&w Comment"),
        CmdShowAnnotationText,
    },
    {
        TrN("Save Attachment"),
        CmdSaveAttachment,
    },
    {
        TrN("Selected &Image"),
        (UINT_PTR)menuDefContextImage,
    },
    // note: strings cannot be "" or else items are not there
    {
        StrL("Add to favorites"),
        CmdFavoriteAdd,
    },
    {
        StrL("Remove from favorites"),
        CmdFavoriteDel,
    },
    {
        TrN("Show &Favorites"),
        CmdFavoriteToggle,
    },
    {
        TrN("Show &Bookmarks"),
        CmdToggleBookmarks,
    },
    {
        TrN("Show &Thumbnails"),
        CmdToggleThumbnails,
    },
    {
        TrN("Sh&ow Toolbar"),
        CmdToggleToolbar,
    },
    {
        TrN("Show Caption"),
        CmdToggleCaption,
    },
    {
        TrN("Auto-hide Sidebar"),
        CmdToggleSidebarAutoHide,
    },
    {
        StrL(kMenuSeparator),
        kMenuSeparatorID,
    },
    {
        TrN("AI chat with document using"),
        (UINT_PTR)menuDefDocumentAIChat,
    },
    {
        TrN("Document"),
        (UINT_PTR)menuDefDocumentOperations,
    },
    {
        TrN("Read Aloud"),
        (UINT_PTR)menuDefContextReadAloud,
    },
    {
        TrN("Annotations"),
        (UINT_PTR)menuDefContextAnnotations,
    },
    {
        TrN("Show Errors"),
        CmdShowErrors,
    },
    {
        TrN("E&xit Fullscreen"),
        CmdToggleFullscreen, // only seen in full-screen mode
    },
    {
        {},
        0,
    },
};
//] ACCESSKEY_GROUP Context Menu (Main)

// clang-format on

// clang-format off
static int disableIfDirectoryOrBrokenPDF[] = {
    CmdRenameFile,
    CmdDeleteFile,
    CmdDeleteFileAndOpenNext,
    CmdSendByEmail,
    CmdOpenWithAcrobat,
    CmdOpenWithFoxit,
    CmdOpenWithPdfXchange,
    CmdShowInFolder, // TODO: why?
};

static UINT_PTR menusNoTranslate[] = {
    CmdZoom6400,
    CmdZoom3200,
    CmdZoom1600,
    CmdZoom800,
    CmdZoom400,
    CmdZoom200,
    CmdZoom150,
    CmdZoom125,
    CmdZoom100,
    CmdZoom50,
    CmdZoom25,
    CmdZoom12_5,
    CmdZoom8_33,
};
// clang-format on

#ifdef SOLOKPDF_PDFIUM

static MenuDef solokOpenOther[] = {
    {TrN("Open from &URL..."), CmdOpenFromURL},
    {StrL(kMenuSeparator)},
    {TrN("&Next File In Folder"), CmdOpenNextFileInFolder},
    {TrN("&Previous File In Folder"), CmdOpenPrevFileInFolder},
    {TrN("&Browse Files In Folder..."), CmdNavigateFilesInFolder},
    {},
};

static MenuDef solokOpenExternal[] = {
    {TrN("Open Directory in &Explorer"), CmdOpenWithExplorer},
    {TrN("Open Directory in Director&y Opus"), CmdOpenWithDirectoryOpus},
    {TrN("Open Directory in &Total Commander"), CmdOpenWithTotalCommander},
    {TrN("Open Directory in &Double Commander"), CmdOpenWithDoubleCommander},
    {TrN("Open in &Adobe Reader"), CmdOpenWithAcrobat},
    {TrN("Open in &Foxit Reader"), CmdOpenWithFoxit},
    {TrN("Open &in PDF-XChange"), CmdOpenWithPdfXchange},
    {TrN("Open in &Microsoft XPS-Viewer"), CmdOpenWithXpsViewer},
    {TrN("Open in Microsoft &HTML Help"), CmdOpenWithHtmlHelp},
    {TrN("Send &by E-mail..."), CmdSendByEmail},
    {},
};

static MenuDef solokFileManagement[] = {
    {TrN("Show in fo&lder"), CmdShowInFolder},
#ifdef ENABLE_SAVE_SHORTCUT
    {TrN("Save Shortc&ut..."), CmdCreateShortcutToFile},
#else
    {TrN("Re&name..."), CmdRenameFile},
#endif
    {TrN("Delete"), CmdDeleteFile},
    {TrN("Lin&k SumatraPDF Web..."), CmdSumatraPDFWeb},
    {},
};

static MenuDef solokFile[] = {
    {TrN("&Open..."), CmdOpenFile},
    {TrN("New &window"), CmdNewWindow},
    {TrN("&Close"), CmdClose},
    {TrN("&Save As..."), CmdSaveAs},
    {TrN("&Print..."), CmdPrint},
    {TrN("P&roperties"), CmdProperties},
    {StrL(kMenuSeparator)},
    {TrN("Other Ways to Open"), (UINT_PTR)solokOpenOther},
    {TrN("Open Externally or Send"), (UINT_PTR)solokOpenExternal},
    {TrN("File &Management"), (UINT_PTR)solokFileManagement},
    {StrL(kMenuSeparator)},
    {TrN("E&xit"), CmdExit},
    {},
};

static MenuDef solokPageView[] = {
    {TrN("Man&ga Mode"), CmdToggleMangaMode},
    {TrN("Auto-Rotate Wide Pages"), CmdToggleAutoRotateWidePages},
    {TrN("&Uniform Page Width"), CmdToggleUniformPageWidth},
    {TrN("&Trim Empty Margins"), CmdToggleTrimEmptyMargins},
    {TrN("Trim Pages To Selection"), CmdTrimPagesToSelection},
    {TrN("Show Whole Pages"), CmdShowWholePages},
    {TrN("Save Trimmed Pages As..."), CmdSaveTrimmedPagesAs},
    {TrN("Read &Columns"), CmdToggleReadColumns},
    {TrN("Read Columns: Show &Whole Page"), CmdToggleColumnsWholePage},
    {TrN("Mirror Pages"), CmdToggleMirror},
    {TrN("Read&ing Bar"), CmdToggleReadingBar},
    {TrN("&Highlight Form Fields"), CmdToggleHighlightFormFields},
    {TrN("Transparency Gri&d"), CmdToggleTransparencyGrid},
    {},
};

static MenuDef solokWindowLayout[] = {
    {TrN("Show Book&marks"), CmdToggleBookmarks},
    {TrN("Sho&w Thumbnails"), CmdToggleThumbnails},
    {TrN("Navigate Thumbnails"), CmdNavigateThumbnail},
    {TrN("Show Me&nu"), CmdToggleMenuBar},
    {TrN("Sh&ow Toolbar"), CmdToggleToolbar},
    {TrN("Show Caption"), CmdToggleCaption},
    {TrN("Auto-hide Sidebar"), CmdToggleSidebarAutoHide},
    {},
};

static MenuDef solokView[] = {
    {TrN("&Single Page"), CmdSinglePageView},
    {TrN("&Facing"), CmdFacingView},
    {TrN("&Book View"), CmdBookView},
    {TrN("Show &Pages Continuously"), CmdToggleContinuousView},
    {TrN("Fit &Width"), CmdZoomFitWidth},
    {TrN("Fit Page"), CmdZoomFitPage},
    {TrN("&Zoom"), (UINT_PTR)menuDefZoom},
    {StrL(kMenuSeparator)},
    {TrN("Rotate &Left"), CmdRotateLeft},
    {TrN("Rotate &Right"), CmdRotateRight},
    {TrN("Fulls&creen"), CmdToggleFullscreen},
    {TrN("Pr&esentation"), CmdTogglePresentationMode},
    {TrN("&Automatically Scroll"), CmdToggleAutomaticallyScroll},
    {StrL(kMenuSeparator)},
    {TrN("Page Display"), (UINT_PTR)solokPageView},
    {TrN("Window Layout"), (UINT_PTR)solokWindowLayout},
    {},
};

static MenuDef solokMeasure[] = {
    {TrN("Page Grid"), CmdTogglePageGrid},
    {TrN("Configure Page Grid..."), CmdConfigurePageGrid},
    {TrN("Measure"), CmdMeasure},
    {},
};

static MenuDef solokTools[] = {
    {TrN("Command Palette"), CmdCommandPalette},
    {TrN("S&election"), (UINT_PTR)menuDefMainSelection},
    {TrN("Read Aloud"), (UINT_PTR)menuDefReadAloud},
    {TrN("PDF Operations"), (UINT_PTR)menuDefDocumentOperations},
    {TrN("Measurement"), (UINT_PTR)solokMeasure},
    {TrN("AI chat with document using"), (UINT_PTR)menuDefDocumentAIChat},
    {},
};

static MenuDef solokAdvanced[] = {
    {TrN("&Open Advanced Settings File..."), CmdOpenSettingsFile},
    {TrN("Configure &Restricted Use..."), CmdConfigureRestrictedUse},
    {},
};

static MenuDef solokSettings[] = {
    {TrN("&Settings..."), CmdOptions},
    {TrN("&Theme"), (UINT_PTR)menuDefThemes},
    {TrN("Change Language"), CmdChangeLanguage},
    {TrN("Customize &Keyboard Shortcuts..."), CmdCustomizeShortcuts},
    {TrN("Use SumatraPDF File Picker"), CmdToggleFilePicker},
    {TrN("Vim Key Mode"), CmdToggleVimKeys},
    {TrN("Advanced"), (UINT_PTR)solokAdvanced},
    {},
};

static MenuDef solokDiagnostics[] = {
    {TrN("Toggle Render Queue Info"), CmdDebugToggleRenderInfo},
    {TrN("Toggle Cache Info"), CmdDebugToggleCacheInfo},
    {TrN("Show Errors"), CmdShowErrors},
    {},
};

static MenuDef solokHelp[] = {
    {TrN("&Manual"), CmdHelpOpenManual},
    {TrN("&Keyboard Shortcuts"), CmdHelpOpenKeyboardShortcuts},
    {TrN("&About"), CmdHelpAbout},
    {StrL(kMenuSeparator)},
    {TrN("Manual On Website"), CmdHelpOpenManualOnWebsite},
    {TrN("Visit &Website"), CmdHelpVisitWebsite},
    {TrN("Check for &Updates"), CmdCheckUpdate},
    {TrN("Diagnostics"), (UINT_PTR)solokDiagnostics},
    {},
};

static MenuDef solokFavorites[] = {
    {TrN("Add to favorites"), CmdFavoriteAdd},
    {TrN("Remove from favorites"), CmdFavoriteDel},
    {TrN("Show Favorites"), CmdFavoriteToggle},
    {TrN("Show Favorites in Tab"), CmdFavoriteShowInTab},
    {},
};

static MenuDef solokFavoritesMore[] = {
    {StrL(kMenuSeparator)},
    {TrN("Edit Favorites..."), CmdEditFavorites},
    {TrN("Tab Groups"), (UINT_PTR)menuDefTabGroups},
    {},
};

static MenuDef solokMenubar[] = {
    {TrN("&File"), (UINT_PTR)solokFile},
    {TrN("&View"), (UINT_PTR)solokView},
    {TrN("&Go To"), (UINT_PTR)menuDefGoTo},
    {TrN("F&avorites"), (UINT_PTR)solokFavorites},
    {TrN("&Tools"), (UINT_PTR)solokTools},
    {TrN("&Settings"), (UINT_PTR)solokSettings},
    {TrN("&Help"), (UINT_PTR)solokHelp},
    {StrL("Debug"), (UINT_PTR)menuDefDebug},
    {},
};

static MenuDef solokContextSelection[] = {
    {TrN("&Print Selection..."), CmdPrintSelection},
    {TrN("Visual Search With Google &Lens"), CmdSearchGoogleLens},
    {TrN("&Zoom To Selection"), CmdZoomToSelection},
    {TrN("Trim Pages To &Selection"), CmdTrimPagesToSelection},
    {TrN("Count &Words"), CmdCountWords},
    {TrN("Show Selected Te&xt"), CmdShowSelectedText},
    {StrL(kMenuSeparator)},
    {TrN("&Translate with"), (UINT_PTR)menuDefTranslateWith},
    {TrN("S&earch with"), (UINT_PTR)menuDefSearchWith},
    {TrN("Select C&urrent Page"), CmdSelectCurrentPage},
    {TrN("Select &All"), CmdSelectAll},
    {},
};

static MenuDef solokContextImage[] = {
    {TrN("Visual Search With Google &Lens"), CmdSearchGoogleLensImage},
    {TrN("C&rop"), CmdCropImage},
    {TrN("R&esize"), CmdResizeImage},
    {TrN("Replace &Image..."), CmdReplaceImage},
    {TrN("Edit Image in &Another App"), CmdEditImageExternally},
    {TrN("Convert page to &PDF"), CmdConvertImageToPdf},
    {},
};

static MenuDef solokPageLens[] = {
    {TrN("&Page"), CmdSearchGoogleLensPage},
    {},
};

static MenuDef solokContext[] = {
    {TrN("E&xit Fullscreen"), CmdToggleFullscreen},
    {TrN("&Copy To Clipboard"), CmdCopySelection},
    {TrN("&Highlight"), CmdCreateAnnotHighlight},
    {TrN("Copy As &Image To Clipboard"), CmdCopySelectionAsImage},
    {TrN("&Save As Image..."), CmdSaveSelectionAsImage},
    {TrN("Copy Link &Address"), CmdCopyLinkTarget},
    {TrN("Save Attachment"), CmdSaveAttachment},
    {TrN("Copy Image"), CmdCopyImage},
    {TrN("Save Image..."), CmdSaveImage},
    {TrN("Sho&w Comment"), CmdShowAnnotationText},
    {TrN("Copy Co&mment"), CmdCopyComment},
    {StrL("Add to favorites"), CmdFavoriteAdd},
    {StrL("Remove from favorites"), CmdFavoriteDel},
    {StrL(kMenuSeparator)},
    {TrN("Selection Actions"), (UINT_PTR)solokContextSelection},
    {TrN("Image Actions"), (UINT_PTR)solokContextImage},
    {TrN("Annotations"), (UINT_PTR)menuDefContextAnnotations},
    {TrN("Read Aloud"), (UINT_PTR)menuDefContextReadAloud},
    {TrN("Visual Search With Google &Lens"), (UINT_PTR)solokPageLens},
    {},
};

static MenuDef solokCloseTabs[] = {
    {TrN("Close Other Tabs"), CmdCloseOtherTabs},
    {TrN("Close Tabs To The Right"), CmdCloseTabsToTheRight},
    {TrN("Close Tabs To The Left"), CmdCloseTabsToTheLeft},
    {TrN("Close All Tabs"), CmdCloseAllTabs},
    {},
};

static MenuDef solokDuplicateTab[] = {
    {TrN("In New Window"), CmdDuplicateInNewWindow},
    {TrN("In New Tab"), CmdDuplicateInNewTab},
    {},
};

static MenuDef solokTabDetails[] = {
    {TrN("Properties..."), CmdProperties},          {TrN("Copy File Path"), CmdCopyFilePath},
    {TrN("Change Tab Color"), CmdSetTabColor},      {TrN("Save Tab Group"), CmdTabGroupSave},
    {TrN("Restore Tab Group"), CmdTabGroupRestore}, {},
};

static MenuDef solokTab[] = {
    {TrN("Close"), CmdClose},
    {TrN("Duplicate"), (UINT_PTR)solokDuplicateTab},
    {TrN("Show in folder"), CmdShowInFolder},
    {TrN("&Save changes to existing PDF"), CmdSaveAnnotations},
    {TrN("Save changes to &new PDF"), CmdSaveAnnotationsNewFile},
    {TrN("&Discard changes"), CmdDiscardChanges},
    {StrL(kMenuSeparator)},
    {TrN("Close Multiple Tabs"), (UINT_PTR)solokCloseTabs},
    {TrN("Tab Details"), (UINT_PTR)solokTabDetails},
    {},
};

static MenuDef solokTocExpand[] = {
    {TrN("Expand All"), CmdExpandAll},
    {TrN("Collapse All"), CmdCollapseAll},
    {TrN("Expand to Level 1"), CmdTocExpandToLevel1},
    {TrN("Expand to Level 2"), CmdTocExpandToLevel2},
    {TrN("Expand to Level 3"), CmdTocExpandToLevel3},
    {TrN("Collapse Same Level"), CmdTocCollapseSameLevel},
    {TrN("Expand to Current Page"), CmdExpandToCurrentPage},
    {},
};

static MenuDef solokToc[] = {
    {TrN("Expand Chapter"), CmdTocExpandChapter},   {TrN("Collapse Chapter"), CmdTocCollapseChapter},
    {TrN("Open Embedded PDF"), CmdOpenEmbeddedPDF}, {TrN("Save Embedded File..."), CmdSaveEmbeddedFile},
    {TrN("Open Attachment"), CmdOpenAttachment},    {TrN("Save Attachment..."), CmdSaveAttachment},
    {StrL("Add to favorites"), CmdFavoriteAdd},     {StrL("Remove from favorites"), CmdFavoriteDel},
    {TrN("Expand"), (UINT_PTR)solokTocExpand},      {},
};

static MenuDef solokFavorite[] = {
    {TrN("Edit Favorites..."), CmdEditFavorites},
    {TrN("Remove from favorites"), CmdFavoriteDel},
    {StrL(kMenuSeparator)},
    {TrN("Sort By Name"), CmdToggleFavoritesSort},
    {},
};

static MenuDef solokHome[] = {
    {TrN("&Open Document"), CmdOpenSelectedDocument},
    {TrN("&Pin Document"), CmdPinSelectedDocument},
    {TrN("&Remove From History"), CmdForgetSelectedDocument},
    {StrL(kMenuSeparator)},
    {TrN("Show in folder"), CmdShowInFolder},
    {TrN("Delete File"), CmdDeleteFile},
    {},
};

static Str SolokMenuTitle(Str title) {
    if (str::Eq(trans::GetCurrentLangCode(), StrL("ja"))) {
        static const struct {
            Str en;
            Str ja;
        } labels[] = {
            {StrL("&Tools"), StrL("ツール(&T)")},
            {StrL("Other Ways to Open"), StrL("他の方法で開く")},
            {StrL("Open Externally or Send"), StrL("外部で開く・送る")},
            {StrL("File &Management"), StrL("ファイル管理(&M)")},
            {StrL("Fit Page"), StrL("ページに合わせる")},
            {StrL("Page Display"), StrL("ページ表示")},
            {StrL("Window Layout"), StrL("画面構成")},
            {StrL("PDF Operations"), StrL("PDF操作")},
            {StrL("Measurement"), StrL("計測")},
            {StrL("Advanced"), StrL("詳細設定")},
            {StrL("Diagnostics"), StrL("診断")},
            {StrL("Selection Actions"), StrL("選択の操作")},
            {StrL("Trim Pages To &Selection"), StrL("選択範囲に合わせてページを切り抜く(&S)")},
            {StrL("Image Actions"), StrL("画像の操作")},
            {StrL("Copy Image"), StrL("画像をコピー")},
            {StrL("Save Image..."), StrL("画像を保存…")},
            {StrL("Replace &Image..."), StrL("画像を置換…(&I)")},
            {StrL("Close Multiple Tabs"), StrL("まとめて閉じる")},
            {StrL("Tab Details"), StrL("タブの詳細")},
            {StrL("Expand"), StrL("展開")},
        };
        for (const auto& label : labels) {
            if (str::Eq(title, label.en)) {
                return label.ja;
            }
        }
    }
    return trans::GetTranslation(title);
}

static MenuDef* GetLiveMenuDef(HMENU menu) {
    MENUINFO info{sizeof(info), MIM_MENUDATA};
    GetMenuInfo(menu, &info);
    return (MenuDef*)info.dwMenuData;
}

static void SetLiveMenuDef(HMENU menu, MenuDef* def) {
    MENUINFO info{sizeof(info), MIM_MENUDATA};
    info.dwMenuData = (ULONG_PTR)def;
    SetMenuInfo(menu, &info);
}

static void ClearMenuTree(HMENU menu) {
    while (DeleteMenu(menu, 0, MF_BYPOSITION)) {
    }
}

static void PruneMenuTree(HMENU menu) {
    for (int i = GetMenuItemCount(menu) - 1; i >= 0; i--) {
        HMENU sub = GetSubMenu(menu, i);
        if (!sub) {
            continue;
        }
        PruneMenuTree(sub);
        if (GetMenuItemCount(sub) == 0) {
            DeleteMenu(menu, i, MF_BYPOSITION);
        }
    }
    RemoveBadMenuSeparators(menu);
}

static void BuildMenuZoom(HMENU menu);

static bool IsLiveMenuDef(MenuDef* def) {
    return def == solokFile || def == solokView || def == menuDefGoTo || def == solokFavorites || def == solokTools ||
           def == solokHelp || def == menuDefZoom || def == menuDefReadAloud || def == menuDefContextReadAloud;
}
#endif

#define cmdIdInList(name) CmdIdInList(cmdId, name, dimof(name))

static void AddFileMenuItem(HMENU menuFile, const FileHistoryEntry& fe, int index) {
    ReportIf(!menuFile);
    if (!menuFile) {
        return;
    }

    TempStr menuString = path::GetBaseNameTemp(fe.path);
    // shorten very long file names so that menu isn't too wide
    const int kMaxRunes = 70;
    menuString = ShortenStringUtf8InTheMiddleTemp(menuString, kMaxRunes);

    TempStr fileName = MenuToSafeStringTemp(menuString);
    int menuIdx = (index + 1) % 10;
    menuString = fmt("&%d) %s", menuIdx, fileName);
    uint flags = MF_BYCOMMAND | MF_ENABLED | MF_STRING;
    InsertMenuW(menuFile, CmdExit, flags, (uint)fe.cmdId, CWStrTemp(menuString));
}

static void AppendRecentFilesToMenu(HMENU m) {
    if (!CanAccessDisk()) {
        return;
    }

    Vec<FileHistoryEntry> files;
    for (int i = 0; i < kFileHistoryMaxRecent; i++) {
        FileState* fs = FileHistoryGet(i);
        if (!fs || fs->isMissing) {
            break;
        }
        Str fp = fs->filePath;
        if (len(fp) == 0) {
            // comes from settings file so can be missing due to user modifications
            continue;
        }
        VecAppend(files, FileHistoryEntry{fp, 0});
    }
    if (len(files) == 0) {
        return;
    }

    SetFileHistoryCmdIds(files);
    for (int i = 0; i < len(files); i++) {
        AddFileMenuItem(m, files[i], i);
    }

    InsertMenuW(m, CmdExit, MF_BYCOMMAND | MF_SEPARATOR, 0, nullptr);
}

static void AppendCommandsToMenu(HMENU m, const Vec<CustomCommand*>& cmds, bool isEnabled) {
    for (CustomCommand* cmd : cmds) {
        if (len(cmd->name) == 0) {
            continue;
        }
        TempStr menuString = cmd->name;
        int cmdId = cmd->id;
        menuString = AppendAccelKeyToMenuStringTemp(menuString, cmdId);
        UINT flags = MF_STRING;
        flags |= isEnabled ? MF_ENABLED : MF_DISABLED;
        WCHAR* ws = CWStrTemp(menuString);
        AppendMenuW(m, flags, (UINT_PTR)cmd->id, ws);
    }
}

static void AppendThemesToMenu(HMENU m) {
    Vec<CustomCommand*> cmds;
    GetCommandsWithOrigId(cmds, CmdSetTheme);
    AppendCommandsToMenu(m, cmds, true);
}

static void AppendSelectionHandlersToMenu(HMENU m, bool isEnabled) {
    Vec<CustomCommand*> cmds;
    GetCommandsWithOrigId(cmds, CmdSelectionHandler);
    AppendCommandsToMenu(m, cmds, isEnabled);
}

// TextSnippets: one is an item of its own, several get a submenu
static void AppendTextSnippetsToMenu(HMENU m) {
    Vec<CustomCommand*> cmds;
    GetCommandsWithOrigId(cmds, CmdInsertTextSnippet);
    if (len(cmds) < 2) {
        AppendCommandsToMenu(m, cmds, true);
        return;
    }
    HMENU sub = CreatePopupMenu();
    AppendCommandsToMenu(sub, cmds, true);
    AppendMenuW(m, MF_POPUP | MF_ENABLED, (UINT_PTR)sub, ToWStrTemp(Tr("Insert Te&xt")).s);
}

static void AppendExternalViewersToMenu(HMENU menuFile, Str filePath) {
    if (!CanAccessDisk() || (filePath && !file::Exists(filePath))) {
        return;
    }
    Vec<CustomCommand*> cmds;
    GetCommandsWithOrigId(cmds, CmdViewWithExternalViewer);
    for (CustomCommand* cmd : cmds) {
        Str commandLine = GetCommandStringArg(cmd, kCmdArgCommandLine, {});
        Str filter = GetCommandStringArg(cmd, kCmdArgFilter, {});
        if (str::IsEmptyOrWhiteSpace(commandLine)) {
            continue;
        }
        if (filter && !(filePath && PathMatchFilter(filePath, filter))) {
            continue;
        }
        TempStr name = cmd->name;
        if (str::IsEmptyOrWhiteSpace(cmd->name)) {
            if (str::IsEmptyOrWhiteSpace(name)) {
                StrNode* args = ParseCmdLine(ToWStrTemp(commandLine));
                AutoFreeStrNode freeArgs(args);
                StrNode* arg0 = args;
                for (int i = 0; arg0 && i < 2; i++) {
                    arg0 = arg0->next;
                }
                int nArgs = 0;
                for (StrNode* n = arg0; n; n = n->next) {
                    nArgs++;
                }
                if (nArgs <= 0) {
                    continue;
                }
                name = path::GetBaseNameTemp(arg0->s);
                int dotPos = str::IndexOfChar(name, '.');
                if (dotPos >= 0) {
                    name = str::DupTemp(Str(name.s, dotPos));
                }
            }
        }
        // TempStr menuString = fmt(Tr("Open in %s"), name);
        TempStr menuString = name;
        int cmdId = cmd->id;
        menuString = AppendAccelKeyToMenuStringTemp(menuString, cmdId);
        WCHAR* ws = CWStrTemp(menuString);
        InsertMenuW(menuFile, cmdId, MF_BYCOMMAND | MF_ENABLED | MF_STRING, (UINT_PTR)cmdId, ws);
        if (len(filePath) == 0) {
            MenuSetEnabled(menuFile, cmdId, false);
        }
    }
}

// shows duplicate separator if no external viewers
static void RemoveMissingViewers(HMENU menu, BuildMenuCtx* ctx) {
    // Suppress menu items that depend on specific software being installed:
    // e-mail client, Adobe Reader, Foxit, PDF-XChange
    // Don't hide items here that won't always be hidden
    // (MenuUpdateStateForWindow() is for that)
    for (int i = 0; gOpenWithKnownExternalViewerCmds[i]; i++) {
        int cmdId = gOpenWithKnownExternalViewerCmds[i];
        bool remove, disable;
        GetCommandIdState(ctx, cmdId, &remove, &disable);
        if (remove || disable) {
            MenuRemove(menu, cmdId);
        }
    }
}

static void DynamicPartOfFileMenu(HMENU menu, BuildMenuCtx* ctx) {
    AppendRecentFilesToMenu(menu);
    RemoveMissingViewers(menu, ctx);
}

void RemoveBadMenuSeparators(HMENU menu) {
    int nMenus;
    // remove separator items at the beginning
again1:
    nMenus = GetMenuItemCount(menu);
    if (nMenus == 0) {
        return;
    }
    UINT id = GetMenuItemID(menu, 0);
    if (id == kMenuSeparatorID) {
        RemoveMenu(menu, 0, MF_BYPOSITION);
        goto again1;
    }
    // remove separator items at the end
again2:
    nMenus = GetMenuItemCount(menu);
    if (nMenus == 0) {
        return;
    }
    id = GetMenuItemID(menu, nMenus - 1);
    if (id == kMenuSeparatorID) {
        RemoveMenu(menu, nMenus - 1, MF_BYPOSITION);
        goto again2;
    }
    // remove 2 or more consequitive separator items
again3:
    nMenus = GetMenuItemCount(menu);
    for (int i = 1; i < nMenus; i++) {
        id = GetMenuItemID(menu, i);
        UINT idPrev = GetMenuItemID(menu, i - 1);
        if ((id == idPrev) && (id == kMenuSeparatorID)) {
            RemoveMenu(menu, i, MF_BYPOSITION);
            goto again3;
        }
    }
}

static void MenuSetEnabledForDocumentCommands(HMENU menu, bool hasDocument) {
    for (int cmdId = (int)CmdFirst; cmdId <= (int)CmdLast; cmdId++) {
#ifdef SOLOKPDF_PDFIUM
        if (cmdId == CmdFavoriteAdd || cmdId == CmdFavoriteDel) {
            continue;
        }
#endif
        if (!CmdWorksWithoutDocument(cmdId)) {
            MenuSetEnabled(menu, cmdId, hasDocument);
        }
    }
}

HMENU BuildMenuFromDef(MenuDef* menuDef, HMENU menu, BuildMenuCtx* ctx) {
    ReportIf(!menu);

#ifdef SOLOKPDF_PDFIUM
    if (menuDef == menuDefMenubar) {
        menuDef = solokMenubar;
    } else if (menuDef == menuDefContext) {
        menuDef = solokContext;
    } else if (menuDef == menuDefContextTab) {
        menuDef = solokTab;
    } else if (menuDef == menuDefContextToc) {
        menuDef = solokToc;
    } else if (menuDef == menuDefContextFav) {
        menuDef = solokFavorite;
    } else if (menuDef == menuDefContextStart) {
        menuDef = solokHome;
    }
    if (IsLiveMenuDef(menuDef)) {
        SetLiveMenuDef(menu, menuDef);
    }
#endif

    bool isDebugMenu = menuDef == menuDefDebug;
    int i = 0;

    if (menuDef == menuDefThemes) {
        AppendThemesToMenu(menu);
    }

    bool addExternalViewersNext = false;
    while (true) {
        MenuDef md = menuDef[i];
        if (len(md.title) == 0) { // sentinel
            break;
        }
        i++;

        if (addExternalViewersNext && ctx) {
            // append user external viewers after menu item with CmdOpenWithHtmlHelp
            WindowTab* tab = ctx->tab;
            Str path = tab ? tab->filePath : Str{};
            AppendExternalViewersToMenu(menu, path);
            addExternalViewersNext = false;
        }

        int cmdId = (int)md.idOrSubmenu;

        if (cmdId == CmdOpenWithHtmlHelp) {
            addExternalViewersNext = true;
        }

        // TextSnippets go right after Free Text
        bool snippetsHere = menuDef == menuDefCreateAnnotUnderCursor && md.idOrSubmenu == CmdAnnotationHighlightBrush;
        if (snippetsHere && ctx && ctx->supportsAnnots) {
            AppendTextSnippetsToMenu(menu);
        }

        // custom selection handlers go before the built-in translate / search submenus
        if (md.idOrSubmenu == (UINT_PTR)menuDefTranslateWith) {
            // handlers run on selected text; comics and images have none
            bool canSelectText = !ctx || !ctx->isImageCollection;
#ifdef SOLOKPDF_PDFIUM
            canSelectText &= HasPermission(Perm::CopySelection);
#endif
            if (canSelectText && menuDef == menuDefMainSelection) {
                AppendSelectionHandlersToMenu(menu, true);
            } else if (canSelectText && menuDef == menuDefSelection) {
                AppendSelectionHandlersToMenu(menu, ctx ? ctx->hasSelection : false);
            }
#ifdef SOLOKPDF_PDFIUM
            if (canSelectText && menuDef == solokContextSelection && ctx && ctx->hasTextSelection &&
                HasPermission(Perm::CopySelection)) {
                AppendSelectionHandlersToMenu(menu, true);
            }
#endif
        }

        MenuDef* subMenuDef = (MenuDef*)md.idOrSubmenu;
        // hacky but works: small number is command id, large is submenu (a pointer)
        bool isSubMenu = md.idOrSubmenu > CmdLast + 10000;

        // handle separators before command state checks
        // (separators have idOrSubmenu=0 which would match the 0 sentinel in removal lists)
        if (str::Eq(md.title, StrL(kMenuSeparator))) {
            AppendMenuW(menu, MF_SEPARATOR, kMenuSeparatorID, nullptr);
            continue;
        }

        // Only real commands have a command-state. For submenu entries cmdId is a
        // truncated pointer (garbage), so don't run it through GetCommandIdState:
        // the no-document gate (and negative truncations) would wrongly remove the
        // whole submenu, leaving e.g. an empty menu bar on the home page. Submenu
        // visibility is decided by the explicit checks below and the emptiness
        // check after the submenu is built.
        bool removeMenu = false;
        bool disableMenu = false;
        // a null ctx means "don't auto-gate commands" -- the caller (e.g. the
        // ToC / Favorites context menus) does its own per-item filtering and
        // wants all items present. With an empty ctx, GetCommandIdState's
        // no-document gate would wrongly strip document-dependent commands.
        if (!isSubMenu && ctx) {
            GetCommandIdState(ctx, cmdId, &removeMenu, &disableMenu);
        }
        if (ctx) {
            removeMenu |= !ctx->isCursorOnPage && (subMenuDef == menuDefCreateAnnotUnderCursor);
            // these annotations need text to mark up, except Highlight, which can
            // fill a drawn rectangle
            bool canMarkUp = ctx->hasTextSelection || ctx->hasDrawnRectSelection;
            removeMenu |= (!canMarkUp || !ctx->supportsAnnots) && (subMenuDef == menuDefCreateAnnotFromSelection);
            // in the context menu only show translate / search items for a text
            // selection (the menubar variant is live-updated via
            // SetMenuStateForSelection instead)
            bool isTextSelSubMenu = (subMenuDef == menuDefTranslateWith) || (subMenuDef == menuDefSearchWith);
            removeMenu |= (menuDef == menuDefSelection) && !ctx->hasTextSelection && isTextSelSubMenu;
            bool isRectSel = ctx->hasSelection && !ctx->hasTextSelection;
            if (menuDef == menuDefSelection) {
                removeMenu |= !ctx->hasSelection && cmdId == CmdCopySelection;
                if (!isRectSel) {
                    removeMenu |= cmdId == CmdCopySelectionAsImage || cmdId == CmdSaveSelectionAsImage ||
                                  cmdId == CmdPrintSelection || cmdId == CmdSearchGoogleLens ||
                                  cmdId == CmdZoomToSelection;
                }
            }
            if (menuDef == menuDefGoogleLens) {
                removeMenu |= cmdId == CmdSearchGoogleLens && !ctx->hasSelection;
                removeMenu |= cmdId == CmdSearchGoogleLensPage && !ctx->isCursorOnPage;
                bool onImage = ctx->cursorOnImage || ctx->engineKind == kindEngineImage;
                removeMenu |= cmdId == CmdSearchGoogleLensImage && !onImage;
            }
        }
#ifdef SOLOKPDF_PDFIUM
        if (menuDef == menuDefZoom || menuDef == menuDefZoomShort) {
            removeMenu |= cmdId == CmdZoomFitPage || cmdId == CmdZoomFitWidth;
        }
        bool canCopy = HasPermission(Perm::CopySelection);
        if (!canCopy) {
            removeMenu |= cmdId == CmdCopySelection || cmdId == CmdShowSelectedText;
            removeMenu |= subMenuDef == menuDefTranslateWith || subMenuDef == menuDefSearchWith;
        }
        if (ctx && menuDef == solokContext) {
            removeMenu |= cmdId == CmdCopySelection && !ctx->hasTextSelection;
            removeMenu |= cmdId == CmdCreateAnnotHighlight && !ctx->hasTextSelection;
            removeMenu |= !ctx->isCursorOnPage &&
                          (subMenuDef == menuDefContextAnnotations || subMenuDef == menuDefContextReadAloud);
            removeMenu |= subMenuDef == menuDefContextReadAloud && (!ctx->ttsAvailable || ctx->isImageCollection);
        }
        if (ctx && menuDef == solokContextSelection) {
            bool isRect = ctx->hasSelection && !ctx->hasTextSelection;
            bool isTextAction = subMenuDef == menuDefTranslateWith || subMenuDef == menuDefSearchWith;
            removeMenu |= isTextAction && !ctx->hasTextSelection;
            removeMenu |= (cmdId == CmdSearchGoogleLens || cmdId == CmdZoomToSelection) && !isRect;
            removeMenu |= cmdId == CmdSelectCurrentPage && !ctx->isCursorOnPage;
        }
        if (ctx && menuDef == menuDefCreateAnnotFromSelection && ctx->hasTextSelection) {
            removeMenu |= cmdId == CmdCreateAnnotHighlight;
        }
#endif
        removeMenu |= ((subMenuDef == menuDefDebug) && !ShowDebugMenu());
        // without Annotations.SignatureImage it would just be Insert Image
        removeMenu |= !isSubMenu && cmdId == CmdSignWithImage && len(gSettings->annotations.signatureImage) == 0;
        if (removeMenu) {
            continue;
        }

        bool noTranslate = isDebugMenu || cmdIdInList(menusNoTranslate);
        noTranslate |= (subMenuDef == menuDefDebug);
        Str title = md.title;
        if (!noTranslate) {
#ifdef SOLOKPDF_PDFIUM
            title = SolokMenuTitle(md.title);
#else
            title = Str(trans::GetTranslation(md.title));
#endif
        }

        if (isSubMenu) {
            HMENU subMenu = BuildMenuFromDef(subMenuDef, CreatePopupMenu(), ctx);
            if (GetMenuItemCount(subMenu) == 0) {
                DestroyMenu(subMenu);
                continue;
            }
            UINT flags = MF_POPUP | (disableMenu ? MF_DISABLED : MF_ENABLED);
            if (subMenuDef == menuDefFile) {
                DynamicPartOfFileMenu(subMenu, ctx);
            }
#ifdef SOLOKPDF_PDFIUM
            if (subMenuDef == menuDefZoom) {
                BuildMenuZoom(subMenu);
            }
#else
            if (subMenuDef == menuDefReadAloud) {
                SetReadAloudAppSubmenu(subMenu);
            }
            if (subMenuDef == menuDefContextReadAloud) {
                SetReadAloudContextSubmenu(subMenu);
            }
#endif
            WCHAR* ws = CWStrTemp(title);
            AppendMenuW(menu, flags, (UINT_PTR)subMenu, ws);
        } else {
            // Ctrl+C / Ctrl+V are bound to CmdCopySelection and
            // CmdPasteClipboardImage, which hand off to these when an
            // annotation is what there is to copy or paste. Show the key the
            // user actually presses rather than nothing.
            int accelCmdId = cmdId;
            if (cmdId == CmdCopyAnnotation) {
                accelCmdId = CmdCopySelection;
            } else if (cmdId == CmdPasteAnnotation) {
                accelCmdId = CmdPasteClipboardImage;
            }
            title = AppendAccelKeyToMenuStringTemp(title, accelCmdId);
            UINT flags = MF_STRING | (disableMenu ? MF_DISABLED : MF_ENABLED);
            WCHAR* ws = CWStrTemp(title);
            AppendMenuW(menu, flags, md.idOrSubmenu, ws);
        }
    }
#ifdef SOLOKPDF_PDFIUM
    if (menuDef == solokFile) {
        AppendRecentFilesToMenu(menu);
    }
    if (menuDef == solokOpenExternal) {
        RemoveMissingViewers(menu, ctx);
    }
#endif
    RemoveBadMenuSeparators(menu);
    return menu;
}

static void BuildMenuZoom(HMENU m) {
    auto* prefs = gSettings;
    auto* customZoomLevels = prefs->zoomLevels;
    int n = len(*customZoomLevels);
    if (n <= 0) {
        return;
    }
    MenuEmpty(m);
    TempStr title;
    int cmdId;
    BuildMenuFromDef(menuDefZoomShort, m, nullptr);
    for (int i = 0; i < n; i++) {
        int idx = n - i - 1; // largest first
        float zl = (*customZoomLevels)[idx];
        cmdId = (*prefs->zoomLevelsCmdIds)[idx];
        title = ZoomLevelStr(zl);
        title = AppendAccelKeyToMenuStringTemp(title, cmdId);
        UINT flags = MF_STRING | MF_ENABLED;
        WCHAR* ws = CWStrTemp(title);
        AppendMenuW(m, flags, cmdId, ws);
    }
}

// Custom ZoomLevels menu items use dynamically allocated command ids (not in
// CmdZoomFirst..CmdZoomLast). Map an absolute zoom % to that custom id, or 0.
static int CustomZoomCmdIdFromLevel(float zoomVirtual) {
    auto* prefs = gSettings;
    if (!prefs || !prefs->zoomLevels || !prefs->zoomLevelsCmdIds) {
        return 0;
    }
    int n = len(*prefs->zoomLevels);
    if (n <= 0 || len(*prefs->zoomLevelsCmdIds) != n) {
        return 0;
    }
    // same fuzz as DisplayModel::GetNextZoomStep
    constexpr float kZoomFuzz = 0.01f;
    for (int i = 0; i < n; i++) {
        float zl = (*prefs->zoomLevels)[i];
        if (zoomVirtual + kZoomFuzz >= zl && zoomVirtual - kZoomFuzz <= zl) {
            return (*prefs->zoomLevelsCmdIds)[i];
        }
    }
    return 0;
}

static void ZoomMenuItemCheck(HMENU m, int cmdId, bool canZoom) {
    for (int zi = 0; zi < gZoomMenuIdsCount; zi++) {
        auto&& it = gZoomMenuIds[zi];
        MenuSetEnabled(m, it.cmdId, canZoom);
    }

    auto* prefs = gSettings;
    Vec<int>* customIds = prefs ? prefs->zoomLevelsCmdIds : nullptr;
    int nCustom = customIds ? len(*customIds) : 0;
    for (int i = 0; i < nCustom; i++) {
        MenuSetEnabled(m, (*customIds)[i], canZoom);
    }

    // Uncheck all fixed zoom menu commands in the radio range
    for (int zi = 0; zi < gZoomMenuIdsCount; zi++) {
        auto&& it = gZoomMenuIds[zi];
        MenuSetChecked(m, it.cmdId, false);
    }
    // Uncheck all custom ZoomLevels commands (ids are not a contiguous radio range)
    for (int i = 0; i < nCustom; i++) {
        MenuSetChecked(m, (*customIds)[i], false);
    }

    if (!canZoom || cmdId == 0) {
        return;
    }

    // Fixed Fit*/Actual Size / built-in percentage commands
    if (cmdId >= CmdZoomFirst && cmdId <= CmdZoomLast) {
        if (CmdZoom100 == cmdId) {
            cmdId = CmdZoomActualSize;
        }
#ifdef SOLOKPDF_PDFIUM
        MenuSetChecked(m, cmdId, true);
        if (cmdId == CmdZoomActualSize) {
            MenuSetChecked(m, CmdZoom100, true);
        }
#else
        CheckMenuRadioItem(m, CmdZoomFirst, CmdZoomLast, cmdId, MF_BYCOMMAND);
        if (CmdZoomActualSize == cmdId) {
            // also mark 100% when present in the default menu
            CheckMenuRadioItem(m, CmdZoom100, CmdZoom100, CmdZoom100, MF_BYCOMMAND);
        }
#endif
        return;
    }

    // Custom ZoomLevels percentage entry (issue #5832)
    MenuSetChecked(m, cmdId, true);
    // When at 100%, also mark "Actual Size" if present
    if (nCustom > 0) {
        int id100 = CustomZoomCmdIdFromLevel(100.0f);
        if (id100 != 0 && id100 == cmdId) {
            MenuSetChecked(m, CmdZoomActualSize, true);
        }
    }
}

static void MenuUpdateZoom(MainWindow* win, HMENU menu) {
    float zoomVirtual = gSettings->defaultZoomFloat;
    if (win->IsDocLoaded()) {
        zoomVirtual = win->ctrl->GetZoomVirtual();
    }

    int menuId = 0;
    // Prefer custom ZoomLevels command ids when that menu is active (issue #5832).
    // Fit/virtual zooms still use fixed CmdZoomFit* ids.
    if (zoomVirtual > 0) {
        menuId = CustomZoomCmdIdFromLevel(zoomVirtual);
    }
    if (menuId == 0) {
        menuId = CmdIdFromVirtualZoom(zoomVirtual);
    }
    ZoomMenuItemCheck(menu, menuId, win->IsDocLoaded());
}

static void MenuUpdatePrintItem(MainWindow* win, HMENU menu, bool disableOnly = false) {
    bool filePrintEnabled = win->IsDocLoaded();
#ifdef DISABLE_DOCUMENT_RESTRICTIONS
    bool filePrintAllowed = true;
#else
    bool filePrintAllowed = !filePrintEnabled || !win->AsFixed() || win->AsFixed()->GetEngine()->AllowsPrinting();
#endif

    for (MenuDef* defp = menuDefFile; len(defp->title) > 0 || defp->idOrSubmenu != 0; defp++) {
        MenuDef& def = *defp;
        if (def.idOrSubmenu != CmdPrint) {
            continue;
        }
        TempStr printItem = trans::GetTranslation(def.title);
        if (!filePrintAllowed) {
            printItem = Tr("&Print... (denied)");
        } else {
            printItem = AppendAccelKeyToMenuStringTemp(printItem, CmdPrint);
        }
        if (!filePrintAllowed || !disableOnly) {
            WCHAR* ws = CWStrTemp(printItem);
            ModifyMenuW(menu, CmdPrint, MF_BYCOMMAND | MF_STRING, (UINT_PTR)CmdPrint, ws);
        }
        MenuSetEnabled(menu, CmdPrint, filePrintEnabled && filePrintAllowed);
    }
}

static void RebuildFileMenu(WindowTab* tab, HMENU menu) {
#ifdef SOLOKPDF_PDFIUM
    ClearMenuTree(menu);
    auto* def = solokFile;
#else
    MenuEmpty(menu);
    auto* def = menuDefFile;
#endif
    auto* ctx = NewBuildMenuCtx(tab);
    AutoDelete delCtx(ctx);
    BuildMenuFromDef(def, menu, ctx);
#ifndef SOLOKPDF_PDFIUM
    DynamicPartOfFileMenu(menu, ctx);
    RemoveBadMenuSeparators(menu);
#endif
}

static bool IsFileCloseMenuEnabled() {
    for (int i = 0; i < len(gWindows); i++) {
        if (gWindows[i]->IsDocLoaded()) {
            return true;
        }
    }
    return false;
}

static void SetMenuStateForSelection(WindowTab* tab, HMENU menu) {
    bool isTextSelected = tab && tab->win && tab->win->showSelection && tab->selectionOnPage;
    for (int i = 0; disableIfNoSelection[i]; i++) {
        MenuSetEnabled(menu, (int)disableIfNoSelection[i], isTextSelected);
    }
    auto* curr = gFirstCustomCommand;
    while (curr) {
        if (curr->origId == CmdSelectionHandler) {
            MenuSetEnabled(menu, curr->id, isTextSelected);
        }
        curr = curr->next;
    }
}

static void MenuUpdateDisplayMode(MainWindow* win, HMENU menu) {
    bool enabled = win->IsDocLoaded();
    DisplayMode displayMode = gSettings->defaultDisplayModeEnum;
    if (enabled) {
        displayMode = win->ctrl->GetDisplayMode();
    }

    for (int id = CmdViewLayoutFirst; id <= CmdViewLayoutLast; id++) {
        MenuSetEnabled(menu, id, enabled);
    }

    int id = 0;
    if (IsSingle(displayMode)) {
        id = CmdSinglePageView;
    } else if (IsFacing(displayMode)) {
        id = CmdFacingView;
    } else if (IsBookView(displayMode)) {
        id = CmdBookView;
    } else {
        ReportIf(win->ctrl || DisplayMode::Automatic != displayMode);
    }

    CheckMenuRadioItem(menu, CmdViewLayoutFirst, CmdViewLayoutLast, id, MF_BYCOMMAND);
    MenuSetChecked(menu, CmdToggleContinuousView, IsContinuous(displayMode));
    MenuSetChecked(menu, CmdToggleAutomaticallyScroll, ReadingAutoScrollIsOn(win));
    MenuSetChecked(menu, CmdToggleReadingBar, ReadingBarIsOn(win));
    MenuSetChecked(menu, CmdToggleReadingBarInvert, gSettings && gSettings->readingBar.invert);

    DisplayModel* dm = win->AsFixed();
    if (dm && win->CurrentTab()) {
        bool mangaMode = dm->GetDisplayR2L();
        MenuSetChecked(menu, CmdToggleMangaMode, mangaMode);
        MenuSetEnabled(menu, CmdToggleMangaMode, true);
        MenuSetChecked(menu, CmdToggleAutoRotateWidePages, gSettings->comicBookUI.autoRotateWidePages);
        MenuSetChecked(menu, CmdToggleUniformPageWidth, dm->GetUniformPageWidth());
        MenuSetEnabled(menu, CmdToggleUniformPageWidth, true);
        MenuSetChecked(menu, CmdToggleTrimEmptyMargins, dm->GetTrimEmptyMargins());
        MenuSetEnabled(menu, CmdToggleTrimEmptyMargins, true);
        MenuSetChecked(menu, CmdToggleMirror, dm->GetMirror());
        MenuSetEnabled(menu, CmdShowWholePages, !dm->GetUserCrop().IsEmpty());
        MenuSetEnabled(menu, CmdSaveTrimmedPagesAs, !dm->GetUserCrop().IsEmpty() || dm->GetTrimEmptyMargins());
        MenuSetChecked(menu, CmdToggleReadColumns, dm->GetReadColumns());
        MenuSetEnabled(menu, CmdToggleColumnsWholePage, dm->GetReadColumns());
        MenuSetChecked(menu, CmdToggleColumnsWholePage, dm->ShowsColumnsWholePage());
    }
}

static void MenuUpdateStateForWindow(MainWindow* win, HMENU menu) {
    WindowTab* tab = win->CurrentTab();

    bool hasDocument = tab && tab->IsDocLoaded();
    MenuSetEnabledForDocumentCommands(menu, hasDocument);

    SetMenuStateForSelection(tab, menu);
    MenuSetEnabled(menu, CmdClose, IsFileCloseMenuEnabled());

    MenuUpdatePrintItem(win, menu);

    bool enabled = win->IsDocLoaded() && tab && tab->ctrl->HasToc();
    MenuSetEnabled(menu, CmdToggleBookmarks, enabled);

    bool documentSpecific = win->IsDocLoaded();
    bool bookmarksShown = IsSidebarViewShown(win, SidebarView::Bookmarks);
    bool checked = documentSpecific ? bookmarksShown : gSettings->showToc;
    MenuSetChecked(menu, CmdToggleBookmarks, checked);
    MenuSetEnabled(menu, CmdToggleThumbnails, CanShowThumbnails(tab));
    MenuSetChecked(menu, CmdToggleThumbnails, IsSidebarViewShown(win, SidebarView::Thumbnails));

    MenuSetChecked(menu, CmdFavoriteToggle, IsSidebarViewShown(win, SidebarView::Favorites));
    MenuSetChecked(menu, CmdFavoriteShowInTab, FindFavoritesTab(win) != nullptr);
    {
        // checked when mode is not "hide" (show or overlay)
        bool toolbarOn =
            win->IsFullScreen() ? FullscreenToolbarModeFromPrefs() != kToolbarHide : !ToolbarModeIsHidden();
        MenuSetChecked(menu, CmdToggleToolbar, toolbarOn);
    }
    MenuSetChecked(menu, CmdToggleMenuBar, gSettings->showMenubar);
    MenuSetChecked(menu, CmdToggleCaption, gSettings->showCaption);
    MenuSetChecked(menu, CmdToggleSidebarAutoHide, gSettings->sidebarAutoHide);
    // CmdChangeScrollbar doesn't need a check mark - it opens a dialog
    MenuUpdateDisplayMode(win, menu);
    MenuUpdateZoom(win, menu);

    if (win->IsDocLoaded() && tab) {
        MenuSetEnabled(menu, CmdNavigateBack, tab->ctrl->CanNavigate(-1));
        MenuSetEnabled(menu, CmdNavigateForward, tab->ctrl->CanNavigate(1));
    }

    // TODO: is this check too expensive?
    bool fileExists = tab && file::Exists(tab->filePath);

    if (tab && tab->ctrl && !fileExists && dir::Exists(tab->filePath)) {
        for (int id : disableIfDirectoryOrBrokenPDF) {
            MenuSetEnabled(menu, id, false);
        }
    } else if (fileExists && CouldBePDFDoc(tab)) {
        for (int id : disableIfDirectoryOrBrokenPDF) {
            MenuSetEnabled(menu, id, true);
        }
    }

    DisplayModel* dm = tab ? tab->AsFixed() : nullptr;
    EngineBase* engine = dm ? dm->GetEngine() : nullptr;
    if (engine) {
        MenuSetEnabled(menu, CmdFindFirst, !engine->isImageCollection);
    }

    if (win->IsDocLoaded() && !fileExists) {
        MenuSetEnabled(menu, CmdRenameFile, false);
        MenuSetEnabled(menu, CmdDeleteFile, false);
        MenuSetEnabled(menu, CmdDeleteFileAndOpenNext, false);
    }

    CheckMenuRadioItem(menu, gFirstSetThemeCmdId, gLastSetThemeCmdId, gCurrSetThemeCmdId, MF_BYCOMMAND);

    MenuSetChecked(menu, CmdToggleLinks, gSettings->showLinks);
    MenuSetChecked(menu, CmdToggleVimKeys, gSettings->vimKeys);
    MenuSetChecked(menu, CmdTogglePageBoxes, win->showPageBoxes);
    MenuSetChecked(menu, CmdToggleHighlightFormFields, gSettings->highlightFormFields);
    MenuSetChecked(menu, CmdToggleTransparencyGrid, ShowTransparencyGrid());
    MenuSetChecked(menu, CmdTogglePageGrid, ShowPageGrid());
    MenuSetChecked(menu, CmdMeasure, win->measurementToolbar != nullptr);
    MenuSetChecked(menu, CmdToggleImages, ShowImageOutlines());
    MenuSetChecked(menu, CmdDebugShowFitContentArea, ShowFitContentArea());
    MenuSetEnabled(menu, CmdTabGroupSave, HasOpenedDocuments(win));
    MenuSetChecked(menu, CmdToggleFilePicker, gSettings && str::EqI(gSettings->filePicker, StrL("sumatrapdf")));
}

void OnAboutContextMenu(MainWindow* win, int x, int y) {
    if (!HasPermission(Perm::SavePreferences | Perm::DiskAccess) || !SettingsRememberOpenedFiles() ||
        !gSettings->showStartPage) {
        return;
    }

    // Prefer the file under the click; keyboard/context-menu key falls back to
    // the keyboard-selected home entry.
    TempStr path = HomePageFilePathAtTemp(win, x, y);
    bool fromClick = path && path::IsAbsolute(path);
    if (!fromClick) {
        path = str::DupTemp(HomePageSelectedFilePathTemp(win));
    }
    if (len(path) == 0 || !path::IsAbsolute(path)) {
        return;
    }

    // Keep keyboard selection in sync with the right-clicked thumbnail
    if (fromClick) {
        HomePageSelectAt(win, x, y);
    }

    FileState* fs = FileHistoryFindByPath(path);
    if (!fs) {
        return;
    }

    BuildMenuCtx ctx;
    ctx.isDocLoaded = true;
    ctx.filePath = path;
    HMENU popup = BuildMenuFromDef(menuDefContextStart, CreatePopupMenu(), &ctx);
    MenuSetChecked(popup, CmdPinSelectedDocument, fs->isPinned);
    // Del is home-page-only (not a global accelerator), so AppendAccelKey won't
    // pick it up — show it next to Remove From History explicitly
    MenuSetText(popup, CmdForgetSelectedDocument, str::JoinTemp(Tr("&Remove From History"), StrL("\tDel")));
    Point pt = HwndMapWindowPoint(win->hwndCanvas, HWND_DESKTOP, {x, y});
    // keyboard menu (no hit under the cursor): place at cursor or near the frame
    if (!fromClick) {
        Point cursor = GetCursorPosition();
        if (!cursor.IsEmpty()) {
            pt = cursor;
        } else {
            Rect rc = HwndWindowRect(win->hwndFrame);
            pt = Point(rc.x + 40, rc.y + 80);
        }
    }
    INT cmd = TrackPopupMenu(popup, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, win->hwndFrame, nullptr);
    DestroyMenu(popup);

    if (CmdOpenSelectedDocument == cmd) {
        LoadArgs args(path, win);
        args.activateExisting = !IsCtrlPressed();
        args.activateExistingInWindow = true;
        LoadDocument(&args);
        return;
    }

    if (CmdShowInFolder == cmd) {
        ShowFileInFolder(win, path);
        return;
    }

    if (CmdDeleteFile == cmd) {
        if (!CanAccessDisk() || gPluginMode) {
            return;
        }
        // own the path: delete closes tabs and rewrites history
        TempStr pathOwned = str::DupTemp(path);
        if (file::Exists(pathOwned)) {
            WindowTab* tab = FindTabByFilePath(pathOwned);
            if (tab) {
                if (!MaybeSaveAnnotations(tab)) {
                    return;
                }
                CloseTab(tab, false);
            }
            DeleteFileFromDiskAndHistory(pathOwned);
        } else {
            // missing file: still drop it from history
            ForgetFileFromFrequentlyRead(win, pathOwned);
            return;
        }
        if (IsMainWindowValidAndNotClosing(win)) {
            win->DeleteToolTip();
            win->RedrawAll(true);
        }
        return;
    }

    if (CmdPinSelectedDocument == cmd) {
        fs->isPinned = !fs->isPinned;
        win->DeleteToolTip();
        HomePageRelayout(win);
        win->RedrawAll(true);
        return;
    }

    if (CmdForgetSelectedDocument == cmd) {
        ForgetFileFromFrequentlyRead(win, path);
        return;
    }
}

// removes a file from the Frequently Read list on the home page. Files with
// favorites are only hidden (so the favorites aren't lost). Used by both the
// context menu and the per-thumbnail ✕ button (issue #283).
void ForgetFileFromFrequentlyRead(MainWindow* win, Str filePath) {
    FileState* fs = FileHistoryFindByPath(filePath);
    if (!fs) {
        return;
    }
    TempStr path = str::DupTemp(fs->filePath);
    if (len(*fs->favorites) > 0) {
        // only hide documents with favorites
        FileHistoryDemote(fs->filePath, true);
    } else {
        FileHistoryRemove(fs);
        DeleteFileState(fs);
    }
    DeleteThumbnailForFile(path);
    ScheduleSaveSettings();
    win->DeleteToolTip();
    win->RedrawAll(true);
}

void OnWindowContextMenu(MainWindow* win, int x, int y) {
    TraceTestMenu(StrL("context-menu-dispatch"), win->hwndCanvas, MAKELPARAM(x, y));
    DisplayModel* dm = win->AsFixed();
    ReportIf(!dm);
    if (!dm) {
        return;
    }

    Point cursorPos{x, y};
    WindowTab* tab = win->CurrentTab();
    int pageNoUnderEl = 0;
    IPageElement* pageEl = dm->GetElementAtPos(cursorPos, &pageNoUnderEl);

    Str value = {};
    if (pageEl) {
        value = pageEl->GetValue();
    }

    auto* ctx = NewBuildMenuCtx(tab, cursorPos);
    AutoDelete delCtx(ctx);
    HMENU popup = BuildMenuFromDef(menuDefContext, CreatePopupMenu(), ctx);

    bool isFullScreen = win->IsFullScreenOrPresentation();
#ifndef SOLOKPDF_PDFIUM
    // in fullscreen, add "Menu" as first item containing the full menu bar
    if (isFullScreen) {
        HMENU menuBarCopy = BuildMenuFromDef(menuDefMenubar, CreatePopupMenu(), ctx);
        WCHAR* menuLabel = CWStrTemp(Tr("Menu"));
        MENUITEMINFOW mii{};
        mii.cbSize = sizeof(mii);
        mii.fMask = MIIM_STRING | MIIM_SUBMENU;
        mii.hSubMenu = menuBarCopy;
        mii.dwTypeData = menuLabel;
        InsertMenuItemW(popup, 0, TRUE, &mii);
    }
#endif

    int pageNoUnderCursor = dm->GetPageNoByPoint(cursorPos);
    EngineBase* engine = dm->GetEngine();

    bool onImage = pageEl && pageEl->Is(kindPageElementImage);
    onImage = onImage || (engine && engine->kind == kindEngineImage);
    if (pageNoUnderCursor > 0) {
        TempStr pageItem;
        if (ShowChapterUi(win->ctrl)) {
            Location loc = win->ctrl->LocationFromPageNo(pageNoUnderCursor);
            pageItem = fmt(Tr("Chapter %d Page %d").s, loc.chapter, loc.page);
        } else {
            TempStr pageLabel = win->ctrl->GetPageLabeTemp(pageNoUnderCursor);
            pageItem = fmt(Tr("Page %s").s, pageLabel);
        }
        MenuSetText(popup, CmdSearchGoogleLensPage, pageItem);
    }

    win->contextMenuPt = cursorPos;
    bool isImageDoc = engine && (engine->isImageCollection || engine->kind == kindEngineImage ||
                                 engine->kind == kindEngineImageDir || engine->kind == kindEngineComicBooks);
    win->contextMenuPtValid = !isImageDoc && ReadAloudCanReadFromCursor(dm, cursorPos);
#ifndef SOLOKPDF_PDFIUM
    HMENU readAloudCtxMenu = GetReadAloudContextSubmenu();
    // no text to speak on comics / image folders / single images
    if (readAloudCtxMenu && !isImageDoc) {
        RebuildReadAloudMenu(win, readAloudCtxMenu, true, win->contextMenuPtValid);
    }
#endif

    if (!pageEl || !pageEl->Is(kindPageElementDest) || !PageDestHasAddress(pageEl->AsLink())) {
        MenuRemove(popup, CmdCopyLinkTarget);
    }
    bool hasCommentToCopy = pageEl && pageEl->Is(kindPageElementComment) && value;
    if (ctx->annotationUnderCursor) {
        hasCommentToCopy = !str::IsEmptyOrWhiteSpace(Contents(ctx->annotationUnderCursor));
    }
    if (!hasCommentToCopy) {
        MenuRemove(popup, CmdCopyComment);
    }
    // show "Save Attachment" only for file attachment annotations
    {
        bool isFileAttachment = false;
        if (pageEl && pageEl->Is(kindPageElementDest)) {
            IPageDestination* elDest = pageEl->AsLink();
            if (elDest && elDest->GetKind() == kindDestinationLaunchEmbedded) {
                isFileAttachment = true;
            }
        }
        if (!isFileAttachment) {
            MenuRemove(popup, CmdSaveAttachment);
        }
    }
    {
        bool isImageEngine = tab && tab->GetEngineType() == kindEngineImage;
        if (!onImage && !isImageEngine) {
            MenuRemove(popup, CmdCopyImage);
        }
        if (!onImage) {
            MenuRemove(popup, CmdSaveImage);
        }
        if (!pageEl || !pageEl->Is(kindPageElementImage)) {
            MenuRemove(popup, CmdReplaceImage);
            MenuRemove(popup, CmdEditImageExternally);
        }
        if (!isImageEngine && !onImage) {
            MenuRemove(popup, CmdCropImage);
            MenuRemove(popup, CmdResizeImage);
            MenuRemove(popup, CmdConvertImageToPdf);
        }
#ifndef SOLOKPDF_PDFIUM
        // remove the Image submenu entirely if no items left
        if (!onImage && !isImageEngine) {
            // find and remove the submenu by scanning top-level items
            int n = GetMenuItemCount(popup);
            for (int j = 0; j < n; j++) {
                HMENU sub = GetSubMenu(popup, j);
                if (sub && GetMenuItemCount(sub) == 0) {
                    RemoveMenu(popup, j, MF_BYPOSITION);
                    break;
                }
            }
        }
#endif
    }

    if (!engine || !engine->HasErrors()) {
        MenuRemove(popup, CmdShowErrors);
    }

    if (!isFullScreen) {
        MenuRemove(popup, CmdToggleFullscreen);
    }
    SetMenuStateForSelection(tab, popup);

    MenuUpdatePrintItem(win, popup, true);
    MenuSetEnabled(popup, CmdToggleBookmarks, win->ctrl->HasToc());
    MenuSetChecked(popup, CmdToggleBookmarks, IsSidebarViewShown(win, SidebarView::Bookmarks));
    MenuSetEnabled(popup, CmdToggleThumbnails, CanShowThumbnails(tab));
    MenuSetChecked(popup, CmdToggleThumbnails, IsSidebarViewShown(win, SidebarView::Thumbnails));

    MenuSetEnabled(popup, CmdFavoriteToggle, HasFavorites());
    MenuSetChecked(popup, CmdFavoriteToggle, IsSidebarViewShown(win, SidebarView::Favorites));
    MenuSetEnabled(popup, CmdFavoriteShowInTab, HasFavorites() && SettingsUseTabs());
    MenuSetEnabled(popup, CmdEditFavorites, HasFavorites());
    MenuSetChecked(popup, CmdFavoriteShowInTab, FindFavoritesTab(win) != nullptr);

    Str filePath = win->ctrl->GetFilePath();
    bool favsSupported = HasPermission(Perm::SavePreferences) && CanAccessDisk();
    if (favsSupported) {
        if (pageNoUnderCursor > 0) {
            bool isBookmarked = IsPageInFavorites(filePath, pageNoUnderCursor, win->ctrl);

            TempStr addText;
            TempStr delText;
            if (ShowChapterUi(win->ctrl)) {
                Location loc = win->ctrl->LocationFromPageNo(pageNoUnderCursor);
                addText = fmt(Tr("Add chapter %d page %d to favorites").s, loc.chapter, loc.page);
                delText = fmt(Tr("Remove chapter %d page %d from favorites").s, loc.chapter, loc.page);
            } else {
                TempStr pageLabel = win->ctrl->GetPageLabeTemp(pageNoUnderCursor);
                addText = fmt(Tr("Add page %s to favorites").s, pageLabel);
                delText = fmt(Tr("Remove page %s from favorites").s, pageLabel);
            }

            if (isBookmarked) {
                MenuRemove(popup, CmdFavoriteAdd);
                MenuSetText(popup, CmdFavoriteDel, delText);
            } else {
                MenuRemove(popup, CmdFavoriteDel);
                TempStr s = AppendAccelKeyToMenuStringTemp(addText, CmdFavoriteAdd);
                MenuSetText(popup, CmdFavoriteAdd, s);
            }
        } else {
            MenuRemove(popup, CmdFavoriteAdd);
            MenuRemove(popup, CmdFavoriteDel);
        }
    }

    // if toolbar is not shown, add option to show it
    if (gSettings->showToolbar) {
        MenuRemove(popup, CmdToggleToolbar);
    }
#ifdef SOLOKPDF_PDFIUM
    PruneMenuTree(popup);
    if (isFullScreen) {
        auto appCtx = NewAppCommandCtx(win);
        HMENU menuBarCopy = BuildMenuFromDef(menuDefMenubar, CreatePopupMenu(), &appCtx);
        MenuUpdateStateForWindow(win, menuBarCopy);
        InsertMenuW(popup, 1, MF_BYPOSITION | MF_POPUP, (UINT_PTR)menuBarCopy, CWStrTemp(Tr("Menu")));
    }
#else
    RemoveBadMenuSeparators(popup);
#endif

    // highlight the element under cursor while context menu is open
    if (pageEl && pageNoUnderEl > 0) {
        win->contextMenuHighlightRect = pageEl->GetRect();
        win->contextMenuHighlightPageNo = pageNoUnderEl;
        HwndRepaintNow(win->hwndCanvas);
    }

    Point pt = HwndMapWindowPoint(win->hwndCanvas, HWND_DESKTOP, {x, y});
    UINT flags = TPM_RETURNCMD | TPM_RIGHTBUTTON;
    TraceTestMenu(StrL("context-menu-track"), win->hwndFrame, GetMenuItemCount(popup));
    int cmdId = TrackPopupMenu(popup, flags, pt.x, pt.y, 0, win->hwndFrame, nullptr);
    DestroyMenu(popup);

    // TrackPopupMenu runs a nested message loop; during that time the window
    // can be force-closed (e.g. by a plugin host destroying the parent).
    // If that happened, all our cached pointers (win, dm, pageEl, etc.) are dangling.
    // DDE or a reload can also replace the document while the window lives on.
    if (!IsMainWindowValidAndNotClosing(win) || win->AsFixed() != dm || win->CurrentTab() != tab) {
        return;
    }

    // clear the highlight after context menu closes
    if (win->contextMenuHighlightPageNo > 0) {
        win->contextMenuHighlightPageNo = 0;
        HwndRepaintNow(win->hwndCanvas);
    }

    auto* cmd = FindCustomCommand(cmdId);
    if (cmd && cmd->origId == CmdSelectionHandler) {
        HwndSendCommand(win->hwndFrame, cmd->id);
        return;
    }
    // a text snippet goes where the menu was opened
    if (cmd && cmd->origId == CmdInsertTextSnippet) {
        HwndSendCommand(win->hwndFrame, cmd->id, MAKELPARAM(x, y));
        return;
    }

    // handle in FrameOnCommand() in SumatraPDF.cpp
    if (CommandUsesContextMenuPoint(cmdId)) {
        LPARAM lpArg = MAKELPARAM(x, y);
        HwndSendCommand(win->hwndFrame, cmdId, lpArg);
        return;
    }

    switch (cmdId) {
#ifdef SOLOKPDF_PDFIUM
        case CmdToggleFullscreen:
            if (isFullScreen) {
                ExitFullScreen(win);
            }
            return;
#endif
        case CmdSearchGoogleLens:
            SearchGoogleLensSelection(tab);
            return;
        case CmdSearchGoogleLensPage:
            SearchGoogleLensPage(tab, pageNoUnderCursor);
            return;
        case CmdSearchGoogleLensImage:
            SearchGoogleLensImage(tab, pageEl);
            return;
        case CmdReplaceImage:
            ReplaceImageFromFile(win, pageEl);
            return;
        case CmdEditImageExternally:
            EditImageExternally(win, pageEl);
            return;
        case CmdSaveImage:
        case CmdCropImage:
        case CmdResizeImage:
        case CmdConvertImageToPdf: {
            if (!pageEl || !pageEl->Is(kindPageElementImage)) {
                HwndSendCommand(win->hwndFrame, cmdId);
                return;
            }
            EngineBase* imgEngine = dm->GetEngine();
            ImageEditMode m = ImageEditMode::Save;
            bool selectPdf = false;
            if (cmdId == CmdCropImage) {
                m = ImageEditMode::Crop;
            } else if (cmdId == CmdResizeImage) {
                m = ImageEditMode::Resize;
            } else if (cmdId == CmdConvertImageToPdf) {
                selectPdf = true;
            }
            // a standalone image file: load from disk so Save can write the original
            // bytes when the image is not cropped or resized
            if (imgEngine->kind == kindEngineImage && imgEngine->FilePath()) {
                ShowImageEditWindow(win->hwndFrame, m, imgEngine->FilePath(), nullptr, selectPdf);
                return;
            }
            RenderedBitmap* bmp = imgEngine->GetImageForPageElement(pageEl);
            if (!bmp) {
                return;
            }
            TempStr dir = path::GetDirTemp(filePath);
            TempStr base = path::GetBaseNameTemp(filePath);
            TempStr noExt = path::GetPathNoExtTemp(base);
            Str origData = imgEngine->GetImageDataForPageElement(pageEl);
            Str ext = ImageSaveExtFromData(origData);
            if (len(ext) == 0) {
                ext = StrL(".png");
            }
            TempStr destPath = path::JoinTemp(dir, fmt("%s_page_%d%s", noExt, pageNoUnderCursor, ext));
            ShowImageEditWindow(win->hwndFrame, m, destPath, bmp, selectPdf, origData);
            str::Free(origData);
            delete bmp;
            return;
        };

        case CmdCopyLinkTarget: {
            if (len(value) > 0) {
                TempStr tmp = CleanupURLForClipbardCopyTemp(value);
                CopyTextToClipboard(tmp);
            }
            return;
        };
        case CmdShowAnnotationText: {
            Annotation* annot = ctx->annotationUnderCursor;
            if (annot) {
                ShowAnnotationTextPopup(win, annot);
            }
            return;
        }

        case CmdCopyComment: {
            Str comment = value;
            if (ctx->annotationUnderCursor) {
                // The page element's value is hover text. For FreeText that is
                // only the author because the contents are already on the page.
                comment = Contents(ctx->annotationUnderCursor);
            }
            if (!str::IsEmptyOrWhiteSpace(comment)) {
                CopyTextToClipboard(comment);
            }
            return;
        }

        case CmdSaveAttachment: {
            if (!pageEl || !pageEl->Is(kindPageElementDest)) {
                return;
            }
            IPageDestination* elDest = pageEl->AsLink();
            PageDestination* pd = (PageDestination*)elDest;
            if (!pd) {
                return;
            }
            // attachments are arbitrary binary
            Str data = EngineMupdfLoadEmbedded(engine, pd);
            if (len(data) == 0) {
                return;
            }
            Str fileName = pd->GetValue();
            TempStr dir = path::GetDirTemp(filePath);
            fileName = path::GetBaseNameTemp(fileName);
            TempStr dstPath = path::JoinTemp(dir, fileName);
            SaveDataToFile(win->hwndFrame, dstPath, data);
            str::Free(data);
            return;
        }

        case CmdCopyImage: {
            if (pageEl) {
                RenderedBitmap* bmp = dm->GetEngine()->GetImageForPageElement(pageEl);
                if (bmp) {
                    // via the Pixmap, so an image with an alpha channel reaches
                    // the clipboard with its transparency intact (#5844, #5598)
                    Pixmap* px = PixmapFromRenderedBitmap(bmp); // takes ownership of bmp
                    CopyPixmapToClipboard(px, false);
                    FreePixmap(px);
                }
            }
            return;
        }
        case CmdFavoriteAdd: {
            if (pageNoUnderCursor > 0) {
                AddFavoriteForPage(win, pageNoUnderCursor);
            }
            return;
        }
        case CmdFavoriteDel: {
            DelFavorite(filePath, pageNoUnderCursor, win->ctrl);
            return;
        }
    }
    // everything else we forward to FrameOnCommand() in SumatraPDF.cpp
    HwndSendCommand(win->hwndFrame, cmdId);
}

HMENU BuildMenu(MainWindow* win) {
    WindowTab* tab = win->CurrentTab();

    auto* ctx = NewBuildMenuCtx(tab);
    AutoDelete delCtx(ctx);
    HMENU mainMenu = BuildMenuFromDef(menuDefMenubar, CreateMenu(), ctx);
#ifndef SOLOKPDF_PDFIUM
    // BuildMenuFromDef just set the global to this window's submenu
    win->menuReadAloud = GetReadAloudAppSubmenu();
#endif
    return mainMenu;
}

static void RebuildFavoritesMenu(MainWindow* win, HMENU menu) {
#ifdef SOLOKPDF_PDFIUM
    ClearMenuTree(menu);
#else
    MenuEmpty(menu);
#endif
    auto* ctx = NewBuildMenuCtx(win->CurrentTab());
    AutoDelete delCtx(ctx);
#ifdef SOLOKPDF_PDFIUM
    BuildMenuFromDef(solokFavorites, menu, ctx);
    RebuildFavMenu(win, menu);
    BuildMenuFromDef(solokFavoritesMore, menu, ctx);
    MenuSetEnabled(menu, CmdEditFavorites, HasFavorites());
#else
    BuildMenuFromDef(menuDefFavorites, menu, ctx);
    RebuildFavMenu(win, menu);
#endif
}

void UpdateAppMenu(MainWindow* win, HMENU m) {
    ReportIf(!win);
    if (!win) {
        return;
    }
#ifdef SOLOKPDF_PDFIUM
    MenuDef* def = GetLiveMenuDef(m);
    if (def == menuDefReadAloud || def == menuDefContextReadAloud) {
        bool fromCanvas = def == menuDefContextReadAloud;
        RebuildReadAloudMenu(win, m, fromCanvas, fromCanvas && win->contextMenuPtValid);
    } else if (IsLiveMenuDef(def)) {
        if (def == solokFile) {
            RebuildFileMenu(win->CurrentTab(), m);
        } else if (def == solokFavorites) {
            RebuildFavoritesMenu(win, m);
        } else if (def == menuDefZoom) {
            BuildMenuZoom(m);
        } else {
            ClearMenuTree(m);
            auto ctx = NewAppCommandCtx(win);
            BuildMenuFromDef(def, m, &ctx);
        }
        MenuUpdateStateForWindow(win, m);
    }
#else
    UINT_PTR id = (UINT_PTR)GetMenuItemID(m, 0);
    if (id == menuDefFile[0].idOrSubmenu) {
        RebuildFileMenu(win->CurrentTab(), m);
    } else if (id == menuDefFavorites[0].idOrSubmenu) {
        RebuildFavoritesMenu(win, m);
    } else if (id == menuDefZoom[0].idOrSubmenu) {
        BuildMenuZoom(m);
    } else if (m && m == win->menuReadAloud) {
        RebuildReadAloudMenu(win, m, false, false);
    } else if (IsReadAloudContextSubmenu(m)) {
        RebuildReadAloudMenu(win, m, true, win->contextMenuPtValid);
    }
#endif
    MenuUpdateStateForWindow(win, win->menu);
}

// show/hide top-level menu bar. This doesn't persist across launches
// so that accidental removal of the menu isn't catastrophic
void ToggleMenuBar(MainWindow* win, bool showTemporarily) {
    ReportIf(!win->menu);

    if (win->InPresentation()) {
        return;
    }

    HWND hwnd = win->hwndFrame;

    if (showTemporarily) {
        if (win->tabsInTitlebar) {
            // can't show regular menu with custom caption, so do nothing
            return;
        }
        SetMenu(hwnd, win->menu);
        return;
    }

    if (win->IsFullScreen()) {
        gSettings->fullscreen.showMenubar = !gSettings->fullscreen.showMenubar;
        if (gSettings->fullscreen.showMenubar) {
            // use rebar-based menu bar (WS_CAPTION is stripped in fullscreen, so SetMenu won't work)
            CreateMenuBarRebar(win);
        } else {
            DestroyMenuBarRebar(win);
        }
        ScheduleUiUpdate(win);
        ShowMenuBarRebar(win);
        return;
    }

    if (win->tabsInTitlebar) {
        // toggle rebar menu bar while keeping tabs in titlebar
        bool isShowing = IsShowingMenuBarRebar(win);
        if (isShowing) {
            DestroyMenuBarRebar(win);
            gSettings->showMenubar = false;
            gSettings->showMenubarWithTabs = false;
        } else {
            CreateMenuBarRebar(win);
            gSettings->showMenubar = true;
            gSettings->showMenubarWithTabs = true;
        }
        // layout first so the rebar is positioned correctly, then show it
        ScheduleUiUpdate(win);
        ShowMenuBarRebar(win);
        return;
    }

    bool hideMenu = GetMenu(hwnd) != nullptr;
    SetMenu(hwnd, hideMenu ? nullptr : win->menu);
    gSettings->showMenubar = !hideMenu;
    gSettings->showMenubarWithTabs = !hideMenu;
}

// --- Menu bar as rebar control (used when tabs are in titlebar) ---

static int MenuBarToolbarIdealDy() {
    PlatformFont* font = GetAppMenuFont();
    int dy = PlatformFontLineHeight(font) + DpiScale(4);
    int minDy = DpiScale(kTabBarDy);
    return std::max(dy, minDy);
}

int GetMenuBarRebarHeight(MainWindow* win) {
    HWND hwnd = win ? win->hwndMenuReBar : nullptr;
    if (!hwnd || !::IsWindow(hwnd)) {
        return 0;
    }
    // RB_GETBARHEIGHT underreports by 1px without WS_BORDER
    int dy = (int)SendMessageW(hwnd, RB_GETBARHEIGHT, 0, 0) + 1;
    if (dy > 1) {
        return dy;
    }
    int ideal = MenuBarToolbarIdealDy();
    return ideal;
}

static void FillRectColor(HDC hdc, const RECT& rc, Color col) {
    HBRUSH br = CreateSolidBrush(col);
    FillRect(hdc, &rc, br);
    DeleteObject(br);
}

// The menu bar sits in the title bar: it takes the title bar's color and the
// tabs' text color; a hot or open item looks like the selected tab.
static LRESULT PaintMenuBarItem(NMTBCUSTOMDRAW* cd) {
    UINT state = cd->nmcd.uItemState;
    if (state & (CDIS_HOT | CDIS_SELECTED | CDIS_CHECKED)) {
        FillRectColor(cd->nmcd.hdc, cd->nmcd.rc, ThemeActiveTabBackgroundColor());
    }
    bool disabled = state & CDIS_DISABLED;
    cd->clrText = disabled ? ThemeWindowTextDisabledColor() : ThemeWindowTextColor();
    cd->nStringBkMode = TRANSPARENT;
    cd->nmcd.uItemState &= ~(CDIS_HOT | CDIS_SELECTED | CDIS_CHECKED | CDIS_DISABLED);
    return TBCDRF_USECDCOLORS | TBCDRF_NOBACKGROUND | TBCDRF_NOEDGES | TBCDRF_NOOFFSET;
}

static LRESULT CALLBACK MenuBarReBarWndProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass,
                                            DWORD_PTR /*dwRefData*/) {
    if (WM_ERASEBKGND == uMsg) {
        FillRectColor((HDC)wParam, ToRECT(HwndClientRect(hWnd)), ThemeTabStripColor());
        return 1;
    }
    if (WM_NOTIFY == uMsg) {
        auto* win = FindMainWindowByHwnd(hWnd);
        NMHDR* hdr = (NMHDR*)lParam;
        if (win && hdr->code == NM_CUSTOMDRAW && hdr->hwndFrom == win->hwndMenuToolbar) {
            NMTBCUSTOMDRAW* custDraw = (NMTBCUSTOMDRAW*)hdr;
            switch (custDraw->nmcd.dwDrawStage) {
                case CDDS_PREPAINT:
                    FillRectColor(custDraw->nmcd.hdc, custDraw->nmcd.rc, ThemeTabStripColor());
                    return CDRF_NOTIFYITEMDRAW;
                case CDDS_ITEMPREPAINT:
                    return PaintMenuBarItem(custDraw);
            }
        }
    }
    if (WM_NCDESTROY == uMsg) {
        RemoveWindowSubclass(hWnd, MenuBarReBarWndProc, uIdSubclass);
    }
    return DefSubclassProc(hWnd, uMsg, wParam, lParam);
}

static LRESULT CALLBACK MenuBarToolbarWndProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam, UINT_PTR uIdSubclass,
                                              DWORD_PTR /*dwRefData*/) {
    if (WM_ERASEBKGND == uMsg) {
        // don't erase background here; toolbar paints its own background during WM_PAINT
        // filling here causes visible flicker (erase then paint) during window resize
        return 1;
    }
    if (WM_NCDESTROY == uMsg) {
        RemoveWindowSubclass(hWnd, MenuBarToolbarWndProc, uIdSubclass);
    }
    return DefSubclassProc(hWnd, uMsg, wParam, lParam);
}

constexpr int kMenuBarCmdFirst = 50000;
constexpr int kMenuBarCmdLast = 50020;

struct MenuBarPopupNav {
    MainWindow* win = nullptr;
    HMENU rootMenu = nullptr;
    HMENU currentMenu = nullptr;
    UINT currentFlags = 0;
    int nextMenuIdx = -1;
};

static MenuBarPopupNav gMenuBarPopupNav;

// track when a menu popup was last dismissed so a second click on the same
// menu bar button closes the popup instead of immediately reopening it
static int gMenuBarLastDismissedIdx = -1;
static u64 gMenuBarLastDismissedTick = 0;

static bool ShouldSwitchCustomMenuBarPopup(UINT vk) {
    if (!gMenuBarPopupNav.win || !gMenuBarPopupNav.rootMenu) {
        return false;
    }
    if (!gMenuBarPopupNav.currentMenu || gMenuBarPopupNav.currentMenu != gMenuBarPopupNav.rootMenu) {
        return false;
    }
    if (bit::IsMaskSet(gMenuBarPopupNav.currentFlags, (UINT)MF_POPUP)) {
        return false;
    }

    int menuCount = GetMenuItemCount(gMenuBarPopupNav.win->menu);
    if (menuCount <= 1) {
        return false;
    }

    int step = 0;
    if (vk == VK_LEFT) {
        step = -1;
    } else if (vk == VK_RIGHT) {
        step = 1;
    }
    if (step == 0) {
        return false;
    }

    gMenuBarPopupNav.nextMenuIdx += step;
    if (gMenuBarPopupNav.nextMenuIdx < 0) {
        gMenuBarPopupNav.nextMenuIdx = menuCount - 1;
    } else if (gMenuBarPopupNav.nextMenuIdx >= menuCount) {
        gMenuBarPopupNav.nextMenuIdx = 0;
    }
    return true;
}

// check if mouse is over a different toolbar button and switch to it
static bool ShouldSwitchMenuBarOnMouseMove() {
    if (!gMenuBarPopupNav.win || !gMenuBarPopupNav.win->hwndMenuToolbar) {
        return false;
    }
    HWND hwndTb = gMenuBarPopupNav.win->hwndMenuToolbar;

    Point pt = HwndGetCursorPos(hwndTb);

    // hit-test the toolbar
    int btnCount = TbGetButtonCount(hwndTb);
    for (int i = 0; i < btnCount; i++) {
        Rect rc = TbGetItemRect(hwndTb, i);
        if (rc.Contains(pt.x, pt.y)) {
            TBBUTTON tb{};
            SendMessageW(hwndTb, TB_GETBUTTON, i, (LPARAM)&tb);
            int menuIdx = tb.idCommand - kMenuBarCmdFirst;
            if (menuIdx != gMenuBarPopupNav.nextMenuIdx) {
                gMenuBarPopupNav.nextMenuIdx = menuIdx;
                return true;
            }
            return false;
        }
    }
    return false;
}

static LRESULT CALLBACK MenuBarMsgFilterHook(int code, WPARAM wParam, LPARAM lParam) {
    if (code == MSGF_MENU && gMenuBarPopupNav.win) {
        MSG* msg = (MSG*)lParam;
        if ((msg->message == WM_KEYDOWN || msg->message == WM_SYSKEYDOWN) &&
            ShouldSwitchCustomMenuBarPopup((UINT)msg->wParam)) {
            EndMenu();
            return 1;
        }
        if (msg->message == WM_MOUSEMOVE && ShouldSwitchMenuBarOnMouseMove()) {
            EndMenu();
            return 1;
        }
    }
    return CallNextHookEx(nullptr, code, wParam, lParam);
}

void UpdateCustomMenuBarMenuSelect(MainWindow* win, WPARAM wp, LPARAM lp) {
    if (gMenuBarPopupNav.win != win) {
        return;
    }

    UINT flags = HIWORD(wp);
    HMENU menu = (HMENU)lp;
    if (flags == 0xFFFF && !menu) {
        gMenuBarPopupNav.currentMenu = nullptr;
        gMenuBarPopupNav.currentFlags = 0;
        return;
    }

    gMenuBarPopupNav.currentMenu = menu;
    gMenuBarPopupNav.currentFlags = flags;
}

void RebuildMenuBarButtons(MainWindow* win) {
    HWND hwndMb = win->hwndMenuToolbar;
    if (!hwndMb) {
        return;
    }

    // remove existing buttons
    while (SendMessageW(hwndMb, TB_DELETEBUTTON, 0, 0)) {
    }

    HMENU menu = win->menu;
    int count = GetMenuItemCount(menu);
    if (count <= 0) {
        return;
    }

    MENUITEMINFOW mii{};
    mii.cbSize = sizeof(MENUITEMINFOW);
    mii.fMask = MIIM_SUBMENU | MIIM_STRING;

    for (int i = 0; i < count && i < (kMenuBarCmdLast - kMenuBarCmdFirst); i++) {
        mii.dwTypeData = nullptr;
        mii.cch = 0;
        GetMenuItemInfoW(menu, i, TRUE, &mii);
        if (!mii.hSubMenu || !mii.cch) {
            continue;
        }
        mii.cch++;
        WCHAR* name = AllocArrayTemp<WCHAR>((int)mii.cch);
        mii.dwTypeData = name;
        GetMenuItemInfoW(menu, i, TRUE, &mii);

        TBBUTTON b{};
        b.iBitmap = I_IMAGENONE;
        b.idCommand = kMenuBarCmdFirst + i;
        b.fsState = TBSTATE_ENABLED;
        b.fsStyle = BTNS_AUTOSIZE | BTNS_SHOWTEXT;
        b.iString = (INT_PTR)name;
        TbAddButtons(hwndMb, 1, &b);
    }

    TbAutoSize(hwndMb);

    if (win->hwndMenuReBar) {
        Rect rc = TbGetItemRect(hwndMb, 0);
        int menuBarDy = MenuBarToolbarIdealDy();
        if (rc.dy > 0) {
            menuBarDy = rc.dy + (2 * rc.y);
        }
        REBARBANDINFOW rbBand{};
        rbBand.cbSize = sizeof(REBARBANDINFOW);
        rbBand.fMask = RBBIM_CHILDSIZE;
        rbBand.cyChild = menuBarDy;
        rbBand.cyMinChild = menuBarDy;
        SendMessageW(win->hwndMenuReBar, RB_SETBANDINFO, 0, (LPARAM)&rbBand);
    }
}

void CreateMenuBarRebar(MainWindow* win) {
    if (!win || win->hwndMenuReBar) {
        return;
    }
    // embedded hosts (TC lister) must not get titlebar menu rebar chrome
    if (gMyWindowWasEmbedded) {
        return;
    }
    HWND hwndParent = win->hwndFrame;
    if (!hwndParent || !::IsWindow(hwndParent)) {
        return;
    }

    bool isRtl = IsUIRtl();
    HINSTANCE hinst = GetModuleHandle(nullptr);

    // create hidden; caller shows after the scheduled relayout positions it
    // no WS_BORDER (avoids 1px gap) and no RBS_BANDBORDERS (avoids gray band separators)
    DWORD style = WS_CHILD | WS_CLIPCHILDREN | RBS_VARHEIGHT;
    style |= CCS_NODIVIDER | CCS_NOPARENTALIGN;
    DWORD exStyle = WS_EX_TOOLWINDOW;
    if (isRtl) {
        exStyle |= WS_EX_LAYOUTRTL;
    }

    win->hwndMenuReBar = CreateWindowExW(exStyle, REBARCLASSNAME, nullptr, style, 0, 0, 0, 0, hwndParent,
                                         (HMENU)IDC_MENUBAR_REBAR, hinst, nullptr);
    SetWindowSubclass(win->hwndMenuReBar, MenuBarReBarWndProc, 0, 0);

    REBARINFO rbi{};
    rbi.cbSize = sizeof(REBARINFO);
    SendMessageW(win->hwndMenuReBar, RB_SETBARINFO, 0, (LPARAM)&rbi);
    SendMessageW(win->hwndMenuReBar, RB_SETBKCOLOR, 0, ThemeTabStripColor());

    style = WS_CHILD | WS_CLIPSIBLINGS | TBSTYLE_FLAT | TBSTYLE_LIST;
    style |= CCS_NODIVIDER | CCS_NOPARENTALIGN;
    exStyle = 0;
    if (isRtl) {
        exStyle |= WS_EX_LAYOUTRTL;
    }

    win->hwndMenuToolbar = CreateWindowExW(exStyle, TOOLBARCLASSNAME, nullptr, style, 0, 0, 0, 0, win->hwndMenuReBar,
                                           (HMENU)IDC_MENUBAR, hinst, nullptr);
    SetWindowSubclass(win->hwndMenuToolbar, MenuBarToolbarWndProc, 0, 0);
    TbSetButtonStructSize(win->hwndMenuToolbar, sizeofi(TBBUTTON));

    if (!DarkModeIsActive()) {
        if (!IsCurrentThemeDefault()) {
            SetWindowTheme(win->hwndMenuToolbar, L"", L"");
        }
    }

    PlatformFont* font = GetAppMenuFont();
    HwndSetFont(win->hwndMenuToolbar, font->GetHFont());

    DWORD tbExStyle = TbGetExtendedStyle(win->hwndMenuToolbar);
    tbExStyle |= TBSTYLE_EX_MIXEDBUTTONS;
    TbSetExtendedStyle(win->hwndMenuToolbar, tbExStyle);

    RebuildMenuBarButtons(win);

    Rect rc = TbGetItemRect(win->hwndMenuToolbar, 0);
    int menuBarDy = rc.dy + (2 * rc.y);
    if (menuBarDy <= 0) {
        menuBarDy = MenuBarToolbarIdealDy();
    }

    ShowWindow(win->hwndMenuToolbar, SW_SHOW);

    REBARBANDINFOW rbBand{};
    rbBand.cbSize = sizeof(REBARBANDINFOW);
    rbBand.fMask = RBBIM_STYLE | RBBIM_CHILD | RBBIM_CHILDSIZE;
    rbBand.fStyle = RBBS_FIXEDSIZE;
    rbBand.hwndChild = win->hwndMenuToolbar;
    rbBand.cxMinChild = 0;
    rbBand.cyMinChild = menuBarDy;
    rbBand.cx = 0;
    SendMessageW(win->hwndMenuReBar, RB_INSERTBAND, (WPARAM)-1, (LPARAM)&rbBand);

    DarkModeApplyToMenuBar(win->hwndMenuReBar);
}

void ShowMenuBarRebar(MainWindow* win) {
    HWND hwnd = win ? win->hwndMenuReBar : nullptr;
    if (hwnd && ::IsWindow(hwnd)) {
        ShowWindow(hwnd, SW_SHOW);
    }
}

void DestroyMenuBarRebar(MainWindow* win) {
    if (!win) {
        return;
    }
    // clear fields first so re-entrant layout/paint cannot SetWindowPos them
    HWND hwndTb = win->hwndMenuToolbar;
    HWND hwndRb = win->hwndMenuReBar;
    win->hwndMenuToolbar = nullptr;
    win->hwndMenuReBar = nullptr;
    // hide before destroy so nested paint is less likely to walk half-torn
    // rebar/toolbar scroll-arrow state (comctl32!DrawScrollBar AV)
    if (hwndRb && ::IsWindow(hwndRb)) {
        ShowWindow(hwndRb, SW_HIDE);
    }
    if (hwndTb && ::IsWindow(hwndTb)) {
        ShowWindow(hwndTb, SW_HIDE);
        DestroyWindow(hwndTb);
    }
    if (hwndRb && ::IsWindow(hwndRb)) {
        DestroyWindow(hwndRb);
    }
}

bool IsShowingMenuBarRebar(MainWindow* win) {
    if (!win) {
        return false;
    }
    HWND hwnd = win->hwndMenuReBar;
    if (!hwnd || !::IsWindow(hwnd)) {
        return false;
    }
    // host reparented us as WS_CHILD: menu rebar is being (or about to be)
    // torn down; treat as not showing so layout does not SetWindowPos it
    if (gMyWindowWasEmbedded) {
        return false;
    }
    if (win->InPresentation() || win->isQuickLook) {
        return false;
    }
    return true;
}

bool HandleMenuBarCommand(MainWindow* win, int cmdId) {
    if (cmdId < kMenuBarCmdFirst || cmdId >= kMenuBarCmdLast) {
        return false;
    }
    if (!win->hwndMenuToolbar) {
        return false;
    }

    int menuCount = GetMenuItemCount(win->menu);
    int menuIdx = cmdId - kMenuBarCmdFirst;

    // if same button was clicked shortly after dismissing its popup, treat as toggle-close
    u64 now = GetTickCount64();
    if (menuIdx == gMenuBarLastDismissedIdx && (now - gMenuBarLastDismissedTick) < 500) {
        gMenuBarLastDismissedIdx = -1;
        return true;
    }

    UINT flags = TPM_LEFTALIGN | TPM_TOPALIGN;
    if (IsUIRtl()) {
        flags = TPM_RIGHTALIGN | TPM_TOPALIGN;
    }

    for (;;) {
        HMENU subMenu = GetSubMenu(win->menu, menuIdx);
        if (!subMenu) {
            return true;
        }

        // get button rect in screen coordinates
        int btnCmdId = kMenuBarCmdFirst + menuIdx;
        int btnIdx = (int)SendMessageW(win->hwndMenuToolbar, TB_COMMANDTOINDEX, btnCmdId, 0);
        Rect btnRect = TbGetItemRect(win->hwndMenuToolbar, btnIdx);
        btnRect = HwndMapRectToWindow(btnRect, win->hwndMenuToolbar, HWND_DESKTOP);

        gMenuBarPopupNav.win = win;
        gMenuBarPopupNav.rootMenu = subMenu;
        gMenuBarPopupNav.currentMenu = subMenu;
        gMenuBarPopupNav.currentFlags = 0;
        gMenuBarPopupNav.nextMenuIdx = menuIdx;

        HHOOK hook = SetWindowsHookExW(WH_MSGFILTER, MenuBarMsgFilterHook, nullptr, GetCurrentThreadId());
        TrackPopupMenu(subMenu, flags, btnRect.x, btnRect.y + btnRect.dy, 0, win->hwndFrame, nullptr);
        if (hook) {
            UnhookWindowsHookEx(hook);
        }

        int nextMenuIdx = gMenuBarPopupNav.nextMenuIdx;
        gMenuBarPopupNav = {};
        if (nextMenuIdx == menuIdx || menuCount <= 1) {
            gMenuBarLastDismissedIdx = menuIdx;
            gMenuBarLastDismissedTick = GetTickCount64();
            break;
        }
        menuIdx = nextMenuIdx;
    }

    return true;
}

// Activate a menu bar button by accelerator key (Alt+letter).
// If accel is 0, activate the first menu item.
// Returns true if handled.
bool ActivateMenuBarByAccel(MainWindow* win, WCHAR accel) {
    if (!win->hwndMenuToolbar || !win->menu) {
        return false;
    }

    int count = GetMenuItemCount(win->menu);
    if (count <= 0) {
        return false;
    }

    // if accel is 0 (bare Alt press), open the first menu
    if (accel == 0) {
        return HandleMenuBarCommand(win, kMenuBarCmdFirst);
    }

    // normalize to uppercase for matching
    if (accel >= 'a' && accel <= 'z') {
        accel -= 'a' - 'A';
    }

    // find the menu item whose text has &<accel>
    MENUITEMINFOW mii{};
    mii.cbSize = sizeof(MENUITEMINFOW);
    mii.fMask = MIIM_STRING;

    for (int i = 0; i < count && i < (kMenuBarCmdLast - kMenuBarCmdFirst); i++) {
        mii.dwTypeData = nullptr;
        mii.cch = 0;
        GetMenuItemInfoW(win->menu, i, TRUE, &mii);
        if (!mii.cch) {
            continue;
        }
        mii.cch++;
        WCHAR* name = AllocArrayTemp<WCHAR>((int)mii.cch);
        mii.dwTypeData = name;
        GetMenuItemInfoW(win->menu, i, TRUE, &mii);

        // look for &X where X matches accel
        WStr menuName(name, len(WStr(name)));
        for (int off = 0; off < menuName.len; off++) {
            if (menuName.s[off] == L'&' && off + 1 < menuName.len) {
                WCHAR ch = menuName.s[off + 1];
                if (ch >= 'a' && ch <= 'z') {
                    ch -= 'a' - 'A';
                }
                if (ch == accel) {
                    return HandleMenuBarCommand(win, kMenuBarCmdFirst + i);
                }
                break;
            }
        }
    }

    return false;
}
