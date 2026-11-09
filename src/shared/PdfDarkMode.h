/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

class EngineBase;
struct RenderPageArgs;
struct Pixmap;
struct fz_context;
struct fz_image;

enum class DocumentColorsFollowTheme {
    Off = 0,
    Smart = 1,
    Legacy = 2,
};

// Per-render dark mode path (View target only for Smart/Legacy PDF paths).
enum class PageColorMode {
    Normal,
    LegacyInvert,
    PreserveImages,
};

enum class ViewEngineClass : u32 {
    Image,
    Pdfium,
    Mupdf,
    Fixed,
    Reflowable,
    Captured,
};

enum class PageColorSource {
    Document,
    Bitmap,
};

enum class PageColorPass {
    None,
    Renderer,
    Bitmap,
};

constexpr int kThumbnailImageProbeScale = 4;

// Full-bleed backgrounds / scans at or above this threshold are recolored with the page.
static constexpr float kMaxPreserveImagePageCoverage = 0.75f;

struct DarkModeProfile {
    PageColorMode mode = PageColorMode::Normal;
    Color foreground = 0;
    Color pageBackground = 0;
    Color linkColor = 0;
    bool preservePdfImages = false;
    u32 hash = 0;
};

bool GetPreservePdfImagesInDarkMode();
void SetPreservePdfImagesInDarkMode(bool preserve);
static constexpr int kPreservePdfImagesMinSize = 72;

PageColorPass GetPageColorPass(ViewEngineClass engineClass, PageColorSource source, const DarkModeProfile& profile);
void BuildViewDarkModeProfile(EngineBase* engine, DarkModeProfile* profile);
void BuildViewDarkModeProfile(ViewEngineClass engineClass, DarkModeProfile* profile);
ViewEngineClass ClassifyViewEngine(EngineBase* engine);
struct ViewPageOptions {
    int brightness = 0;
    int contrast = 0;
    bool grayscale = false;
    int imageProbeScale = 1;
};
Pixmap* ApplyViewPageAdjust(Pixmap* bmp, ViewPageOptions options);
Pixmap* RenderViewPage(EngineBase* engine, RenderPageArgs& args, ViewPageOptions options = {});
void CollectThumbnailSkipRects(EngineBase* engine, int pageNo, float zoom, int rotation, const RectF& pageRect,
                               Size bmpSize, Vec<Rect>& skipRects);
bool EngineUsesDocumentColorsFollowTheme(EngineBase* engine);
bool EngineUsesReflowThemeCss(EngineBase* engine);
TempStr ReflowDocumentThemeCssTemp();
bool DocumentColorsFollowThemeEnabled();
DocumentColorsFollowTheme GetDocumentColorsFollowTheme();
DocumentColorsFollowTheme DocumentColorsFollowThemeFromString(Str v);
void SetDocumentColorsFollowTheme(DocumentColorsFollowTheme mode);
void SetDocumentColorsFollowThemePreview(DocumentColorsFollowTheme mode);
void ClearDocumentColorsFollowThemePreview();
u32 PdfDarkModeComputeOptionsHash();

bool PdfDarkModeIsDecorativeStripImage(const RectF& imgRect, const RectF& pageBounds);

bool PdfDarkModeImageLooksLikeDarkArtwork(fz_context* ctx, fz_image* image, float pageCoverage);
bool PdfDarkModePageDominantImageRecolors(fz_context* ctx, fz_image* image, float pageCoverage);

RectF PdfDarkModeClampImagePageRect(const RectF& imgPage, int imageW, int imageH);

RectF PdfDarkModeCapUnknownImagePageRect(const RectF& imgPage, float pageHeight);

bool PdfDarkModeShouldPreserveEmbeddedImageRect(fz_context* ctx, fz_image* image, float pageCoverage, int devW,
                                                int devH);
bool PdfDarkModeShouldPreserveImagePixels(const u8* data, int w, int h, int stride, int bytesPerPixel,
                                          float pageCoverage);
inline bool PdfDarkModeKeepLargestRect(Vec<Rect>& rects) {
    if (len(rects) <= 1) {
        return false;
    }
    int bestIdx = 0;
    i64 bestArea = 0;
    for (int i = 0; i < len(rects); i++) {
        i64 area = (i64)rects[i].dx * rects[i].dy;
        if (area > bestArea) {
            bestArea = area;
            bestIdx = i;
        }
    }
    Rect keep = rects[bestIdx];
    VecClear(rects);
    VecAppend(rects, keep);
    return true;
}
