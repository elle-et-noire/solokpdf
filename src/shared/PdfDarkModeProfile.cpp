/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"

#include "gui/UIModels.h"

#include "Settings.h"
#include "AppSettings.h"
#include "DocController.h"
#include "EngineBase.h"
#include "base/GuessFileType.h"
#include "EngineAll.h"
#include "PdfDarkMode.h"

// Cached thumbnails start from neutral pixels, including PDFs using smart colors.
// Reflowable ones were drawn with the theme CSS already (E46).
PageColorPass GetPageColorPass(ViewEngineClass engineClass, PageColorSource source, const DarkModeProfile& profile) {
    if (source == PageColorSource::Bitmap) {
        bool themed = engineClass == ViewEngineClass::Image || engineClass == ViewEngineClass::Captured ||
                      engineClass == ViewEngineClass::Reflowable;
        return themed ? PageColorPass::None : PageColorPass::Bitmap;
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

void BuildViewDarkModeProfile(ViewEngineClass engineClass, const PageColorInput& colors, DarkModeProfile* profile) {
    ReportIf(!profile);
    if (!profile) {
        return;
    }
    *profile = DarkModeProfile{};

    profile->foreground = colors.foreground;
    profile->pageBackground = colors.pageBackground;
    profile->linkColor = colors.linkColor;
    profile->preservePdfImages = colors.mode != DocumentColorsFollowTheme::Legacy;

    bool recolorPages = (colors.foreground & 0xffffff) != kColBlack || (colors.pageBackground & 0xffffff) != kColWhite;

    // Reflowable documents get theme colors through CSS; bitmap recoloring would invert their images.
    bool recolorable = engineClass == ViewEngineClass::Pdfium || engineClass == ViewEngineClass::Mupdf ||
                       engineClass == ViewEngineClass::Fixed;
    if (recolorPages && recolorable) {
        profile->mode = profile->preservePdfImages ? PageColorMode::PreserveImages : PageColorMode::LegacyInvert;
    }

    profile->hash = HashDarkModeProfile(*profile);
}

void BuildViewDarkModeProfile(EngineBase* engine, DarkModeProfile* profile) {
    const PageColorInput colors = CapturePageColors();
    BuildViewDarkModeProfile(ClassifyViewEngine(engine), colors, profile);
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

// Home thumbnails of reflowable documents must not be recolored on top of their theme CSS
bool PdfDarkMode_UnitTestThumbnailPass() {
    PageColorInput dark;
    dark.mode = DocumentColorsFollowTheme::Smart;
    dark.foreground = 0xe0e0e0;
    dark.pageBackground = 0x202020;
    DarkModeProfile profile;
    BuildViewDarkModeProfile(ViewEngineClass::Reflowable, dark, &profile);
    bool ok = GetPageColorPass(ViewEngineClass::Reflowable, PageColorSource::Bitmap, profile) == PageColorPass::None;
    BuildViewDarkModeProfile(ViewEngineClass::Mupdf, dark, &profile);
    return ok && GetPageColorPass(ViewEngineClass::Mupdf, PageColorSource::Bitmap, profile) == PageColorPass::Bitmap;
}
