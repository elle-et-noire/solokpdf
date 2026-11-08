/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
License: GPLv3 */

void SetTheme(Str name);
void SetCurrentThemeFromSettings();
void SetThemeByIndex(int themeIdx);
int ThemeGetCount();
Str ThemeGetNameAt(int idx);
int ThemeGetCurrentIndex();
void ToggleLightDarkTheme();
Str CycleTheme(int step);
Str ToggleLightDarkThemeTargetName();
void SumatraUpdateTheme();
void UpdateThemeAfterSystemColorChange();
void UpdateThemeAfterHighContrastChange();
bool ThemeUsesHighContrastColors();
#if IS_DEBUG
bool ThemeHighContrast_UnitTest();
#endif
void CreateThemeCommands();

Color ThemeDocumentColors(Color&);
Color ThemePageRenderColors(Color&);
Color ThemeMainWindowBackgroundColor();
Color ThemeCanvasColor();
Color ThemeControlBackgroundColor();
Color ThemeWindowBackgroundColor();
Color ThemeWindowTextColor();
Color ThemeWindowTextDisabledColor();
// the colors the OS draws its own UI in (Theme.cpp); the default theme and
// high contrast mode defer to them
Color SysWindowBgColor();
Color SysWindowTextColor();
Color SysControlTextColor();
Color SysDisabledTextColor();
Color SysLinkColor();
Color SysHighlightBgColor();
Color SysHighlightTextColor();
Color ThemeWindowDarkerTextColor();
Color ThemeWindowControlBackgroundColor();
Color ThemeActiveTabBackgroundColor();
Color ThemeInactiveTabBackgroundColor();
Color ThemeTabStripColor();
Color ThemeWindowLinkColor();
Color ThemeHotBackgroundColor();
Color ThemeSelectedBackgroundColor();
Color ThemeSelectedColorOn(Color bg);
Color ThemeSelectionBg(Color bg);
Color ThemeSelectionText(Color bg, Color text);
Color ThemeCardColorOn(Color page);
Color ThemeTextSelectionColorOn(Color page);
Color ThemeInkOn(Color bg);
Color ThemeHoverColorOn(Color bg);
Color ThemeSidebarColor();
Color ThemeEdgeColor();
Color ThemeAccentColor();
Color ThemeHotEdgeColor();
Color ThemeDisabledEdgeColor();
Color ThemeErrorBackgroundColor();
Color ThemeNotificationsBackgroundColor();
Color ThemeNotificationsTextColor();
Color ThemeNotificationsHighlightColor();
Color ThemeNotificationsHighlightTextColor();
Color ThemeHoverPreviewBackgroundColor();
Color ThemeHoverPreviewEdgeColor();
Color ThemeNotificationsHighlightLinkColor();
Color ThemeNotificationsProgressColor();
bool ThemeColorizeControls();
bool ThemeTintsScrollbars();
Color ThemeScrollbarColor();
Color ThemeScrollbarThumbColor();
bool IsCurrentThemeDefault();
void FreeThemes();
#if IS_DEBUG
bool ThemeFree_UnitTest();
#endif
bool MigrateRenamedThemeNames();
bool GetInvertPageColors();
void SetInvertPageColors(bool);

struct VirtButton;
struct PlatformFont;

VirtButton* NewThemedButton(HWND hwndForDpi, Str text, PlatformFont*, bool isDefault);

extern int gFirstSetThemeCmdId;
extern int gLastSetThemeCmdId;
extern int gCurrSetThemeCmdId;
