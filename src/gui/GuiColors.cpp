/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

#include "base/Base.h"

#include "gui/GuiColors.h"

Color gColsText[kColTextCount];
Color gColsLink[kColTextCount];
Color gColsBtn[kColBtnCount];
Color gColsBtnDefault[kColBtnCount];
Color gColsIconBtn[kColIconBtnCount];
Color gColsCloseBtn[kColCloseCount];
Color gColsListBox[kColListCount];
Color gColsSplitter[kColSplitterCount];
Color gColsFill[kColFillCount];
Color gColsLine[kColLineCount];
Color gColsSlider[kColSliderCount];
Color gColsRichText[kColRichCount];
Color gColsTab[kColTabCount];
Color gColsWin[kColWinCount];
Color gColsEdit[kColEditCount];

Color gColsTextMuted[kColTextCount];
Color gColsRichTextMuted[kColRichCount];
Color gColsRichTextRaised[kColRichCount];
Color gColsRichTextRaisedMuted[kColRichCount];
Color gColsListBoxRaised[kColListCount];
Color gColsBtnFilled[kColBtnCount];
Color gColsBtnFilledOff[kColBtnCount];
Color gColsBtnOutline[kColBtnCount];
Color gColsBtnGhost[kColBtnCount];

// An override wins unless its slot is kColorUnset, which means "I didn't say".
// kColorTransparent is a decision ("don't paint this") so it does not fall
// through to the default.
Color GetCol(const Color* defaults, const Color* overrides, int idx) {
    if (overrides) {
        Color c = overrides[idx];
        if (c != kColorUnset) {
            return c;
        }
    }
    if (!defaults) {
        return kColorUnset;
    }
    return defaults[idx];
}

// The look of the ✕ that closes a tab / panel / notification doesn't come from
// the system palette: a gray glyph that turns white on a red circle when
// hovered, the same in every theme.
constexpr Color kColCloseXDef = MkRgb(0xa0, 0xa0, 0xa0);
constexpr Color kColCloseXHoverDef = MkRgb(0xf9, 0xeb, 0xeb);      // white-ish
constexpr Color kColCloseCircleHoverDef = MkRgb(0xC1, 0x35, 0x35); // red-ish

static bool gDefaultColorsInited = false;

bool gGuiColorsFromSystem = true;

// Every window and control calls this on the way up, so an app that never
// themes anything (the installer, the log viewer) still gets real colors
// without having to know that gui/ has a palette at all.
void GuiColorsInitIfNeeded() {
    if (!gDefaultColorsInited) {
        GuiSetDefaultColorsFromSystem();
    }
}

// The platform UI colors spread over the per-control defaults. On POSIX we use
// a neutral light palette until the native app provides its own theme colors.
void GuiSetDefaultColorsFromSystem() {
    gDefaultColorsInited = true;
    gGuiColorsFromSystem = true;
    Color winBg = GetSysColor(COLOR_WINDOW);
    Color winText = GetSysColor(COLOR_WINDOWTEXT);
    Color ctlBg = GetSysColor(COLOR_BTNFACE);
    Color ctlText = GetSysColor(COLOR_BTNTEXT);
    Color disabledText = GetSysColor(COLOR_GRAYTEXT);
    Color link = GetSysColor(COLOR_HOTLIGHT);
    Color edge = GetSysColor(COLOR_WINDOWFRAME);

    gColsText[kColText] = winText;

    gColsLink[kColText] = link;

    gColsBtn[kColBtnText] = ctlText;
    gColsBtn[kColBtnBg] = AccentColor(ctlBg, 14);
    gColsBtn[kColBtnBgHover] = AccentColor(ctlBg, 28);
    gColsBtn[kColBtnBorder] = AccentColor(ctlBg, 40);
    gColsBtn[kColBtnTextDisabled] = disabledText;

    gColsBtnDefault[kColBtnText] = ctlText;
    gColsBtnDefault[kColBtnBg] = AccentColor(ctlBg, 26);
    gColsBtnDefault[kColBtnBgHover] = AccentColor(ctlBg, 40);
    gColsBtnDefault[kColBtnBorder] = AccentColor(ctlBg, 55);
    gColsBtnDefault[kColBtnTextDisabled] = disabledText;

    gColsIconBtn[kColIconBtnBgHover] = AccentColor(ctlBg, 20);
    gColsIconBtn[kColIconBtnBgSelected] = AccentColor(ctlBg, 36);
    gColsIconBtn[kColIconBtnChevron] = ctlText;
    gColsIconBtn[kColIconBtnChevronDisabled] = disabledText;

    gColsCloseBtn[kColCloseX] = kColCloseXDef;
    gColsCloseBtn[kColCloseXHover] = kColCloseXHoverDef;
    // an unhovered circle is only painted by a withCircle button, which sits on
    // content it doesn't own (a thumbnail), so it stays a plain light disc
    gColsCloseBtn[kColCloseCircle] = MkGray(0xff);
    gColsCloseBtn[kColCloseCircleHover] = kColCloseCircleHoverDef;

    gColsListBox[kColListText] = winText;
    gColsListBox[kColListBg] = winBg;
    gColsListBox[kColListSel] = AccentColor(winBg, 25);
    gColsListBox[kColListSelFocused] = AccentColor(winBg, 45);
    gColsListBox[kColListSelText] = winText;
    gColsListBox[kColListScrollbar] = AccentColor(winBg, 60);

    gColsSplitter[kColSplitterBg] = ctlBg;
    gColsSplitter[kColSplitterBgHover] = AccentColor(ctlBg, 30);

    gColsFill[kColFillBg] = ctlBg;

    gColsLine[kColLineFg] = edge;

    gColsSlider[kColSliderTrack] = AccentColor(ctlBg, 40);
    gColsSlider[kColSliderFill] = ctlText;
    gColsSlider[kColSliderThumb] = ctlText;
    gColsSlider[kColSliderThumbHover] = AccentColor(ctlText, 20);

    gColsRichText[kColRichText] = winText;
    gColsRichText[kColRichLink] = link;
    gColsRichText[kColRichBg] = winBg;

    gColsTab[kColTabText] = winText;
    gColsTab[kColTabBg] = ctlBg;

    // a custom top-level window's own surface, like the OS paints a window's
    gColsWin[kColWinText] = winText;
    gColsWin[kColWinBg] = winBg;
    gColsWin[kColWinRaisedBg] = winBg;
    gColsWin[kColWinMutedText] = disabledText;
    gColsWin[kColWinSelectedBg] = AccentColor(winBg, 25);
    gColsWin[kColWinRaisedSelectedBg] = AccentColor(winBg, 25);
    // the system's own combobox colors
    gColsWin[kColWinComboText] = kColorUnset;
    gColsWin[kColWinComboBg] = kColorUnset;

    gColsEdit[kColEditBottomBorder] = edge;
    GuiDeriveRolePalettes();
}

constexpr int kStyledBtnHoverShift = 14;
// a black fill moved by 14 is still black; hover has to read as a lighter gray
constexpr int kFilledDarkHoverShift = 48;
constexpr int kFilledOffShift = 28;

static void SetRichCols(Color* cols, Color text, Color bg) {
    cols[kColRichText] = text;
    cols[kColRichLink] = text;
    cols[kColRichBg] = bg;
}

static void SetBtnCols(Color* cols, Color fg, Color bg, Color border, int hoverShift) {
    cols[kColBtnText] = fg;
    cols[kColBtnBg] = bg;
    cols[kColBtnBgHover] = AccentColor(bg, hoverShift);
    cols[kColBtnBorder] = border;
    cols[kColBtnTextDisabled] = gColsBtn[kColBtnTextDisabled];
}

// The role palettes follow from the base slots; whoever pushes those (the
// system defaults, an app's theme) calls this last
void GuiDeriveRolePalettes() {
    Color text = gColsWin[kColWinText];
    Color muted = gColsWin[kColWinMutedText];
    Color bg = gColsWin[kColWinBg];
    Color raised = gColsWin[kColWinRaisedBg];

    gColsTextMuted[kColText] = muted;
    SetRichCols(gColsRichTextMuted, muted, bg);
    SetRichCols(gColsRichTextRaised, text, raised);
    SetRichCols(gColsRichTextRaisedMuted, muted, raised);
    for (int i = 0; i < kColListCount; i++) {
        gColsListBoxRaised[i] = gColsListBox[i];
    }
    gColsListBoxRaised[kColListBg] = raised;

    // the one action filled with the text color, Cancel outlined, the quiet
    // ones words that fill on hover. Full text color on those: a muted label
    // is indistinguishable from the disabled one once that is lifted off the
    // background (#6478)
    int filledHover = IsLightColor(text) ? kStyledBtnHoverShift : kFilledDarkHoverShift;
    SetBtnCols(gColsBtnFilled, bg, text, text, filledHover);
    SetBtnCols(gColsBtnFilledOff, bg, AccentColor(bg, kFilledOffShift), kColorTransparent, kStyledBtnHoverShift);
    SetBtnCols(gColsBtnOutline, text, bg, gColsLine[kColLineFg], kStyledBtnHoverShift);
    SetBtnCols(gColsBtnGhost, text, bg, kColorTransparent, kStyledBtnHoverShift);
}
