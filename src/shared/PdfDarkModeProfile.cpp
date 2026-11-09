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

// Cached thumbnails start from neutral pixels, including PDFs using smart colors.
PageColorPass GetPageColorPass(ViewEngineClass engineClass, PageColorSource source, const DarkModeProfile& profile) {
    if (source == PageColorSource::Bitmap) {
        return engineClass == ViewEngineClass::Image || engineClass == ViewEngineClass::Captured
                   ? PageColorPass::None
                   : PageColorPass::Bitmap;
    }

    bool pdf = engineClass == ViewEngineClass::Pdfium || engineClass == ViewEngineClass::Mupdf;
    if (pdf && profile.mode == PageColorMode::PreserveImages) {
        return PageColorPass::Renderer;
    }
    return pdf || engineClass == ViewEngineClass::Fixed ? PageColorPass::Bitmap : PageColorPass::None;
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

ViewEngineClass ClassifyViewEngine(EngineBase* engine) {
    if (!engine || engine->isImageCollection) {
        return ViewEngineClass::Image;
    }
    if (EngineUsesReflowThemeCss(engine)) {
        return ViewEngineClass::Reflowable;
    }
#if defined(SOLOKPDF_PDFIUM) && !defined(SUMATRA_NG)
    if (engine->kind == kindEnginePdfium && IsPdfPageEngine(engine->kind)) {
        return ViewEngineClass::Pdfium;
    }
#endif
    if (IsPdfPageEngine(engine->kind)) {
        return ViewEngineClass::Mupdf;
    }
    return EngineUsesDocumentColorsFollowTheme(engine) ? ViewEngineClass::Fixed : ViewEngineClass::Image;
}

void BuildViewDarkModeProfile(ViewEngineClass engineClass, DarkModeProfile* profile) {
    ReportIf(!profile);
    if (!profile) {
        return;
    }
    *profile = DarkModeProfile{};

    Color bgCol;
    Color textCol = ThemePageRenderColors(bgCol);
    bool pagesDark = !IsLightColor(bgCol);
    profile->foreground = textCol;
    profile->pageBackground = bgCol;
    profile->linkColor = pagesDark ? ThemeWindowLinkColor() : 0;
    profile->preservePdfImages = GetPreservePdfImagesInDarkMode();

    bool recolorPages = (textCol & 0xffffff) != kColBlack || (bgCol & 0xffffff) != kColWhite;

    // Reflowable documents get theme colors through CSS; bitmap recoloring would invert their images.
    bool recolorable = engineClass == ViewEngineClass::Pdfium || engineClass == ViewEngineClass::Mupdf ||
                       engineClass == ViewEngineClass::Fixed;
    if (recolorPages && recolorable) {
        bool preserve =
            GetDocumentColorsFollowTheme() != DocumentColorsFollowTheme::Legacy && profile->preservePdfImages;
        profile->mode = preserve ? PageColorMode::PreserveImages : PageColorMode::LegacyInvert;
    }

    profile->hash = HashDarkModeProfile(*profile);
}

void BuildViewDarkModeProfile(EngineBase* engine, DarkModeProfile* profile) {
    BuildViewDarkModeProfile(ClassifyViewEngine(engine), profile);
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
