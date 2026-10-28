/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include "base/Base.h"
#include "base/Crypto.h"
#include "base/File.h"
#include "base/GuessFileType.h"
#include "base/Pixmap.h"
#include "base/Timer.h"
#include "gui/UIModels.h"
#include "DocProperties.h"
#include "EngineBase.h"
#include "EngineAll.h"
#include "Settings.h"
#include "PdfDarkMode.h"
#include <psapi.h>
#include <fpdfview.h>
#include <fpdf_annot.h>
#include <fpdf_attachment.h>
#include <fpdf_doc.h>
#include <fpdf_edit.h>
#include <fpdf_formfill.h>
#include <fpdf_javascript.h>
#include <fpdf_signature.h>
#include <fpdf_text.h>
#include <fpdf_progressive.h>
#include <fpdf_sysfontinfo.h>
#include "PdfiumFontCache.h"
#include "EnginePdfium.h"
#include "SumatraLog.h"

#define PDFIUM_API(X)                   \
    X(FPDF_InitLibraryWithConfig)       \
    X(FPDF_DestroyLibrary)              \
    X(FPDF_GetDefaultSystemFontInfo)    \
    X(FPDF_SetSystemFontInfo)           \
    X(FPDF_FreeDefaultSystemFontInfo)   \
    X(FPDF_LoadCustomDocument)          \
    X(FPDF_LoadMemDocument)             \
    X(FPDF_CloseDocument)               \
    X(FPDF_GetLastError)                \
    X(FPDF_GetPageCount)                \
    X(FPDF_GetDocPermissions)           \
    X(FPDF_GetSecurityHandlerRevision)  \
    X(FPDF_GetPageSizeByIndexF)         \
    X(FPDF_LoadPage)                    \
    X(FPDF_ClosePage)                   \
    X(FPDF_PageToDevice)                \
    X(FPDFPage_CountObjects)            \
    X(FPDFPage_GetObject)               \
    X(FPDFPageObj_GetType)              \
    X(FPDFPageObj_GetMatrix)            \
    X(FPDFFormObj_CountObjects)         \
    X(FPDFFormObj_GetObject)            \
    X(FPDFImageObj_GetImageMetadata)    \
    X(FPDFImageObj_GetImagePixelSize)   \
    X(FPDFImageObj_GetBitmap)           \
    X(FPDFBitmap_GetFormat)             \
    X(FPDFBitmap_GetBuffer)             \
    X(FPDFBitmap_GetWidth)              \
    X(FPDFBitmap_GetHeight)             \
    X(FPDFBitmap_GetStride)             \
    X(FPDFBitmap_CreateEx)              \
    X(FPDFBitmap_Destroy)               \
    X(FPDF_RenderPageBitmap_Start)      \
    X(FPDF_RenderPage_Continue)         \
    X(FPDF_RenderPage_Close)            \
    X(FPDFText_LoadPage)                \
    X(FPDFText_ClosePage)               \
    X(FPDFText_CountChars)              \
    X(FPDFText_GetUnicode)              \
    X(FPDFText_GetCharBox)              \
    X(FPDFText_GetMatrix)               \
    X(FPDFText_GetCharOrigin)           \
    X(FPDFText_GetFontSize)             \
    X(FPDFText_GetTextObject)           \
    X(FPDFTextObj_GetFont)              \
    X(FPDFFont_GetAscent)               \
    X(FPDFFont_GetDescent)              \
    X(FPDFFont_GetGlyphWidth)           \
    X(FPDFLink_Enumerate)               \
    X(FPDFLink_GetAnnotRect)            \
    X(FPDFLink_GetDest)                 \
    X(FPDFLink_GetAction)               \
    X(FPDFLink_GetAnnot)                \
    X(FPDFAnnot_GetStringValue)         \
    X(FPDFPage_GetAnnotCount)           \
    X(FPDFPage_GetAnnot)                \
    X(FPDFAnnot_GetSubtype)             \
    X(FPDFPage_CloseAnnot)              \
    X(FPDFAction_GetType)               \
    X(FPDFAction_GetDest)               \
    X(FPDFAction_GetURIPath)            \
    X(FPDFAction_GetFilePath)           \
    X(FPDFDest_GetDestPageIndex)        \
    X(FPDFDest_GetLocationInPage)       \
    X(FPDFDest_GetView)                 \
    X(FPDF_GetNamedDestByName)          \
    X(FPDFBookmark_GetFirstChild)       \
    X(FPDFBookmark_GetNextSibling)      \
    X(FPDFBookmark_GetTitle)            \
    X(FPDFBookmark_GetDest)             \
    X(FPDFBookmark_GetAction)           \
    X(FPDF_GetMetaText)                 \
    X(FPDF_GetPageLabel)                \
    X(FPDF_GetFormType)                 \
    X(FPDFDoc_GetJavaScriptActionCount) \
    X(FPDF_GetSignatureCount)           \
    X(FPDFDoc_GetAttachmentCount)       \
    X(FPDFDOC_InitFormFillEnvironment)  \
    X(FPDFDOC_ExitFormFillEnvironment)  \
    X(FORM_OnAfterLoadPage)             \
    X(FORM_OnBeforeClosePage)           \
    X(FPDF_FFLDraw)

Kind kindEnginePdfium = "enginePdfium";

// PDFium forbids concurrent calls even for different documents.
static Mutex gPdfiumLock;
static Str gFontCacheDir;
static Str kPdfiumVersion = StrL("158.0.8111.0");

static bool FontCacheEnabled() {
    WCHAR value[2]{};
    bool off = GetEnvironmentVariableW(L"SOLOKPDF_FONT_CACHE", value, dimofi(value)) == 1 && value[0] == L'0';
    return !off && len(gFontCacheDir) > 0;
}

static struct PdfiumApi {
    HMODULE module = nullptr;
    int users = 0;
    FPDF_SYSFONTINFO* defaultFontInfo = nullptr;
    PdfiumFontCache* fontCache = nullptr;
#define DECLARE_PDFIUM(name) decltype(&::name) name = nullptr;
    PDFIUM_API(DECLARE_PDFIUM)
#undef DECLARE_PDFIUM

    bool Acquire(TempStr* error) {
        if (!module) {
            WCHAR dllPath[32768]{};
            DWORD n = GetModuleFileNameW(nullptr, dllPath, dimofi(dllPath));
            WCHAR* slash = wcsrchr(dllPath, L'\\');
            if (!n || n >= dimofi(dllPath) || !slash) {
                *error = StrL("Cannot locate application directory for PDFium.");
                return false;
            }
            wcscpy_s(slash + 1, dimofi(dllPath) - (slash + 1 - dllPath), L"pdfium.dll");
            module = LoadLibraryExW(dllPath, nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
            if (!module) {
                DWORD code = GetLastError();
                *error = fmt("Cannot load PDFium DLL '%s' (Windows error %lu). Run bun cmd/solok-build.ts.",
                             ToUtf8Temp(WStr(dllPath)), code);
                return false;
            }
#define LOAD_PDFIUM(name)                                                     \
    name = reinterpret_cast<decltype(name)>(GetProcAddress(module, #name));   \
    if (!name) {                                                              \
        *error = fmt("PDFium DLL is incompatible: missing %s.", StrL(#name)); \
        FreeLibrary(module);                                                  \
        module = nullptr;                                                     \
        return false;                                                         \
    }
            PDFIUM_API(LOAD_PDFIUM)
#undef LOAD_PDFIUM
        }
        if (users == 0) {
            FPDF_LIBRARY_CONFIG config{};
            config.version = 2;
            FPDF_InitLibraryWithConfig(&config);
            InstallFontCache();
        }
        users++;
        return true;
    }

    void InstallFontCache() {
        if (!FontCacheEnabled()) {
            return;
        }
        defaultFontInfo = FPDF_GetDefaultSystemFontInfo();
        if (!defaultFontInfo) {
            return;
        }
        TempStr path = path::JoinTemp(gFontCacheDir, StrL("pdfium-fonts.cache"));
        fontCache = PdfiumFontCacheNew(defaultFontInfo, path, kPdfiumVersion);
        FPDF_SetSystemFontInfo(PdfiumFontCacheInfo(fontCache));
    }

    void Release() {
        if (--users > 0) {
            return;
        }
        FPDF_DestroyLibrary();
        if (defaultFontInfo) {
            FPDF_FreeDefaultSystemFontInfo(defaultFontInfo);
            defaultFontInfo = nullptr;
        }
        PdfiumFontCacheDelete(fontCache);
        fontCache = nullptr;
    }
} gPdfium;

struct PdfiumPage {
    SizeF size;
    bool linksLoaded = false;
    bool hasFileAttachments = false;
    bool attachmentLinksLoaded = false;
    Vec<IPageElement*> links;
    // photos a themed page keeps in their colors, in page space
    bool imagesLoaded = false;
    Vec<RectF> images;
};

struct PdfiumProfile {
    Str operation;
    int pageNo;
    TimeStamp start{};
    bool enabled;

    PdfiumProfile(Str operation, int pageNo = 0) : operation(operation), pageNo(pageNo) {
        static bool requested = [] {
            WCHAR value[2]{};
            return GetEnvironmentVariableW(L"SOLOKPDF_PROFILE", value, dimofi(value)) == 1 && value[0] == L'1';
        }();
        enabled = requested;
        if (enabled) {
            start = TimeGet();
        }
    }

    void Mark(Str phase) {
        if (!enabled) {
            return;
        }
        PROCESS_MEMORY_COUNTERS_EX memory{};
        memory.cb = sizeof(memory);
        if (GetProcessMemoryInfo(GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS*)&memory, memory.cb)) {
            logf("PDFium profile: %s thread=%lu page=%d %s=%.3f ms private=%llu working=%llu\n", operation,
                 GetCurrentThreadId(), pageNo, phase, TimeSinceInMs(start), (u64)memory.PrivateUsage,
                 (u64)memory.WorkingSetSize);
        }
        start = TimeGet();
    }
};

struct PdfiumBufferTrace {
    u64 bytes = 0;

    PdfiumBufferTrace(Pixmap* p, const PdfiumProfile& profile) {
        if (profile.enabled) {
            bytes = (u64)p->stride * p->height;
            logf("PDFium buffer: thread=%lu delta=%lld\n", GetCurrentThreadId(), (i64)bytes);
        }
    }

    ~PdfiumBufferTrace() {
        if (bytes) {
            logf("PDFium buffer: thread=%lu delta=%lld\n", GetCurrentThreadId(), -(i64)bytes);
        }
    }
};

// Pack opaque pixels in place. Cancellation leaves a partial buffer to discard.
static bool CompactOpaquePixmap(Pixmap* pixmap, AtomicInt* aborted) {
    const int srcBpp = PixmapBytesPerPixel(PixmapFormat::BGRA8);
    const int dstBpp = PixmapBytesPerPixel(PixmapFormat::BGR8);
    constexpr int kRowAlign = sizeof(u32);
    int stride = (pixmap->width * dstBpp + kRowAlign - 1) & ~(kRowAlign - 1);
    for (int y = 0; y < pixmap->height; y++) {
        if (AtomicIntGet(aborted)) {
            return false;
        }
        const u8* src = pixmap->data + (size_t)y * pixmap->stride;
        u8* dst = pixmap->data + (size_t)y * stride;
        for (int x = 0; x < pixmap->width; x++, src += srcBpp, dst += dstBpp) {
            dst[0] = src[0];
            dst[1] = src[1];
            dst[2] = src[2];
        }
        memset(dst, 0, stride - pixmap->width * dstBpp);
    }
    auto* data = (u8*)realloc(pixmap->data, (size_t)stride * pixmap->height);
    if (data) {
        pixmap->data = data;
    }
    pixmap->stride = stride;
    pixmap->format = PixmapFormat::BGR8;
    return true;
}

// Opaque pixels as a 24-bit DIB section, like MuPDF's tiles: freed whole on eviction instead of
// staying in the heap. Falls back to packing in place if GDI can't make one. nullptr if canceled.
static Pixmap* OpaqueToBgr(Pixmap* src, AtomicInt* aborted) {
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = src->width;
    bmi.bmiHeader.biHeight = -src->height;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 24;
    bmi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HANDLE hMap = nullptr;
    HBITMAP hbmp = CreateMappedDib(&bmi, &bits, &hMap);
    if (!hbmp) {
        if (CompactOpaquePixmap(src, aborted)) {
            return src;
        }
        FreePixmap(src);
        return nullptr;
    }

    Pixmap* dst = PixmapFromHBITMAP(hbmp, Size(src->width, src->height), hMap);
    for (int y = 0; y < src->height; y++) {
        if (AtomicIntGet(aborted)) {
            FreePixmap(dst);
            FreePixmap(src);
            return nullptr;
        }
        const u8* s = src->data + (size_t)y * src->stride;
        u8* d = dst->data + (size_t)y * dst->stride;
        for (int x = 0; x < src->width; x++, s += 4, d += 3) {
            d[0] = s[0];
            d[1] = s[1];
            d[2] = s[2];
        }
    }
    dst->xres = src->xres;
    dst->yres = src->yres;
    FreePixmap(src);
    return dst;
}

class PdfiumCookie : public AbortCookie {
  public:
    AtomicInt aborted = 0;
    IFSDK_PAUSE pause{};
    PdfiumCookie() {
        pause.version = 1;
        pause.user = this;
        pause.NeedToPauseNow = NeedPause;
    }
    static bool IsCanceled(void* user) { return AtomicIntGet(&((PdfiumCookie*)user)->aborted) != 0; }
    static FPDF_BOOL NeedPause(IFSDK_PAUSE* pause) { return IsCanceled(pause->user); }
    void Abort() override { AtomicIntSet(&aborted, 1); }
    void* GetData() override { return &pause; }
};

// same limit as EngineMupdf: smaller files are read into memory
constexpr i64 kMaxMemoryFileSize = 32LL * 1024 * 1024;

// Tile edges are whole screen pixels but come back through the transform as e.g. 5507.9995;
// flooring that drew the tile a pixel off from where RenderCache places it.
constexpr double kPixelSnap = 0.05;

static double SnapFloor(double v) {
    return floor(v + kPixelSnap);
}

static double SnapCeil(double v) {
    return ceil(v - kPixelSnap);
}

// The form fill module only draws widgets for us; it gets no-op versions of the callbacks it requires.
// themed page colors that spare photos (DocumentColorsFollowTheme = smart)
static bool KeepsImageColors(const RenderPageArgs& args) {
    return args.darkProfile && args.darkProfile->mode == PageColorMode::PreserveImages;
}

// a, then b
static FS_MATRIX ConcatMatrix(const FS_MATRIX& a, const FS_MATRIX& b) {
    FS_MATRIX r;
    r.a = a.a * b.a + a.b * b.c;
    r.b = a.a * b.b + a.b * b.d;
    r.c = a.c * b.a + a.d * b.c;
    r.d = a.c * b.b + a.d * b.d;
    r.e = a.e * b.a + a.f * b.c + b.e;
    r.f = a.e * b.b + a.f * b.d + b.f;
    return r;
}

static void FormInvalidate(FPDF_FORMFILLINFO*, FPDF_PAGE, double, double, double, double) {}

static void FormSetCursor(FPDF_FORMFILLINFO*, int) {}

static int FormSetTimer(FPDF_FORMFILLINFO*, int, TimerCallback) {
    return 0;
}

static void FormKillTimer(FPDF_FORMFILLINFO*, int) {}

static FPDF_SYSTEMTIME FormGetLocalTime(FPDF_FORMFILLINFO*) {
    return {};
}

static FPDF_PAGE FormGetPage(FPDF_FORMFILLINFO*, FPDF_DOCUMENT, int) {
    return nullptr;
}

static int FormGetRotation(FPDF_FORMFILLINFO*, FPDF_PAGE) {
    return 0;
}

static void FormExecuteNamedAction(FPDF_FORMFILLINFO*, FPDF_BYTESTRING) {}

class EnginePdfium : public EngineBase {
    FPDF_DOCUMENT doc = nullptr;
    // widgets (form fields) are drawn only through a form handle; null without an AcroForm
    FPDF_FORMFILLINFO formInfo{};
    FPDF_FORMHANDLE form = nullptr;
    bool acroForm = false;
    HANDLE file = INVALID_HANDLE_VALUE;
    Str fileData;
    FPDF_FILEACCESS access{};
    Str password;
    bool runtime = false;
    Vec<PdfiumPage*> pages;
    Vec<IPageDestination*> namedDests;
    StrVec pageLabels;
    TocTree* toc = nullptr;
    bool tocLoaded = false;
    // PDFium can't write most annotation properties, so an EngineMupdf of the file edits them and,
    // once loaded, draws them over PDFium's pages. Saving writes MuPDF's incremental update.
    EngineBase* editor = nullptr;
    bool editorFailed = false;
    Mutex editorLock;

    static int ReadBlock(void* user, unsigned long offset, unsigned char* data, unsigned long count) {
        auto* e = (EnginePdfium*)user;
        if (offset > e->access.m_FileLen || count > e->access.m_FileLen - offset) {
            return 0;
        }
        if (e->fileData.s) {
            memcpy(data, e->fileData.s + offset, count);
            return 1;
        }
        LARGE_INTEGER pos{};
        pos.QuadPart = offset;
        DWORD read = 0;
        return SetFilePointerEx(e->file, pos, nullptr, FILE_BEGIN) && ReadFile(e->file, data, count, &read, nullptr) &&
               read == count;
    }

    // Release the handle of a small file so producers (e.g. LaTeX) can overwrite it while it's shown.
    bool ReadIntoMemory() {
        int n = (int)access.m_FileLen;
        char* d = AllocArray<char>(n + 1);
        DWORD read = 0;
        bool ok = d && ReadFile(file, d, (DWORD)n, &read, nullptr) && read == (DWORD)n;
        CloseHandle(file);
        file = INVALID_HANDLE_VALUE;
        if (!ok) {
            free(d);
            return false;
        }
        fileData = Str(d, n);
        return true;
    }

    PdfiumPage* Page(int pageNo) {
        if (pageNo < 1 || pageNo > pageCount) {
            return nullptr;
        }
        auto*& p = pages[pageNo - 1];
        if (!p) {
            FS_SIZEF size{};
            if (!gPdfium.FPDF_GetPageSizeByIndexF(doc, pageNo - 1, &size) || !isfinite(size.width) ||
                !isfinite(size.height) || size.width <= 0 || size.height <= 0) {
                return nullptr;
            }
            auto* info = new PdfiumPage();
            info->size = SizeF(size.width, size.height);
            // published whole: PageMediabox reads it without the lock
            InterlockedExchangePointer((void* volatile*)&p, info);
        }
        return p;
    }

    PointF ToPage(FPDF_PAGE page, PdfiumPage* info, double x, double y) {
        constexpr int kCoordScale = 1 << 20;
        int px = 0, py = 0;
        if (!gPdfium.FPDF_PageToDevice(page, 0, 0, kCoordScale, kCoordScale, 0, x, y, &px, &py)) {
            return {};
        }
        return PointF((float)(px * (double)info->size.dx / kCoordScale),
                      (float)(py * (double)info->size.dy / kCoordScale));
    }

    RectF ToPageRect(FPDF_PAGE page, PdfiumPage* info, double left, double bottom, double right, double top) {
        return RectF::FromXY(ToPage(page, info, left, bottom), ToPage(page, info, right, top));
    }

    // Caller holds gPdfiumLock. Finds the photos a themed page keeps in their colors, like
    // EngineMupdf; thin strips and 1-bit images (drawn like text) recolor with the page.
    void CollectImages(FPDF_PAGE page, PdfiumPage* info) {
        info->imagesLoaded = true;
        FS_MATRIX identity{1, 0, 0, 1, 0, 0};
        int n = gPdfium.FPDFPage_CountObjects(page);
        for (int i = 0; i < n; i++) {
            AddImages(page, info, gPdfium.FPDFPage_GetObject(page, i), identity, 0);
        }
    }

    // Images in form XObjects are in form space, so `parent` maps it to the page.
    void AddImages(FPDF_PAGE page, PdfiumPage* info, FPDF_PAGEOBJECT obj, const FS_MATRIX& parent, int depth) {
        constexpr int kMaxFormDepth = 16;
        FS_MATRIX m{};
        if (!obj || !gPdfium.FPDFPageObj_GetMatrix(obj, &m)) {
            return;
        }
        m = ConcatMatrix(m, parent);
        int type = gPdfium.FPDFPageObj_GetType(obj);
        if (type == FPDF_PAGEOBJ_FORM && depth < kMaxFormDepth) {
            int n = gPdfium.FPDFFormObj_CountObjects(obj);
            for (int i = 0; i < n; i++) {
                AddImages(page, info, gPdfium.FPDFFormObj_GetObject(obj, (unsigned long)i), m, depth + 1);
            }
            return;
        }
        if (type != FPDF_PAGEOBJ_IMAGE) {
            return;
        }
        FPDF_IMAGEOBJ_METADATA meta{};
        if (gPdfium.FPDFImageObj_GetImageMetadata(obj, page, &meta) && meta.bits_per_pixel == 1) {
            return;
        }

        // an image fills the unit square of its matrix
        PointF c[4];
        double unit[4][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}};
        for (int i = 0; i < 4; i++) {
            double ux = unit[i][0], uy = unit[i][1];
            c[i] = ToPage(page, info, m.a * ux + m.c * uy + m.e, m.b * ux + m.d * uy + m.f);
        }
        RectF pageBounds(0, 0, info->size.dx, info->size.dy);
        RectF r = RectF::FromXY(c[0], c[3]).Union(RectF::FromXY(c[1], c[2])).Intersect(pageBounds);
        if (r.IsEmpty() || PdfDarkModeIsDecorativeStripImage(r, pageBounds)) {
            return;
        }
        float coverage = (r.dx * r.dy) / (pageBounds.dx * pageBounds.dy);
        if (LooksLikePhoto(obj, coverage)) {
            VecAppend(info->images, r);
        }
    }

    // Caller holds gPdfiumLock. Decodes the image for EngineMupdf's photo classifier, which
    // recolors scans, layout panels and figures on a light backdrop with the page.
    bool LooksLikePhoto(FPDF_PAGEOBJECT obj, float coverage) {
        constexpr u64 kMaxDecodePixels = 64 * 1024 * 1024;
        unsigned int w = 0, h = 0;
        if (!gPdfium.FPDFImageObj_GetImagePixelSize(obj, &w, &h) || (u64)w * h > kMaxDecodePixels) {
            return false;
        }
        FPDF_BITMAP bmp = gPdfium.FPDFImageObj_GetBitmap(obj);
        if (!bmp) {
            return false;
        }
        int bytesPerPixel = 0;
        switch (gPdfium.FPDFBitmap_GetFormat(bmp)) {
            case FPDFBitmap_Gray:
                bytesPerPixel = 1;
                break;
            case FPDFBitmap_BGR:
                bytesPerPixel = 3;
                break;
            case FPDFBitmap_BGRx:
            case FPDFBitmap_BGRA:
                bytesPerPixel = 4;
                break;
        }
        bool photo = bytesPerPixel > 0 &&
                     PdfDarkModeShouldPreserveImagePixels(
                         (const u8*)gPdfium.FPDFBitmap_GetBuffer(bmp), gPdfium.FPDFBitmap_GetWidth(bmp),
                         gPdfium.FPDFBitmap_GetHeight(bmp), gPdfium.FPDFBitmap_GetStride(bmp), bytesPerPixel, coverage);
        gPdfium.FPDFBitmap_Destroy(bmp);
        return photo;
    }

    struct PdfiumDest : PageDestination {
        EnginePdfium* engine = nullptr;
        // PDF user-space corners: /FitR uses both, other views only point
        PointF point;
        PointF point2;
        bool hasX = false;
        bool hasY = false;
        bool isRect = false;

        // Normalize coordinates on demand so outlines don't parse unvisited pages.
        RectF GetRect() override {
            ScopedMutex lock(&gPdfiumLock);
            if (!engine) {
                return rect;
            }
            auto* info = engine->Page(pageNo);
            FPDF_PAGE page = info ? gPdfium.FPDF_LoadPage(engine->doc, pageNo - 1) : nullptr;
            if (!page) {
                return rect;
            }
            PointF pt = engine->ToPage(page, info, point.x, point.y);
            if (isRect) {
                rect = RectF::FromXY(pt, engine->ToPage(page, info, point2.x, point2.y));
            } else {
                rect.x = hasX ? pt.x : kDestUseDefault;
                rect.y = hasY ? pt.y : kDestUseDefault;
            }
            gPdfium.FPDF_ClosePage(page);
            engine = nullptr;
            return rect;
        }
    };

    // Same position and zoom as EngineMupdf's DestFromFzLinkDest. PDFium reads a null
    // /FitH top or /FitV left as 0, so 0 counts as unspecified.
    void SetDestView(PdfiumDest* result, FPDF_DEST dest) {
        unsigned long nParams = 0;
        FS_FLOAT params[4]{};
        unsigned long view = gPdfium.FPDFDest_GetView(dest, &nParams, params);
        float zoom = 0.f;
        switch (view) {
            case PDFDEST_VIEW_XYZ: {
                FPDF_BOOL hasX = 0, hasY = 0, hasZoom = 0;
                float x = 0, y = 0;
                if (!gPdfium.FPDFDest_GetLocationInPage(dest, &hasX, &hasY, &hasZoom, &x, &y, &zoom)) {
                    hasX = hasY = hasZoom = 0;
                }
                result->point = PointF(x, y);
                result->hasX = hasX != 0;
                result->hasY = hasY != 0;
                zoom = hasZoom && zoom > 0 ? zoom : 0.f;
                break;
            }
            case PDFDEST_VIEW_FIT:
                zoom = kZoomFitPage;
                break;
            case PDFDEST_VIEW_FITH:
                zoom = kZoomFitWidth;
                result->point.y = params[0];
                result->hasY = nParams >= 1 && params[0] != 0;
                break;
            case PDFDEST_VIEW_FITV:
                zoom = kZoomFitPage;
                result->point.x = params[0];
                result->hasX = nParams >= 1 && params[0] != 0;
                break;
            case PDFDEST_VIEW_FITR:
                result->point = PointF(params[0], params[3]);
                result->point2 = PointF(params[2], params[1]);
                result->isRect = nParams == 4;
                break;
            case PDFDEST_VIEW_FITB:
                zoom = kZoomFitContent;
                break;
            case PDFDEST_VIEW_FITBH:
                zoom = kZoomFitVisible;
                result->point.y = params[0];
                result->hasY = nParams >= 1 && params[0] != 0;
                break;
            case PDFDEST_VIEW_FITBV:
                zoom = kZoomFitContent;
                result->point.x = params[0];
                result->hasX = nParams >= 1 && params[0] != 0;
                break;
        }
        result->engine = result->hasX || result->hasY || result->isRect ? this : nullptr;
        result->zoom = zoom;
    }

    // GoToR and Launch open a file (like EngineMupdf's file: links). PDFium can't name
    // a GoToR destination without loading the target, so the file opens at its start.
    IPageDestination* FileDestination(FPDF_ACTION action, Arena* dstArena) {
        unsigned long bytes = gPdfium.FPDFAction_GetFilePath(action, nullptr, 0);
        constexpr unsigned long kMaxPathBytes = 64 * 1024;
        if (bytes < 2 || bytes > kMaxPathBytes) {
            return nullptr;
        }
        char* buf = AllocArrayTemp<char>((int)bytes);
        if (gPdfium.FPDFAction_GetFilePath(action, buf, bytes) != bytes) {
            return nullptr;
        }
        TempStr path = path::ToOSTemp(Str(buf, (int)bytes - 1));
        return dstArena ? New<PageDestinationFile>(dstArena, path, Str()) : new PageDestinationFile(path, Str());
    }

    IPageDestination* Destination(FPDF_DEST dest, FPDF_ACTION action, Arena* dstArena = nullptr) {
        int type = action ? (int)gPdfium.FPDFAction_GetType(action) : PDFACTION_UNSUPPORTED;
        if (!dest && type == PDFACTION_GOTO) {
            dest = gPdfium.FPDFAction_GetDest(doc, action);
        }
        if (!dest && (type == PDFACTION_REMOTEGOTO || type == PDFACTION_LAUNCH)) {
            return FileDestination(action, dstArena);
        }
        if (!dest) {
            if (type != PDFACTION_URI) {
                return nullptr;
            }
            unsigned long bytes = gPdfium.FPDFAction_GetURIPath(doc, action, nullptr, 0);
            constexpr unsigned long kMaxUriBytes = 1024 * 1024;
            if (bytes < 2 || bytes > kMaxUriBytes) {
                return nullptr;
            }
            char* buf = AllocArrayTemp<char>((int)bytes);
            if (gPdfium.FPDFAction_GetURIPath(doc, action, buf, bytes) != bytes) {
                return nullptr;
            }
            Str uri(buf, (int)bytes - 1);
            return dstArena ? New<PageDestinationURL>(dstArena, uri) : new PageDestinationURL(uri);
        }
        int pageNo = gPdfium.FPDFDest_GetDestPageIndex(doc, dest) + 1;
        auto* info = Page(pageNo);
        if (!info) {
            return nullptr;
        }
        auto* result = dstArena ? New<PdfiumDest>(dstArena) : new PdfiumDest();
        result->pageNo = pageNo;
        result->rect = RectF(kDestUseDefault, kDestUseDefault, kDestUseDefault, kDestUseDefault);
        result->kind = kindDestinationScrollTo;
        SetDestView(result, dest);
        return result;
    }

    // An in-document link has no URL to show, so show its /Contents, like EngineMupdf.
    Str LinkContents(FPDF_PAGE page, FPDF_LINK link) {
        FPDF_ANNOTATION annot = gPdfium.FPDFLink_GetAnnot(page, link);
        if (!annot) {
            return {};
        }
        Str res;
        unsigned long bytes = gPdfium.FPDFAnnot_GetStringValue(annot, "Contents", nullptr, 0);
        constexpr unsigned long kMaxContentsBytes = 1024 * 1024;
        if (bytes > sizeof(WCHAR) && bytes <= kMaxContentsBytes && bytes % sizeof(WCHAR) == 0) {
            WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
            if (gPdfium.FPDFAnnot_GetStringValue(annot, "Contents", (FPDF_WCHAR*)buf, bytes) == bytes) {
                res = str::Dup(ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1)));
            }
        }
        gPdfium.FPDFPage_CloseAnnot(annot);
        return res;
    }

    // Caller holds gPdfiumLock.
    // A rotated glyph's corners: one advance along its baseline vector, descent to ascent along its up
    // vector, like MuPDF's quads. PDFium only reports axis-aligned boxes, which can't be undone at 45°.
    bool RotatedGlyphQuad(FPDF_PAGE page, PdfiumPage* info, FPDF_TEXTPAGE textPage, int i, unsigned int code,
                          QuadF* quad) {
        constexpr double kUprightEps = 1e-3;
        FS_MATRIX m{};
        if (!gPdfium.FPDFText_GetMatrix(textPage, i, &m)) {
            return false;
        }
        double scale = fabs(m.a) + fabs(m.d);
        if (fabs(m.b) <= kUprightEps * scale && fabs(m.c) <= kUprightEps * scale) {
            return false;
        }
        FPDF_PAGEOBJECT obj = gPdfium.FPDFText_GetTextObject(textPage, i);
        FPDF_FONT font = obj ? gPdfium.FPDFTextObj_GetFont(obj) : nullptr;
        float size = (float)gPdfium.FPDFText_GetFontSize(textPage, i);
        float ascent = 0, descent = 0, advance = 0;
        double ox = 0, oy = 0;
        if (!font || !(size > 0) || !gPdfium.FPDFFont_GetAscent(font, size, &ascent) ||
            !gPdfium.FPDFFont_GetDescent(font, size, &descent) ||
            !gPdfium.FPDFFont_GetGlyphWidth(font, code, size, &advance) || !(advance > 0) ||
            !gPdfium.FPDFText_GetCharOrigin(textPage, i, &ox, &oy)) {
            return false;
        }
        auto corner = [&](double s, double t) {
            return ToPage(page, info, ox + s * m.a + t * m.c, oy + s * m.b + t * m.d);
        };
        *quad = {corner(0, ascent), corner(advance, ascent), corner(0, descent), corner(advance, descent)};
        return true;
    }

    PageText ReadPageText(FPDF_PAGE page, PdfiumPage* info) {
        PageText result;
        FPDF_TEXTPAGE textPage = gPdfium.FPDFText_LoadPage(page);
        if (!textPage) {
            return result;
        }
        int count = gPdfium.FPDFText_CountChars(textPage);
        constexpr int kMaxPageChars = 2000000;
        if (count > 0 && count <= kMaxPageChars) {
            str::Builder text;
            Vec<Rect> coords;
            Vec<QuadF> quads;
            bool hasRotated = false;
            for (int i = 0; i < count; i++) {
                unsigned int code = gPdfium.FPDFText_GetUnicode(textPage, i);
                if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
                    code = 0xfffd;
                }
                char buf[8]{};
                int bytes = 0;
                str::Utf8Encode(buf, bytes, (int)code);
                text.Append(Str(buf, bytes));
                double left = 0, right = 0, bottom = 0, top = 0;
                Rect box;
                if (gPdfium.FPDFText_GetCharBox(textPage, i, &left, &right, &bottom, &top)) {
                    RectF rect = ToPageRect(page, info, left, bottom, right, top);
                    if (isfinite(rect.x) && isfinite(rect.y) && isfinite(rect.dx) && isfinite(rect.dy) &&
                        fabs(rect.x) < INT_MAX / 4 && fabs(rect.y) < INT_MAX / 4 && rect.dx < INT_MAX / 4 &&
                        rect.dy < INT_MAX / 4) {
                        box = rect.Round();
                    }
                }
                VecAppend(coords, box);

                // rotated glyphs select along their quads (#4839), upright ones use their box
                float x0 = (float)box.x, y0 = (float)box.y, x1 = (float)(box.x + box.dx), y1 = (float)(box.y + box.dy);
                QuadF quad{PointF(x0, y0), PointF(x1, y0), PointF(x0, y1), PointF(x1, y1)};
                if (RotatedGlyphQuad(page, info, textPage, i, code, &quad)) {
                    hasRotated = true;
                }
                VecAppend(quads, quad);
            }
            result.text = text.TakeStr();
            result.nCodepoints = len(coords);
            result.coords = VecTake(coords);
            // like EngineMupdf: quads only add information for rotated text
            if (hasRotated) {
                result.quads = VecTake(quads);
            }
        }
        gPdfium.FPDFText_ClosePage(textPage);
        return result;
    }

    // Plain-text URLs, e-mails and DOIs, skipping those covered by a link annotation (like EngineMupdf).
    // PDFium's "\r\n" line breaks keep wrapped URLs unjoined, as MuPDF's soft line joins do.
    void AddAutoLinks(FPDF_PAGE page, int pageNo, PdfiumPage* info) {
        PageText text = ReadPageText(page, info);
        StrVec urls;
        Vec<RectF> rects;
        LinkifyPageText(text.text, text.coords, urls, rects);
        FreePageText(&text);
        int nAnnotLinks = len(info->links);
        for (int i = 0; i < len(urls); i++) {
            RectF rect = rects[i];
            bool covered = false;
            for (int j = 0; j < nAnnotLinks && !covered; j++) {
                RectF isect = rect.Intersect(info->links[j]->GetRect());
                covered = rect.dx * rect.dy > 0 && isect.dx * isect.dy >= 0.25f * rect.dx * rect.dy;
            }
            if (covered) {
                continue;
            }
            auto* element = new PageElementDestination(new PageDestinationURL(urls[i]));
            element->pageNo = pageNo;
            element->rect = rect;
            VecAppend(info->links, (IPageElement*)element);
        }
    }

    // A GoToR file link from PDFium with the same rect as a MuPDF one.
    PageDestinationFile* FileLinkAt(PdfiumPage* info, RectF rect) {
        constexpr float kEps = 0.01f;
        for (auto* el : info->links) {
            IPageDestination* dest = el->AsLink();
            RectF r = el->rect;
            if (dest && dest->GetKind() == kindDestinationLaunchFile && fabsf(r.x - rect.x) < kEps &&
                fabsf(r.y - rect.y) < kEps && fabsf(r.dx - rect.dx) < kEps && fabsf(r.dy - rect.dy) < kEps) {
                return (PageDestinationFile*)dest;
            }
        }
        return nullptr;
    }

    // PDFium reports First/Last/Prev/NextPage actions only as unsupported and can't name a GoToR
    // destination without loading the target; MuPDF reads both, like /OpenAction.
    void AddMupdfLinks(int pageNo, PdfiumPage* info) {
        Vec<PdfLinkMupdf> links;
        PdfLinksMupdf(FilePath(), fileData, password, pageNo, links);
        for (auto& link : links) {
            if (link.remoteDest.s) {
                if (auto* file = FileLinkAt(info, link.rect)) {
                    str::Free(file->dest);
                    file->dest = link.remoteDest;
                    link.remoteDest = {};
                }
                str::Free(link.remoteDest);
                continue;
            }
            if (!Page(link.targetPage)) {
                continue;
            }
            auto* dest = new PdfiumDest();
            dest->pageNo = link.targetPage;
            dest->rect = RectF(kDestUseDefault, kDestUseDefault, kDestUseDefault, kDestUseDefault);
            dest->kind = kindDestinationScrollTo;
            auto* element = new PageElementDestination(dest);
            element->pageNo = pageNo;
            element->rect = link.rect;
            VecAppend(info->links, (IPageElement*)element);
        }
    }

    void LoadLinks(int pageNo, PdfiumPage* info) {
        if (info->linksLoaded) {
            return;
        }
        PdfiumProfile profile(StrL("links"), pageNo);
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return;
        }
        int pos = 0;
        FPDF_LINK link;
        bool needsMupdf = false;
        constexpr int kMaxLinks = 100000;
        while (len(info->links) < kMaxLinks && gPdfium.FPDFLink_Enumerate(page, &pos, &link)) {
            FS_RECTF box{};
            if (!gPdfium.FPDFLink_GetAnnotRect(link, &box)) {
                continue;
            }
            FPDF_ACTION action = gPdfium.FPDFLink_GetAction(link);
            unsigned long type = action ? gPdfium.FPDFAction_GetType(action) : PDFACTION_UNSUPPORTED;
            needsMupdf |= action && (type == PDFACTION_UNSUPPORTED || type == PDFACTION_REMOTEGOTO);
            auto* dest = Destination(gPdfium.FPDFLink_GetDest(doc, link), action);
            if (!dest) {
                continue;
            }
            if (dest->GetKind() == kindDestinationScrollTo) {
                ((PdfiumDest*)dest)->value = LinkContents(page, link);
            }
            auto* element = new PageElementDestination(dest);
            element->pageNo = pageNo;
            element->rect = ToPageRect(page, info, box.left, box.bottom, box.right, box.top);
            VecAppend(info->links, (IPageElement*)element);
        }
        if (needsMupdf) {
            AddMupdfLinks(pageNo, info);
        }
        if (!disableAutoLinks) {
            AddAutoLinks(page, pageNo, info);
        }
        int annotCount = gPdfium.FPDFPage_GetAnnotCount(page);
        for (int i = 0; i < annotCount; i++) {
            FPDF_ANNOTATION annot = gPdfium.FPDFPage_GetAnnot(page, i);
            if (!annot) {
                continue;
            }
            bool isAttachment = gPdfium.FPDFAnnot_GetSubtype(annot) == FPDF_ANNOT_FILEATTACHMENT;
            gPdfium.FPDFPage_CloseAnnot(annot);
            if (isAttachment) {
                info->hasFileAttachments = true;
                break;
            }
        }
        gPdfium.FPDF_ClosePage(page);
        info->linksLoaded = true;
        profile.Mark(StrL("load-and-scan"));
    }

    TocItem* ReadBookmarks(FPDF_BOOKMARK first, TocItem* parent, int depth, int& budget, int& id) {
        if (depth > 64) {
            return nullptr;
        }
        TocItem* head = nullptr;
        TocItem** tail = &head;
        for (auto mark = first; mark && budget > 0; mark = gPdfium.FPDFBookmark_GetNextSibling(doc, mark)) {
            budget--;
            unsigned long bytes = gPdfium.FPDFBookmark_GetTitle(mark, nullptr, 0);
            TempStr title;
            if (bytes >= sizeof(WCHAR) && bytes <= 2 * 1024 * 1024 && bytes % sizeof(WCHAR) == 0) {
                WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
                if (gPdfium.FPDFBookmark_GetTitle(mark, buf, bytes) == bytes) {
                    title = ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1));
                }
            }
            auto* dest =
                Destination(gPdfium.FPDFBookmark_GetDest(doc, mark), gPdfium.FPDFBookmark_GetAction(mark), arena);
            auto* item = AllocTocItem(arena, title, dest ? dest->pageNo : -1);
            item->id = ++id;
            item->parent = parent;
            item->dest = dest;
            item->child = ReadBookmarks(gPdfium.FPDFBookmark_GetFirstChild(doc, mark), item, depth + 1, budget, id);
            *tail = item;
            tail = &item->next;
        }
        return head;
    }

  public:
    EnginePdfium() {
        kind = kindEnginePdfium;
        defaultExt = str::Dup(StrL(".pdf"));
        fileDPI = 72;
    }

    ~EnginePdfium() override {
        PdfiumProfile profile(StrL("close"));
        profile.Mark(StrL("start"));
        ScopedMutex lock(&gPdfiumLock);
        DestroyTocTree(toc);
        for (auto* p : pages) {
            if (!p) {
                continue;
            }
            for (auto* link : p->links) {
                delete link;
            }
            delete p;
        }
        for (auto* dest : namedDests) {
            delete dest;
        }
        if (form) {
            gPdfium.FPDFDOC_ExitFormFillEnvironment(form);
        }
        if (doc) {
            gPdfium.FPDF_CloseDocument(doc);
        }
        profile.Mark(StrL("document"));
        if (file != INVALID_HANDLE_VALUE) {
            CloseHandle(file);
        }
        str::Free(fileData);
        str::Free(password);
        if (runtime) {
            gPdfium.Release();
        }
        profile.Mark(StrL("runtime"));
        if (editor) {
            editor->Release();
        }
    }

    // Caller holds gPdfiumLock; it's released while pwdUI asks, as a dialog may run a message loop.
    // Like EngineMupdf, a remembered decryption key comes back as an empty password; PDFium can't
    // use the key, so MuPDF opens such files.
    FPDF_DOCUMENT LoadWithPassword(PasswordUI* pwdUI, TempStr* error, PdfiumFailure* failure) {
        *failure = PdfiumFailure::Final;
        *error = StrL("The document needs a password.");
        if (!pwdUI) {
            return nullptr;
        }
        u8 digest[16]{};
        Str data = fileData.s ? fileData : file::ReadFile(FilePath());
        CalcMD5Digest(data, digest);
        if (data.s != fileData.s) {
            str::Free(data);
        }
        u8 key[32]{};
        bool saveKey = false;
        while (true) {
            gPdfiumLock.Unlock();
            Str pwd = pwdUI->GetPassword(FilePath(), digest, key, &saveKey);
            gPdfiumLock.Lock();
            if (len(pwd) == 0) {
                if (saveKey) {
                    *failure = PdfiumFailure::Fallback;
                    *error = StrL("PDFium can't use a remembered decryption key.");
                }
                return nullptr;
            }
            FPDF_DOCUMENT d = gPdfium.FPDF_LoadCustomDocument(&access, CStrTemp(pwd));
            if (d) {
                password = pwd;
                isPasswordProtected = true;
                if (saveKey) {
                    decryptionKey = str::Dup(arena, PdfDecryptionKeyMupdfTemp(FilePath(), fileData, pwd));
                }
                return d;
            }
            str::Free(pwd);
            unsigned long code = gPdfium.FPDF_GetLastError();
            if (code != FPDF_ERR_PASSWORD) {
                *failure = PdfiumFailure::Fallback;
                *error = fmt("PDFium document load failed (error %lu).", code);
                return nullptr;
            }
        }
    }

    bool Load(Str path, PasswordUI* pwdUI, TempStr* error, PdfiumFailure* failure) {
        PdfiumProfile profile(StrL("load"));
        profile.Mark(StrL("start"));
        SetFilePath(path);

        // No lock for file I/O: opening alone took 20-30 ms in tests, time other tabs can render in.
        // Like MuPDF's _wfopen, share writes so producers can overwrite a big file kept open; it then reloads.
        DWORD share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        file = CreateFileW(CWStrTemp(ToWStrTemp(path)), GENERIC_READ, share, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
        LARGE_INTEGER size{};
        if (file == INVALID_HANDLE_VALUE || !GetFileSizeEx(file, &size) || size.QuadPart <= 0 ||
            size.QuadPart > MAXDWORD) {
            *error = StrL("PDFium file open failed (this backend currently supports files smaller than 4 GiB).");
            return false;
        }
        access.m_FileLen = (unsigned long)size.QuadPart;
        if (size.QuadPart < kMaxMemoryFileSize && !ReadIntoMemory()) {
            *error = StrL("PDFium file read failed.");
            return false;
        }
        access.m_GetBlock = ReadBlock;
        access.m_Param = this;
        profile.Mark(StrL("file"));

        ScopedMutex lock(&gPdfiumLock);
        profile.Mark(StrL("lock"));
        if (!gPdfium.Acquire(error)) {
            return false;
        }
        runtime = true;
        profile.Mark(StrL("runtime"));
        doc = gPdfium.FPDF_LoadCustomDocument(&access, nullptr);
        if (!doc && gPdfium.FPDF_GetLastError() == FPDF_ERR_PASSWORD) {
            doc = LoadWithPassword(pwdUI, error, failure);
            if (!doc) {
                return false;
            }
        }
        if (!doc) {
            *error = fmt("PDFium document load failed (error %lu).", gPdfium.FPDF_GetLastError());
            return false;
        }
        profile.Mark(StrL("document"));
        pageCount = gPdfium.FPDF_GetPageCount(doc);
        if (pageCount < 1 || pageCount > 1000000) {
            *error = StrL("PDFium document has an invalid or unsupported page count.");
            return false;
        }
        VecResize(pages, pageCount);
        isPasswordProtected = gPdfium.FPDF_GetSecurityHandlerRevision(doc) >= 0;
        unsigned long permissions = gPdfium.FPDF_GetDocPermissions(doc);
        allowsPrinting = (permissions & (1UL << 2)) != 0;
        allowsCopyingText = (permissions & (1UL << 4)) != 0;
        int formType = gPdfium.FPDF_GetFormType(doc);
        acroForm = formType == FORMTYPE_ACRO_FORM;
        if (formType != FORMTYPE_NONE) {
            formInfo.version = 1;
            formInfo.FFI_Invalidate = FormInvalidate;
            formInfo.FFI_SetCursor = FormSetCursor;
            formInfo.FFI_SetTimer = FormSetTimer;
            formInfo.FFI_KillTimer = FormKillTimer;
            formInfo.FFI_GetLocalTime = FormGetLocalTime;
            formInfo.FFI_GetPage = FormGetPage;
            formInfo.FFI_GetRotation = FormGetRotation;
            formInfo.FFI_ExecuteNamedAction = FormExecuteNamedAction;
            form = gPdfium.FPDFDOC_InitFormFillEnvironment(doc, &formInfo);
        }
        profile.Mark(StrL("info"));
        LoadPageLabels();
        profile.Mark(StrL("labels"));
        logf("PDFium 158.0.8111.0: opened '%s', %d pages; no MuPDF document\n", path, pageCount);
        return true;
    }

    // Caller holds gPdfiumLock. Like EngineMupdf, logical page count is the largest numeric label.
    void LoadPageLabels() {
        // a document with /PageLabels labels page 1 (possibly with "")
        if (gPdfium.FPDF_GetPageLabel(doc, 0, nullptr, 0) == 0) {
            return;
        }
        constexpr unsigned long kMaxLabelBytes = 64 * 1024;
        for (int i = 0; i < pageCount; i++) {
            unsigned long bytes = gPdfium.FPDF_GetPageLabel(doc, i, nullptr, 0);
            if (bytes < sizeof(WCHAR) || bytes > kMaxLabelBytes || bytes % sizeof(WCHAR) != 0) {
                pageLabels.Append(StrL(""));
                continue;
            }
            WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
            bool ok = gPdfium.FPDF_GetPageLabel(doc, i, buf, bytes) == bytes;
            pageLabels.Append(ok ? ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1)) : StrL(""));
        }
        hasPageLabels = true;
        for (int i = 0; i < len(pageLabels); i++) {
            int v = 0;
            if (str::Parse(pageLabels[i], "%d%$", &v).s && v > logicalPageCount) {
                logicalPageCount = v;
            }
        }
    }

    TempStr GetPageLabeTemp(int pageNo) const override {
        if (pageNo < 1 || pageNo > len(pageLabels)) {
            return EngineBase::GetPageLabeTemp(pageNo);
        }
        Str label = pageLabels[pageNo - 1];
        if (len(label) == 0 || str::ContainsI(label, StrL(".pdg"))) {
            return EngineBase::GetPageLabeTemp(pageNo);
        }
        return str::DupTemp(label);
    }

    int GetPageByLabel(Str label) const override {
        int pageNo = pageLabels.Find(label) + 1;
        return pageNo > 0 ? pageNo : EngineBase::GetPageByLabel(label);
    }

    // Hands a clone the password that opened this document.
    struct PasswordCloner : PasswordUI {
        Str password;
        explicit PasswordCloner(Str pwd) : password(pwd) {}
        Str GetPassword(Str, u8*, u8[32], bool* saveKey) override {
            *saveKey = false;
            Str pwd = password;
            password = {};
            return str::Dup(pwd);
        }
    };

    bool HasAnnotationEditor() override { return true; }
    bool HasAcroForm() override { return acroForm; }

    // Loads on the first annotation query (a hover, a list, a create): MuPDF opens the file again.
    EngineBase* AnnotationEditor(EditorLoad load) override {
        EngineBase* res = (EngineBase*)InterlockedCompareExchangePointer((void* volatile*)&editor, nullptr, nullptr);
        if (res || load == EditorLoad::IfLoaded) {
            return res;
        }
        ScopedMutex lock(&editorLock);
        if (editor || editorFailed) {
            return editor;
        }
        PdfiumProfile profile(StrL("editor"));
        PasswordCloner pwdUI(password);
        res = CreateEngineMupdfFromFile(FilePath(), FileType::PDF, 96, &pwdUI);
        profile.Mark(StrL("loaded"));
        if (!res) {
            logf("EnginePdfium: MuPDF can't open '%s' to edit annotations\n", FilePath());
            editorFailed = true;
            return nullptr;
        }
        InterlockedExchangePointer((void* volatile*)&editor, res);
        return res;
    }

    EngineBase* Clone() override {
        TempStr error;
        PasswordCloner pwdUI(password);
        EngineBase* clone = CreateEnginePdfium(FilePath(), &pwdUI, &error);
        if (clone) {
            clone->disableAutoLinks = disableAutoLinks;
        }
        return clone;
    }

    int GetOpenActionPageNo() override {
        PdfiumProfile profile(StrL("openaction"));
        int pageNo = PdfOpenActionPageMupdf(FilePath(), fileData, password);
        profile.Mark(StrL("read"));
        return pageNo;
    }

    // A known size needs no lock: the UI thread waited ~10 ms per call while pages drew.
    RectF PageMediabox(int pageNo) override {
        if (pageNo >= 1 && pageNo <= pageCount) {
            void* volatile* slot = (void* volatile*)&pages[pageNo - 1];
            auto* p = (PdfiumPage*)InterlockedCompareExchangePointer(slot, nullptr, nullptr);
            if (p) {
                return RectF(0, 0, p->size.dx, p->size.dy);
            }
        }
        return LockedMediabox(pageNo);
    }

    // Renders take the lock here, before allocating: a lock-free read let more tile buffers coexist.
    RectF LockedMediabox(int pageNo) {
        ScopedMutex lock(&gPdfiumLock);
        auto* p = Page(pageNo);
        return p ? RectF(0, 0, p->size.dx, p->size.dy) : RectF{};
    }

    // Only this part needs the lock; pixel post-processing runs while other pages draw.
    int DrawPage(RenderPageArgs& args, Pixmap* pixmap, double x, double y, RectF full, bool drawAnnots,
                 PdfiumCookie* cookie, PdfiumProfile& profile, bool* tileHasPhotos) {
        *tileHasPhotos = false;
        ScopedMutex lock(&gPdfiumLock);
        profile.Mark(StrL("lock"));
        if (AtomicIntGet(&cookie->aborted)) {
            return FPDF_RENDER_FAILED;
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, args.pageNo - 1);
        if (!page) {
            return FPDF_RENDER_FAILED;
        }
        profile.Mark(StrL("page"));
        if (PdfiumCookie::IsCanceled(cookie)) {
            gPdfium.FPDF_ClosePage(page);
            profile.Mark(StrL("canceled-page"));
            return FPDF_RENDER_FAILED;
        }
        auto* info = Page(args.pageNo);
        if (info && !info->imagesLoaded && KeepsImageColors(args)) {
            CollectImages(page, info);
            profile.Mark(StrL("images"));
        }
        if (info && KeepsImageColors(args)) {
            RectF tile = args.pageRect ? *args.pageRect : RectF(0, 0, info->size.dx, info->size.dy);
            for (RectF& r : info->images) {
                *tileHasPhotos = *tileHasPhotos || !r.Intersect(tile).IsEmpty();
            }
        }
        // the form module keeps a view per loaded page; it must drop it before the page closes
        if (form) {
            gPdfium.FORM_OnAfterLoadPage(page, form);
        }
        FPDF_BITMAP bmp =
            gPdfium.FPDFBitmap_CreateEx(pixmap->width, pixmap->height, FPDFBitmap_BGRA, pixmap->data, pixmap->stride);
        profile.Mark(StrL("bitmap-create"));
        int status = FPDF_RENDER_FAILED;
        if (bmp) {
            int flags = drawAnnots ? FPDF_ANNOT : 0;
            if (disableAntiAlias) {
                flags |= FPDF_RENDER_NO_SMOOTHTEXT | FPDF_RENDER_NO_SMOOTHIMAGE | FPDF_RENDER_NO_SMOOTHPATH;
            } else {
                flags |= FPDF_LCD_TEXT;
            }
            if (args.target == RenderTarget::Print) {
                flags |= FPDF_PRINTING;
            }
            int rotation = NormalizeRotation(args.rotation) / 90;
            int dx = (int)ceil(full.dx), dy = (int)ceil(full.dy);
            status = gPdfium.FPDF_RenderPageBitmap_Start(bmp, page, -(int)x, -(int)y, dx, dy, rotation, flags,
                                                         &cookie->pause);
            while (status == FPDF_RENDER_TOBECONTINUED && !AtomicIntGet(&cookie->aborted)) {
                status = gPdfium.FPDF_RenderPage_Continue(page, &cookie->pause);
            }
            profile.Mark(StrL("draw"));
            // FPDF_ANNOT draws every annotation but form field widgets, which only this draws
            if (form && drawAnnots && !hideAnnotations && status == FPDF_RENDER_DONE &&
                !AtomicIntGet(&cookie->aborted)) {
                gPdfium.FPDF_FFLDraw(form, bmp, page, -(int)x, -(int)y, dx, dy, rotation, flags);
                profile.Mark(StrL("widgets"));
            }
            gPdfium.FPDF_RenderPage_Close(page);
            gPdfium.FPDFBitmap_Destroy(bmp);
        }
        if (form) {
            gPdfium.FORM_OnBeforeClosePage(page, form);
        }
        gPdfium.FPDF_ClosePage(page);
        profile.Mark(StrL("bitmap"));
        return status;
    }

    Pixmap* RenderPage(RenderPageArgs& args) override {
        PdfiumProfile profile(StrL("render"), args.pageNo);
        PdfiumCookie localCookie;
        PdfiumCookie* cookie = &localCookie;
        if (args.cookie_out) {
            cookie = new PdfiumCookie();
            *args.cookie_out = cookie;
        }
        RectF box = LockedMediabox(args.pageNo);
        if (box.IsEmpty() || !isfinite(args.zoom) || args.zoom <= 0) {
            return nullptr;
        }
        RectF full = Transform(box, args.pageNo, args.zoom, args.rotation);
        RectF area = args.pageRect ? Transform(*args.pageRect, args.pageNo, args.zoom, args.rotation) : full;
        double x = SnapFloor(area.x), y = SnapFloor(area.y);
        double w = SnapCeil(area.x + area.dx) - x, h = SnapCeil(area.y + area.dy) - y;
        constexpr double kMaxTilePixels = 64 * 1024 * 1024;
        if (!isfinite(w) || !isfinite(h) || w <= 0 || h <= 0 || w * h > kMaxTilePixels || !isfinite(full.dx) ||
            !isfinite(full.dy) || full.dx > INT_MAX / 2 || full.dy > INT_MAX / 2 || !isfinite(x) || !isfinite(y) ||
            fabs(x) > INT_MAX / 2 || fabs(y) > INT_MAX / 2) {
            return nullptr;
        }
        profile.Mark(StrL("geometry"));
        if (profile.enabled) {
            logf("PDFium tile: thread=%lu page=%d size=%dx%d bytes=%llu transparent=%d print=%d\n",
                 GetCurrentThreadId(), args.pageNo, (int)w, (int)h, (u64)w * (u64)h * 4, (int)args.transparentBackdrop,
                 (int)(args.target == RenderTarget::Print));
        }
        if (PdfiumCookie::IsCanceled(cookie)) {
            profile.Mark(StrL("canceled-before-alloc"));
            return nullptr;
        }
        auto* pixmap = AllocPixmap((int)w, (int)h);
        if (!pixmap) {
            return nullptr;
        }
        PdfiumBufferTrace bufferTrace(pixmap, profile);
        profile.Mark(StrL("setup"));

        // white or transparent backdrop, filled without the lock
        memset(pixmap->data, args.transparentBackdrop ? 0 : 0xff, (size_t)pixmap->stride * pixmap->height);
        profile.Mark(StrL("fill"));

        // read once: a tile must not get annotations from both engines
        EngineBase* annotEditor = AnnotationEditor(EditorLoad::IfLoaded);
        bool drawAnnots = !hideAnnotations && !annotEditor;
        bool tileHasPhotos = false;
        int status = DrawPage(args, pixmap, x, y, full, drawAnnots, cookie, profile, &tileHasPhotos);
        if (status != FPDF_RENDER_DONE || AtomicIntGet(&cookie->aborted)) {
            profile.Mark(StrL("canceled-or-failed"));
            FreePixmap(pixmap);
            return nullptr;
        }
        if (args.transparentBackdrop) {
            pixmap->hasAlpha = true;
            pixmap->premultiplied = true;
            for (int row = 0; row < pixmap->height; row++) {
                if (PdfiumCookie::IsCanceled(cookie)) {
                    FreePixmap(pixmap);
                    profile.Mark(StrL("canceled-alpha"));
                    return nullptr;
                }
                u8* px = pixmap->data + (size_t)row * pixmap->stride;
                for (int col = 0; col < pixmap->width; col++, px += 4) {
                    for (int c = 0; c < 3; c++) {
                        px[c] = (u8)((px[c] * px[3] + 127) / 255);
                    }
                }
            }
        }
        pixmap->xres = pixmap->yres = args.zoom * fileDPI;
        profile.Mark(StrL("alpha"));
        if (annotEditor && !hideAnnotations) {
            float m[6];
            TileMatrix(args.pageNo, args.zoom, args.rotation, x, y, full, m);
            EngineMupdfDrawAnnotations(annotEditor, args.pageNo, m, pixmap, args.target);
            profile.Mark(StrL("annotations"));
        }
        if (!pixmap->hasAlpha && args.target == RenderTarget::View) {
            // a gray tile recolors through its palette, which can't spare photos
            if (!tileHasPhotos) {
                PixmapGrayTimes times;
                pixmap = PixmapToGrayDib(pixmap, PdfiumCookie::IsCanceled, cookie, profile.enabled ? &times : nullptr);
                profile.Mark(StrL("gray"));
                if (profile.enabled) {
                    logf("PDFium gray: thread=%lu page=%d scan=%.3f alloc=%.3f copy=%.3f native=%d aborted=%d\n",
                         GetCurrentThreadId(), args.pageNo, times.scanMs, times.allocMs, times.copyMs,
                         (int)(pixmap->hbmp != nullptr), AtomicIntGet(&cookie->aborted));
                }
                if (PdfiumCookie::IsCanceled(cookie)) {
                    FreePixmap(pixmap);
                    profile.Mark(StrL("canceled-gray"));
                    return nullptr;
                }
            }
            if (pixmap->format == PixmapFormat::BGRA8) {
                pixmap = OpaqueToBgr(pixmap, &cookie->aborted);
                profile.Mark(StrL("bgr"));
                if (!pixmap) {
                    profile.Mark(StrL("canceled-bgr"));
                    return nullptr;
                }
            }
        }
        if (profile.enabled) {
            u64 pixels = (u64)pixmap->stride * pixmap->height;
            u64 storage = pixmap->hbmp ? pixels : (u64)_msize(pixmap->data);
            logf("PDFium output: thread=%lu pixels=%llu storage=%llu format=%d\n", GetCurrentThreadId(), pixels,
                 storage, (int)pixmap->format);
        }
        return pixmap;
    }

    // Page space to the pixels of a tile at (x, y), as DrawPage has PDFium map it: the page fills
    // a whole-pixel box.
    void TileMatrix(int pageNo, float zoom, int rotation, double x, double y, RectF full, float m[6]) {
        PointF o = Transform(PointF(0, 0), pageNo, zoom, rotation);
        PointF ux = Transform(PointF(1, 0), pageNo, zoom, rotation);
        PointF uy = Transform(PointF(0, 1), pageNo, zoom, rotation);
        float sx = full.dx > 0 ? (float)(ceil(full.dx) / full.dx) : 1.f;
        float sy = full.dy > 0 ? (float)(ceil(full.dy) / full.dy) : 1.f;
        m[0] = (ux.x - o.x) * sx;
        m[1] = (ux.y - o.y) * sy;
        m[2] = (uy.x - o.x) * sx;
        m[3] = (uy.y - o.y) * sy;
        m[4] = (float)((o.x - full.x) * sx + full.x - x);
        m[5] = (float)((o.y - full.y) * sy + full.y - y);
    }

    // The photos of a tile RenderPage drew for renderPageRect, which the theme recolor leaves alone.
    // Rounded inward: a pixel of photo edge recolored shows less than a line of untinted paper.
    void GetBitmapRecolorSkipRects(int pageNo, float zoom, int rotation, const RectF& renderPageRect, Size bmpSize,
                                   Vec<Rect>& skipRects) override {
        VecClear(skipRects);
        RectF box = PageMediabox(pageNo);
        if (box.IsEmpty() || renderPageRect.IsEmpty() || !isfinite(zoom) || zoom <= 0) {
            return;
        }
        RectF full = Transform(box, pageNo, zoom, rotation);
        RectF area = Transform(renderPageRect, pageNo, zoom, rotation);
        float m[6];
        TileMatrix(pageNo, zoom, rotation, SnapFloor(area.x), SnapFloor(area.y), full, m);
        Rect tile(0, 0, bmpSize.dx, bmpSize.dy);

        ScopedMutex lock(&gPdfiumLock);
        auto* info = Page(pageNo);
        if (!info) {
            return;
        }
        if (!info->imagesLoaded) {
            FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
            if (!page) {
                return;
            }
            CollectImages(page, info);
            gPdfium.FPDF_ClosePage(page);
        }
        for (RectF& r : info->images) {
            PointF c[4] = {r.TL(), PointF(r.x + r.dx, r.y), PointF(r.x, r.y + r.dy), r.BR()};
            for (PointF& p : c) {
                p = PointF(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]);
            }
            RectF dev = RectF::FromXY(c[0], c[3]).Union(RectF::FromXY(c[1], c[2]));
            if (dev.dx < kPreservePdfImagesMinSize || dev.dy < kPreservePdfImagesMinSize) {
                continue;
            }
            int x0 = (int)ceil(dev.x), y0 = (int)ceil(dev.y);
            Rect keep = Rect::FromXY(x0, y0, (int)floor(dev.x + dev.dx), (int)floor(dev.y + dev.dy));
            keep = keep.Intersect(tile);
            if (!keep.IsEmpty()) {
                VecAppend(skipRects, keep);
            }
        }
    }

    PageText ExtractPageText(int pageNo) override {
        PdfiumProfile profile(StrL("text"), pageNo);
        ScopedMutex lock(&gPdfiumLock);
        profile.Mark(StrL("lock"));
        auto* info = Page(pageNo);
        if (!info) {
            return {};
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return {};
        }
        profile.Mark(StrL("page"));
        PageText result = ReadPageText(page, info);
        gPdfium.FPDF_ClosePage(page);
        profile.Mark(StrL("characters"));
        return result;
    }

    Vec<IPageElement*> GetElements(int pageNo) override {
        {
            ScopedMutex lock(&gPdfiumLock);
            auto* info = Page(pageNo);
            if (!info) {
                return Vec<IPageElement*>();
            }
            LoadLinks(pageNo, info);
            if (!info->hasFileAttachments || info->attachmentLinksLoaded) {
                return info->links;
            }
        }

        Vec<IPageElement*> attachments;
        EngineMupdfAttachmentLinks(this, pageNo, attachments);
        ScopedMutex lock(&gPdfiumLock);
        auto* info = Page(pageNo);
        if (!info->attachmentLinksLoaded) {
            for (IPageElement* link : attachments) {
                VecAppend(info->links, link);
            }
            info->attachmentLinksLoaded = true;
        } else {
            for (IPageElement* link : attachments) {
                delete link;
            }
        }
        return info->links;
    }

    IPageElement* GetElementAtPos(int pageNo, PointF point) override {
        auto links = GetElements(pageNo);
        for (int i = len(links) - 1; i >= 0; i--) {
            if (links[i]->rect.Contains(point)) {
                return links[i];
            }
        }
        return nullptr;
    }

    IPageDestination* GetNamedDest(Str name) override {
        ScopedMutex lock(&gPdfiumLock);
        for (auto* dest : namedDests) {
            if (str::Eq(dest->GetName(), name)) {
                return dest;
            }
        }
        auto* dest = Destination(gPdfium.FPDF_GetNamedDestByName(doc, CStrTemp(name)), nullptr);
        if (dest) {
            ((PageDestination*)dest)->name = str::Dup(name);
            VecAppend(namedDests, dest);
        }
        return dest;
    }

    bool HandleLink(IPageDestination* dest, ILinkHandler* handler) override {
        if (!dest || !handler) {
            return false;
        }
        handler->GotoLink(dest);
        return true;
    }

    TocTree* GetToc() override {
        bool hasAttachments = false;
        {
            ScopedMutex lock(&gPdfiumLock);
            if (tocLoaded) {
                return toc;
            }
            hasAttachments = gPdfium.FPDFDoc_GetAttachmentCount(doc) > 0;
        }

        // Read attachment names only for PDFs that have them; plain PDFs keep the PDFium-only path.
        TocTree* editorToc = hasAttachments ? EngineMupdfAttachmentToc(this) : nullptr;

        ScopedMutex lock(&gPdfiumLock);
        if (tocLoaded) {
            return toc;
        }
        PdfiumProfile profile(StrL("outline"));
        int budget = 4096, id = 0;
        auto* root = AllocTocItem(arena, {}, 0);
        root->child = ReadBookmarks(gPdfium.FPDFBookmark_GetFirstChild(doc, nullptr), root, 0, budget, id);
        TocItem** tail = &root->child;
        while (*tail) {
            tail = &(*tail)->next;
        }
        for (TocItem* source = editorToc ? editorToc->root->child : nullptr; source; source = source->next) {
            IPageDestination* sourceDest = source->dest;
            if (!sourceDest || sourceDest->GetKind() != kindDestinationAttachment) {
                continue;
            }
            auto* dest = New<PageDestination>(arena);
            dest->kind = kindDestinationAttachment;
            dest->name = str::Dup(sourceDest->GetName());
            dest->value = str::Dup(sourceDest->GetValue());
            dest->pageNo = sourceDest->pageNo;
            auto* item = AllocTocItem(arena, source->title, dest->pageNo);
            item->id = ++id;
            item->parent = root;
            item->dest = dest;
            *tail = item;
            tail = &item->next;
        }
        if (root->child) {
            toc = AllocTocTree(arena, root);
        }
        tocLoaded = true;
        profile.Mark(StrL("read"));
        return toc;
    }

    // What this document uses that PDFium can't do here, like EngineMupdf's "XFA": empty for most.
    TempStr UnsupportedFeaturesTemp() {
        ScopedMutex lock(&gPdfiumLock);
        StrVec features;
        int formType = gPdfium.FPDF_GetFormType(doc);
        if (formType == FORMTYPE_XFA_FULL || formType == FORMTYPE_XFA_FOREGROUND) {
            features.Append(StrL("XFA"));
        }
        if (gPdfium.FPDFDoc_GetJavaScriptActionCount(doc) > 0) {
            features.Append(StrL("Document JavaScript"));
        }
        if (len(features) == 0) {
            return {};
        }
        return JoinTemp(&features, StrL(", "));
    }

    TempStr GetPropertyTemp(DocProp prop) override {
        if (prop == DocProp::UnsupportedFeatures) {
            return UnsupportedFeaturesTemp();
        }
        const char* key = nullptr;
        switch (prop) {
            case DocProp::Title:
                key = "Title";
                break;
            case DocProp::Author:
                key = "Author";
                break;
            case DocProp::Subject:
                key = "Subject";
                break;
            case DocProp::Keywords:
                key = "Keywords";
                break;
            case DocProp::CreatorApp:
                key = "Creator";
                break;
            case DocProp::PdfProducer:
                key = "Producer";
                break;
            case DocProp::CreationDate:
                key = "CreationDate";
                break;
            case DocProp::ModificationDate:
                key = "ModDate";
                break;
            default:
                return {};
        }
        ScopedMutex lock(&gPdfiumLock);
        unsigned long bytes = gPdfium.FPDF_GetMetaText(doc, key, nullptr, 0);
        if (bytes < sizeof(WCHAR) || bytes > 2 * 1024 * 1024 || bytes % sizeof(WCHAR) != 0) {
            return {};
        }
        WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
        if (gPdfium.FPDF_GetMetaText(doc, key, buf, bytes) != bytes) {
            return {};
        }
        return ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1));
    }

    void GetProperties(Props& propsOut) override {
        EngineBase::GetProperties(propsOut);

        int signatures = 0;
        {
            ScopedMutex lock(&gPdfiumLock);
            signatures = gPdfium.FPDF_GetSignatureCount(doc);
        }
        if (signatures <= 0) {
            return;
        }

        // Verify signed PDFs with the same MuPDF path as the original engine.
        EngineBase* sigEngine = AnnotationEditor(EditorLoad::Load);
        if (!sigEngine) {
            return;
        }
        Props sigProps;
        sigEngine->GetProperties(sigProps);
        Str sigs = GetPropValueTemp(sigProps, DocProp::Signatures);
        if (len(sigs) > 0) {
            AddProp(propsOut, DocProp::Signatures, sigs);
        }
    }

    Str GetFileData() override { return fileData.s ? str::Dup(fileData) : file::ReadFile(FilePath()); }
    bool SaveFileAs(Str path) override {
        return fileData.s ? file::WriteFile(path, fileData) : file::Copy(path, FilePath(), false);
    }
    bool HasClipOptimizations(int) override { return true; }
    bool BenchLoadPage(int pageNo) override {
        ScopedMutex lock(&gPdfiumLock);
        if (!Page(pageNo)) {
            return false;
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return false;
        }
        gPdfium.FPDF_ClosePage(page);
        return true;
    }
};

// Where the system font cache lives; without it PDFium enumerates fonts uncached.
void SetPdfiumFontCacheDir(Str dir) {
    str::ReplaceWithCopy(&gFontCacheDir, dir);
}

// One page showing "a" in unembedded Helvetica: loading it makes PDFium build its system font list.
static const char kFontProbePdf[] =
    "%PDF-1.4\n"
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>\n"
    "endobj\n"
    "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>\n"
    "endobj\n"
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>\n"
    "endobj\n"
    "4 0 obj<</Length 22>>stream\n"
    "BT /F1 12 Tf (a) Tj ET\n"
    "endstream\n"
    "endobj\n"
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\n"
    "endobj\n"
    "xref\n"
    "0 6\n"
    "0000000000 65535 f \n"
    "0000000009 00000 n \n"
    "0000000053 00000 n \n"
    "0000000103 00000 n \n"
    "0000000212 00000 n \n"
    "0000000280 00000 n \n"
    "trailer<</Size 6/Root 1 0 R>>\n"
    "startxref\n"
    "342\n"
    "%%EOF\n";

// Builds the font list while the window starts, so the first text page doesn't wait for it.
// The runtime reference is never released: the list then also serves documents opened later.
static void WarmUpPdfium() {
    PdfiumProfile profile(StrL("warmup"));
    ScopedMutex lock(&gPdfiumLock);
    TempStr error;
    if (!gPdfium.Acquire(&error)) {
        return;
    }
    FPDF_DOCUMENT doc = gPdfium.FPDF_LoadMemDocument(kFontProbePdf, sizeof(kFontProbePdf) - 1, nullptr);
    FPDF_PAGE page = doc ? gPdfium.FPDF_LoadPage(doc, 0) : nullptr;
    if (page) {
        gPdfium.FPDF_ClosePage(page);
    }
    if (doc) {
        gPdfium.FPDF_CloseDocument(doc);
    }
    profile.Mark(StrL("fonts"));
}

void StartPdfiumWarmUp() {
    WCHAR value[2]{};
    if (GetEnvironmentVariableW(L"SOLOKPDF_WARMUP", value, dimofi(value)) == 1 && value[0] == L'0') {
        return;
    }
    RunAsync(MkFunc0Void(WarmUpPdfium), StrL("PdfiumWarmUp"));
}

bool PdfiumRequested() {
    WCHAR value[32]{};
    DWORD count = GetEnvironmentVariableW(L"SOLOKPDF_ENGINE", value, dimofi(value));
    return count == 0 || (count < dimofi(value) && wcscmp(value, L"pdfium") == 0);
}

EngineBase* CreateEnginePdfium(Str path, PasswordUI* pwdUI, TempStr* errorOut, PdfiumFailure* failureOut) {
    auto* engine = new EnginePdfium();
    PdfiumFailure failure = PdfiumFailure::Fallback;
    bool ok = engine->Load(path, pwdUI, errorOut, &failure);
    if (failureOut) {
        *failureOut = failure;
    }
    if (ok) {
        return engine;
    }
    logf("PDFium: %s File: '%s'\n", *errorOut, path);
    engine->Release();
    return nullptr;
}
