/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"

#include "gui/UIModels.h"

#include "Settings.h"
#include "AppSettings.h"
#include "DocController.h"
#include "Theme.h"
#include "EngineBase.h"
#include "base/GuessFileType.h"
#include "EngineAll.h"
#include "PdfDarkMode.h"

bool DarkModeProfileUsesLegacyPostProcess(const DarkModeProfile* profile) {
    if (!profile) {
        return false;
    }
    return profile->mode == PageColorMode::LegacyInvert || profile->mode == PageColorMode::PreserveImages;
}

static u32 HashDarkModeProfile(const DarkModeProfile& profile) {
    auto mix = [](u32 h, u32 v) -> u32 { return (h * 31) + v; };
    u32 h = 0;
    h = mix(h, (u32)profile.mode);
    h = mix(h, (u32)profile.foreground);
    h = mix(h, (u32)profile.pageBackground);
    h = mix(h, (u32)profile.linkColor);
    h = mix(h, (u32)profile.preservePdfImages);
    return h;
}

void BuildViewDarkModeProfile(EngineBase* engine, DarkModeProfile* profile) {
    ReportIf(!profile);
    if (!profile) {
        return;
    }
    *profile = DarkModeProfile{};

    // unlike the fork's themes, master's themes never touch page colors:
    // dark pages come from DocumentColorsFollowTheme or custom dark
    // FixedPageUI colors, so key the dark modes off the effective page
    // background rather than the window chrome
    Color bgCol;
    Color textCol = ThemePageRenderColors(bgCol);
    bool pagesDark = !IsLightColor(bgCol);
    profile->foreground = textCol;
    profile->pageBackground = bgCol;
    profile->linkColor = pagesDark ? ThemeWindowLinkColor() : 0;
    profile->preservePdfImages = GetPreservePdfImagesInDarkMode();

    bool recolorPages = pagesDark;
#if defined(SOLOKPDF_PDFIUM) && !defined(SUMATRA_NG)
    // PDFium pages keep photo colors on light themes (Solarized Light) too
    if (engine && engine->kind == kindEnginePdfium) {
        recolorPages = (textCol & 0xffffff) != kColBlack || (bgCol & 0xffffff) != kColWhite;
    }
#endif

    // Reflowable documents get theme colors through CSS; bitmap recoloring would invert their images.
    if (recolorPages && EngineUsesDocumentColorsFollowTheme(engine) && !EngineUsesReflowThemeCss(engine)) {
        bool preserve =
            GetDocumentColorsFollowTheme() != DocumentColorsFollowTheme::Legacy && profile->preservePdfImages;
        profile->mode = preserve ? PageColorMode::PreserveImages : PageColorMode::LegacyInvert;
    }

    profile->hash = HashDarkModeProfile(*profile);
}

bool EngineUsesDocumentColorsFollowTheme(EngineBase* engine) {
    if (!engine || engine->isImageCollection) {
        return false;
    }
#if defined(SOLOKPDF_PDFIUM) && !defined(SUMATRA_NG)
    if (engine->kind == kindEnginePdfium) {
        return true;
    }
#endif
    // Native HTML engines need the same bitmap recoloring as PDF and DjVu.
    return engine->kind == kindEngineMupdf || engine->kind == kindEngineDjVu || engine->kind == kindEngineChm ||
           engine->kind == kindEngineEpub || engine->kind == kindEngineFb2 || engine->kind == kindEngineMobi ||
           engine->kind == kindEnginePdb || engine->kind == kindEngineHtml;
}

bool EngineUsesReflowThemeCss(EngineBase* engine) {
    return engine && engine->kind == kindEngineMupdf && engine->isReflowable;
}
