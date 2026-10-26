/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include "base/Base.h"
#include "base/Crypto.h"
#include "base/File.h"
#include "base/Pixmap.h"
#include "base/Timer.h"
#include "gui/UIModels.h"
#include "DocProperties.h"
#include "EngineBase.h"
#include "Settings.h"
#include "AppSettings.h"
#include "Annotation.h"
#include "AnnotationBackend.h"
#include <psapi.h>
#include <fpdfview.h>
#include <fpdf_annot.h>
#include <fpdf_doc.h>
#include <fpdf_edit.h>
#include <fpdf_formfill.h>
#include <fpdf_text.h>
#include <fpdf_progressive.h>
#include <fpdf_save.h>
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
    X(FPDF_GetPageSizeByIndexF)         \
    X(FPDF_LoadPage)                    \
    X(FPDF_ClosePage)                   \
    X(FPDF_PageToDevice)                \
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
    X(FPDFDOC_InitFormFillEnvironment)  \
    X(FPDFDOC_ExitFormFillEnvironment)  \
    X(FORM_OnAfterLoadPage)             \
    X(FORM_OnBeforeClosePage)           \
    X(FPDF_FFLDraw)                     \
    X(FPDF_DeviceToPage)                \
    X(FPDF_SaveAsCopy)                  \
    X(FPDFPage_GetAnnotCount)           \
    X(FPDFPage_GetAnnot)                \
    X(FPDFPage_GetAnnotIndex)           \
    X(FPDFPage_CreateAnnot)             \
    X(FPDFPage_RemoveAnnot)             \
    X(FPDFAnnot_GetSubtype)             \
    X(FPDFAnnot_GetRect)                \
    X(FPDFAnnot_SetRect)                \
    X(FPDFAnnot_CountAttachmentPoints)  \
    X(FPDFAnnot_GetAttachmentPoints)    \
    X(FPDFAnnot_SetAttachmentPoints)    \
    X(FPDFAnnot_AppendAttachmentPoints) \
    X(FPDFAnnot_SetStringValue)         \
    X(FPDFAnnot_GetColor)               \
    X(FPDFAnnot_SetColor)               \
    X(FPDFAnnot_SetFlags)               \
    X(FPDFAnnot_SetAP)                  \
    X(FPDFAnnot_GetNumberValue)         \
    X(FPDFAnnot_HasKey)                 \
    X(FPDFAnnot_GetBorder)              \
    X(FPDFAnnot_SetBorder)              \
    X(FPDFAnnot_GetInkListCount)        \
    X(FPDFAnnot_GetInkListPath)         \
    X(FPDFAnnot_AddInkStroke)           \
    X(FPDFAnnot_RemoveInkList)

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

// What an Annotation of a PDFium document stands for: its place in the page's /Annots and the
// values the UI reads, cached because reading them anew would load and parse the page.
struct PdfiumAnnot {
    Annotation* annot = nullptr;
    int index = -1;
    RectF rect; // page space, like the rest
    Vec<RectF> quads;
    Str contents;
    Str author;
    time_t modDate = 0;
    PdfColor color = 0; // 0: none
    PdfColor interior = 0;
    int opacity = 255;
    int borderWidth = 1;
    // /BS overrides /Border, the only width PDFium writes
    bool hasBorderStyle = false;
    Str iconName;
    Vec<int> inkCounts;
    Vec<PointF> inkPoints;

    ~PdfiumAnnot() {
        str::Free(contents);
        str::Free(author);
        str::Free(iconName);
    }
};

struct PdfiumPage {
    SizeF size;
    bool linksLoaded = false;
    Vec<IPageElement*> links;
    bool annotsLoaded = false;
    Vec<PdfiumAnnot*> annots;
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

// FPDF_ANNOT_* subtypes, in order, as the AnnotationType each one is
static const AnnotationType kPdfiumAnnotTypes[] = {
    AnnotationType::Unknown,   AnnotationType::Text,           AnnotationType::Link,        AnnotationType::FreeText,
    AnnotationType::Line,      AnnotationType::Square,         AnnotationType::Circle,      AnnotationType::Polygon,
    AnnotationType::PolyLine,  AnnotationType::Highlight,      AnnotationType::Underline,   AnnotationType::Squiggly,
    AnnotationType::StrikeOut, AnnotationType::Stamp,          AnnotationType::Caret,       AnnotationType::Ink,
    AnnotationType::Popup,     AnnotationType::FileAttachment, AnnotationType::Sound,       AnnotationType::Movie,
    AnnotationType::Widget,    AnnotationType::Screen,         AnnotationType::PrinterMark, AnnotationType::TrapNet,
    AnnotationType::Watermark, AnnotationType::ThreeD,         AnnotationType::RichMedia,   AnnotationType::Widget,
    AnnotationType::Redact,
};

static AnnotationType AnnotTypeFromPdfium(int subtype) {
    if (subtype < 0 || subtype >= dimofi(kPdfiumAnnotTypes)) {
        return AnnotationType::Unknown;
    }
    return kPdfiumAnnotTypes[subtype];
}

static int PdfiumSubtype(AnnotationType type) {
    for (int i = 1; i < dimofi(kPdfiumAnnotTypes); i++) {
        if (kPdfiumAnnotTypes[i] == type) {
            return i;
        }
    }
    return FPDF_ANNOT_UNKNOWN;
}

// "D:YYYYMMDDHHmmSS" with an optional Z or +HH'mm' / -HH'mm' offset; 0 if malformed
static time_t ParsePdfDate(Str s) {
    str::TrimPrefix(s, StrL("D:"));
    int v[6] = {0, 1, 1, 0, 0, 0};
    const int widths[6] = {4, 2, 2, 2, 2, 2};
    int pos = 0;
    for (int i = 0; i < 6 && pos + widths[i] <= len(s); i++) {
        int n = 0;
        for (int k = 0; k < widths[i]; k++) {
            char c = s.s[pos + k];
            if (c < '0' || c > '9') {
                return 0;
            }
            n = n * 10 + (c - '0');
        }
        v[i] = n;
        pos += widths[i];
    }
    if (pos < 4) {
        return 0;
    }
    tm t{};
    t.tm_year = v[0] - 1900;
    t.tm_mon = v[1] - 1;
    t.tm_mday = v[2];
    t.tm_hour = v[3];
    t.tm_min = v[4];
    t.tm_sec = v[5];
    time_t res = _mkgmtime(&t);
    if (res < 0) {
        return 0;
    }
    char sign = pos < len(s) ? s.s[pos] : 'Z';
    if ((sign == '+' || sign == '-') && pos + 3 <= len(s)) {
        int hh = (s.s[pos + 1] - '0') * 10 + (s.s[pos + 2] - '0');
        int mm = pos + 6 <= len(s) ? (s.s[pos + 4] - '0') * 10 + (s.s[pos + 5] - '0') : 0;
        int offset = (hh * 60 + mm) * 60;
        res += sign == '+' ? -offset : offset;
    }
    return res;
}

static TempStr FormatPdfDateUtcTemp(time_t t) {
    tm u{};
    gmtime_s(&u, &t);
    return fmt("D:%04d%02d%02d%02d%02d%02dZ", u.tm_year + 1900, u.tm_mon + 1, u.tm_mday, u.tm_hour, u.tm_min, u.tm_sec);
}

// like Annotation.cpp: the settings' default author, or the user's name; empty for "(none)"
static Str DefaultAnnotAuthor() {
    Str author = gSettings->annotations.defaultAuthor;
    if (str::Eq(author, StrL("(none)"))) {
        return {};
    }
    if (!str::IsEmptyOrWhiteSpace(author)) {
        return author;
    }
    Str user = Str(getenv("USER"));
    if (len(user) == 0) {
        user = Str(getenv("USERNAME"));
    }
    return len(user) > 0 ? user : StrL("user");
}

class EnginePdfium : public EngineBase, public AnnotationBackend {
    FPDF_DOCUMENT doc = nullptr;
    bool annotsModified = false;
    // widgets (form fields) are drawn only through a form handle; null without an AcroForm
    FPDF_FORMFILLINFO formInfo{};
    FPDF_FORMHANDLE form = nullptr;
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
            for (auto* a : p->annots) {
                delete a->annot;
                delete a;
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
        unsigned long permissions = gPdfium.FPDF_GetDocPermissions(doc);
        allowsPrinting = (permissions & (1UL << 2)) != 0;
        allowsCopyingText = (permissions & (1UL << 4)) != 0;
        if (gPdfium.FPDF_GetFormType(doc) != FORMTYPE_NONE) {
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
    int DrawPage(RenderPageArgs& args, Pixmap* pixmap, double x, double y, RectF full, PdfiumCookie* cookie,
                 PdfiumProfile& profile) {
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
        if (PdfiumPage* info = pages[args.pageNo - 1]) {
            LoadAnnots(args.pageNo, info, page);
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
            int flags = hideAnnotations ? 0 : FPDF_ANNOT;
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
            if (form && !hideAnnotations && status == FPDF_RENDER_DONE && !AtomicIntGet(&cookie->aborted)) {
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

        int status = DrawPage(args, pixmap, x, y, full, cookie, profile);
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
        if (!pixmap->hasAlpha && args.target == RenderTarget::View) {
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
        ScopedMutex lock(&gPdfiumLock);
        auto* info = Page(pageNo);
        if (!info) {
            return Vec<IPageElement*>();
        }
        LoadLinks(pageNo, info);
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
        ScopedMutex lock(&gPdfiumLock);
        if (!tocLoaded) {
            PdfiumProfile profile(StrL("outline"));
            int budget = 4096, id = 0;
            auto* root = AllocTocItem(arena, {}, 0);
            root->child = ReadBookmarks(gPdfium.FPDFBookmark_GetFirstChild(doc, nullptr), root, 0, budget, id);
            if (root->child) {
                toc = AllocTocTree(arena, root);
            }
            tocLoaded = true;
            profile.Mark(StrL("read"));
        }
        return toc;
    }

    TempStr GetPropertyTemp(DocProp prop) override {
        if (prop == DocProp::UnsupportedFeatures) {
            return StrL(
                "Experimental PDFium: annotation editing, interactive forms, JavaScript, signatures, "
                "attachments and advanced PDF dark mode are not implemented.");
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

    //--- annotations (AnnotationBackend); callers of the private helpers hold gPdfiumLock

    AnnotationBackend* GetAnnotationBackend() override { return this; }

    // the inverse of ToPage: page space to PDF user space
    void FromPage(FPDF_PAGE page, PdfiumPage* info, PointF pt, double* x, double* y) {
        constexpr int kCoordScale = 1 << 20;
        int px = (int)lround(pt.x * kCoordScale / info->size.dx);
        int py = (int)lround(pt.y * kCoordScale / info->size.dy);
        *x = *y = 0;
        gPdfium.FPDF_DeviceToPage(page, 0, 0, kCoordScale, kCoordScale, 0, px, py, x, y);
    }

    // a page-space rect's corners in PDF space: upper left, upper right, lower left, lower right as seen
    FS_QUADPOINTSF ToPdfQuad(FPDF_PAGE page, PdfiumPage* info, RectF r) {
        PointF c[4] = {{r.x, r.y}, {r.x + r.dx, r.y}, {r.x, r.y + r.dy}, {r.x + r.dx, r.y + r.dy}};
        double x[4]{}, y[4]{};
        for (int i = 0; i < 4; i++) {
            FromPage(page, info, c[i], &x[i], &y[i]);
        }
        return {(float)x[0], (float)y[0], (float)x[1], (float)y[1], (float)x[2], (float)y[2], (float)x[3], (float)y[3]};
    }

    FS_RECTF ToPdfRect(FPDF_PAGE page, PdfiumPage* info, RectF r) {
        FS_QUADPOINTSF q = ToPdfQuad(page, info, r);
        float xs[4] = {q.x1, q.x2, q.x3, q.x4}, ys[4] = {q.y1, q.y2, q.y3, q.y4};
        FS_RECTF res{xs[0], ys[0], xs[0], ys[0]};
        for (int i = 1; i < 4; i++) {
            res.left = std::min(res.left, xs[i]);
            res.right = std::max(res.right, xs[i]);
            res.bottom = std::min(res.bottom, ys[i]);
            res.top = std::max(res.top, ys[i]);
        }
        return res;
    }

    static Str AnnotString(FPDF_ANNOTATION a, const char* key) {
        unsigned long bytes = gPdfium.FPDFAnnot_GetStringValue(a, key, nullptr, 0);
        constexpr unsigned long kMaxBytes = 4 * 1024 * 1024;
        if (bytes <= sizeof(WCHAR) || bytes > kMaxBytes || bytes % sizeof(WCHAR) != 0) {
            return {};
        }
        WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
        if (gPdfium.FPDFAnnot_GetStringValue(a, key, (FPDF_WCHAR*)buf, bytes) != bytes) {
            return {};
        }
        return str::Dup(ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1)));
    }

    static bool SetAnnotString(FPDF_ANNOTATION a, const char* key, Str v) {
        return gPdfium.FPDFAnnot_SetStringValue(a, key, (FPDF_WIDESTRING)ToWStrTemp(v).s);
    }

    // FPDFAnnot_SetColor also writes /CA, the opacity
    static bool WriteColor(FPDF_ANNOTATION a, bool interior, PdfColor c, int opacity) {
        u8 r, g, b, alpha;
        UnpackPdfColor(c, r, g, b, alpha);
        auto type = interior ? FPDFANNOT_COLORTYPE_InteriorColor : FPDFANNOT_COLORTYPE_Color;
        return gPdfium.FPDFAnnot_SetColor(a, type, r, g, b, (unsigned int)setMinMax(opacity, 0, 255));
    }

    // PDFium draws a missing appearance from the values only for these
    static bool PdfiumDrawsAppearance(AnnotationType type) {
        switch (type) {
            case AnnotationType::Highlight:
            case AnnotationType::Underline:
            case AnnotationType::Squiggly:
            case AnnotationType::StrikeOut:
            case AnnotationType::Square:
            case AnnotationType::Circle:
            case AnnotationType::Ink:
            case AnnotationType::Text:
            case AnnotationType::Popup:
                return true;
            default:
                return false;
        }
    }

    // Before a change to how it looks: the stored appearance would win over the new values,
    // and FPDFAnnot_SetColor refuses an annotation that has one.
    static void DropAppearance(FPDF_ANNOTATION a, Annotation* annot) {
        if (PdfiumDrawsAppearance(annot->type)) {
            gPdfium.FPDFAnnot_SetAP(a, FPDF_ANNOT_APPEARANCEMODE_NORMAL, nullptr);
        }
    }

    static RectF AnnotBounds(PdfiumAnnot* rec) {
        if (!rec->rect.IsEmpty() || len(rec->quads) == 0) {
            return rec->rect;
        }
        RectF res = rec->quads[0];
        for (RectF q : rec->quads) {
            res = res.Union(q);
        }
        return res;
    }

    void ReadAnnot(FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
        FS_RECTF r{};
        if (gPdfium.FPDFAnnot_GetRect(a, &r)) {
            rec->rect = ToPageRect(page, info, r.left, r.bottom, r.right, r.top);
        }
        VecClear(rec->quads);
        constexpr size_t kMaxQuads = 100000;
        size_t nQuads = gPdfium.FPDFAnnot_CountAttachmentPoints(a);
        for (size_t i = 0; i < nQuads && i < kMaxQuads; i++) {
            FS_QUADPOINTSF q{};
            if (!gPdfium.FPDFAnnot_GetAttachmentPoints(a, i, &q)) {
                continue;
            }
            RectF b = RectF::FromXY(ToPage(page, info, q.x1, q.y1), ToPage(page, info, q.x4, q.y4));
            b = b.Union(RectF::FromXY(ToPage(page, info, q.x2, q.y2), ToPage(page, info, q.x3, q.y3)));
            VecAppend(rec->quads, b);
        }
        str::Free(rec->contents);
        rec->contents = AnnotString(a, "Contents");
        str::Free(rec->author);
        rec->author = AnnotString(a, "T");
        Str date = AnnotString(a, "M");
        rec->modDate = ParsePdfDate(date);
        str::Free(date);
        unsigned int cr = 0, cg = 0, cb = 0, ca = 0;
        rec->color = 0;
        if (gPdfium.FPDFAnnot_GetColor(a, FPDFANNOT_COLORTYPE_Color, &cr, &cg, &cb, &ca)) {
            rec->color = MkPdfColor((u8)cr, (u8)cg, (u8)cb, 0xff);
        }
        rec->interior = 0;
        if (gPdfium.FPDFAnnot_GetColor(a, FPDFANNOT_COLORTYPE_InteriorColor, &cr, &cg, &cb, &ca)) {
            rec->interior = MkPdfColor((u8)cr, (u8)cg, (u8)cb, 0xff);
        }
        float opacity = 1;
        rec->opacity = gPdfium.FPDFAnnot_GetNumberValue(a, "CA", &opacity) ? (int)(opacity * 255.f + 0.5f) : 255;
        float rx = 0, ry = 0, width = 1;
        rec->borderWidth = gPdfium.FPDFAnnot_GetBorder(a, &rx, &ry, &width) ? (int)(width + 0.5f) : 1;
        rec->hasBorderStyle = gPdfium.FPDFAnnot_HasKey(a, "BS");
        str::Free(rec->iconName);
        rec->iconName = AnnotString(a, "Name");
        ReadInk(page, info, a, rec);
    }

    void ReadInk(FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
        VecClear(rec->inkCounts);
        VecClear(rec->inkPoints);
        constexpr unsigned long kMaxPoints = 1000000;
        unsigned long nStrokes = gPdfium.FPDFAnnot_GetInkListCount(a);
        unsigned long total = 0;
        for (unsigned long i = 0; i < nStrokes; i++) {
            unsigned long n = gPdfium.FPDFAnnot_GetInkListPath(a, i, nullptr, 0);
            if (n == 0 || total + n > kMaxPoints) {
                continue;
            }
            FS_POINTF* pts = AllocArrayTemp<FS_POINTF>((int)n);
            if (gPdfium.FPDFAnnot_GetInkListPath(a, i, pts, n) != n) {
                continue;
            }
            for (unsigned long k = 0; k < n; k++) {
                VecAppend(rec->inkPoints, ToPage(page, info, pts[k].x, pts[k].y));
            }
            VecAppend(rec->inkCounts, (int)n);
            total += n;
        }
    }

    // Replaces /InkList; /Rect is the strokes' extent plus half the line width, as MuPDF sets it.
    bool WriteInk(FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, const Vec<int>& counts,
                  const Vec<PointF>& points, int width) {
        if (len(points) == 0) {
            return false;
        }
        gPdfium.FPDFAnnot_SetAP(a, FPDF_ANNOT_APPEARANCEMODE_NORMAL, nullptr);
        gPdfium.FPDFAnnot_RemoveInkList(a);
        Vec<FS_POINTF> stroke;
        int start = 0;
        for (int count : counts) {
            VecClear(stroke);
            for (int i = start; i < start + count && i < len(points); i++) {
                double x = 0, y = 0;
                FromPage(page, info, points[i], &x, &y);
                VecAppend(stroke, FS_POINTF{(float)x, (float)y});
            }
            start += count;
            if (len(stroke) > 0 && gPdfium.FPDFAnnot_AddInkStroke(a, stroke.els, (size_t)len(stroke)) < 0) {
                return false;
            }
        }
        PointF lo = points[0];
        PointF hi = points[0];
        for (PointF p : points) {
            lo = {std::min(lo.x, p.x), std::min(lo.y, p.y)};
            hi = {std::max(hi.x, p.x), std::max(hi.y, p.y)};
        }
        RectF r = RectF::FromXY(lo, hi);
        float half = (float)width / 2.f;
        r.Inflate(half, half);
        FS_RECTF pr = ToPdfRect(page, info, r);
        return gPdfium.FPDFAnnot_SetRect(a, &pr);
    }

    Annotation* NewAnnotation(AnnotationType type, int pageNo, PdfiumAnnot* rec) {
        auto* res = new Annotation();
        res->type = type;
        res->pageNo = pageNo;
        res->bounds = AnnotBounds(rec);
        res->backend = this;
        return res;
    }

    // Wraps the page's annotations once. Widgets are form fields, not annotations to the UI.
    // Like EngineMupdf, a render reads the page's annotations too, from the page it loaded anyway.
    void LoadAnnots(int pageNo, PdfiumPage* info, FPDF_PAGE loaded = nullptr) {
        if (info->annotsLoaded) {
            return;
        }
        info->annotsLoaded = true;
        FPDF_PAGE page = loaded ? loaded : gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return;
        }
        constexpr int kMaxAnnots = 100000;
        int n = std::min(gPdfium.FPDFPage_GetAnnotCount(page), kMaxAnnots);
        for (int i = 0; i < n; i++) {
            FPDF_ANNOTATION a = gPdfium.FPDFPage_GetAnnot(page, i);
            if (!a) {
                continue;
            }
            AnnotationType type = AnnotTypeFromPdfium(gPdfium.FPDFAnnot_GetSubtype(a));
            if (type != AnnotationType::Unknown && type != AnnotationType::Widget) {
                auto* rec = new PdfiumAnnot();
                rec->index = i;
                ReadAnnot(page, info, a, rec);
                rec->annot = NewAnnotation(type, pageNo, rec);
                VecAppend(info->annots, rec);
            }
            gPdfium.FPDFPage_CloseAnnot(a);
        }
        if (!loaded) {
            gPdfium.FPDF_ClosePage(page);
        }
    }

    PdfiumAnnot* Record(Annotation* annot, PdfiumPage** infoOut = nullptr) {
        if (!annot || annot->backend != this || annot->pageNo < 1 || annot->pageNo > pageCount) {
            return nullptr;
        }
        PdfiumPage* info = pages[annot->pageNo - 1];
        if (!info) {
            return nullptr;
        }
        for (auto* rec : info->annots) {
            if (rec->annot == annot) {
                if (infoOut) {
                    *infoOut = info;
                }
                return rec;
            }
        }
        return nullptr;
    }

    // Runs edit on annot's live FPDF_ANNOTATION; when it reports a change, rereads the cached values.
    template <typename Edit>
    bool EditAnnot(Annotation* annot, Edit edit) {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumPage* info = nullptr;
        PdfiumAnnot* rec = Record(annot, &info);
        if (!rec) {
            return false;
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, annot->pageNo - 1);
        if (!page) {
            return false;
        }
        FPDF_ANNOTATION a = gPdfium.FPDFPage_GetAnnot(page, rec->index);
        bool changed = a && edit(page, info, a, rec);
        if (changed) {
            ReadAnnot(page, info, a, rec);
            annot->bounds = AnnotBounds(rec);
            annotsModified = true;
        }
        if (a) {
            gPdfium.FPDFPage_CloseAnnot(a);
        }
        gPdfium.FPDF_ClosePage(page);
        return changed;
    }

    void GetAnnotations(Vec<Annotation*>& out, bool loadedOnly) override {
        VecClear(out);
        ScopedMutex lock(&gPdfiumLock);
        for (int pageNo = 1; pageNo <= pageCount; pageNo++) {
            PdfiumPage* info = loadedOnly ? pages[pageNo - 1] : Page(pageNo);
            if (!info) {
                continue;
            }
            if (!loadedOnly) {
                LoadAnnots(pageNo, info);
            }
            for (auto* rec : info->annots) {
                VecAppend(out, rec->annot);
            }
        }
    }

    // like EngineMupdf: the preferred one if it's hit, else the smallest hit
    Annotation* GetAnnotationAtPos(int pageNo, PointF pos, float padding, Annotation* preferred) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumPage* info = Page(pageNo);
        if (!info) {
            return nullptr;
        }
        LoadAnnots(pageNo, info);
        Annotation* best = nullptr;
        float bestArea = 0;
        for (auto* rec : info->annots) {
            RectF hit = rec->annot->bounds;
            hit.Inflate(padding, padding);
            if (!hit.Contains(pos)) {
                continue;
            }
            if (rec->annot == preferred) {
                return preferred;
            }
            float area = rec->annot->bounds.dx * rec->annot->bounds.dy;
            if (!best || area < bestArea) {
                best = rec->annot;
                bestArea = area;
            }
        }
        return best;
    }

    static bool CanCreate(AnnotationType type) {
        switch (type) {
            case AnnotationType::Text:
            case AnnotationType::Square:
            case AnnotationType::Circle:
            case AnnotationType::Ink:
                return true;
            default:
                return AnnotationIsTextMarkup(type);
        }
    }

    // the ink the user drew, or MuPDF's default zigzag at pos
    static void NewInk(PointF pos, AnnotCreateArgs* args, Vec<int>& counts, Vec<PointF>& points) {
        int total = 0;
        if (args->inkStrokeCounts && args->inkPoints) {
            for (int count : *args->inkStrokeCounts) {
                total = count > 0 && total >= 0 ? total + count : -1;
            }
        }
        if (total > 0 && total == len(*args->inkPoints)) {
            VecAppendVec(counts, *args->inkStrokeCounts);
            VecAppendVec(points, *args->inkPoints);
            return;
        }
        const PointF zigzag[] = {{0, 30}, {15, 5}, {30, 45}, {48, 10}, {65, 40}, {85, 15}};
        for (PointF p : zigzag) {
            VecAppend(points, PointF{pos.x + p.x, pos.y + p.y});
        }
        VecAppend(counts, dimofi(zigzag));
    }

    // Geometry, border and fill of a new note, shape or ink, with MuPDF's defaults.
    bool InitShape(FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, PointF pos, AnnotCreateArgs* args,
                   int opacity) {
        AnnotationType type = args->annotType;
        int width = args->borderWidth >= 0 ? args->borderWidth : 1;
        if (type != AnnotationType::Text) {
            gPdfium.FPDFAnnot_SetBorder(a, 0, 0, (float)width);
        }
        ParsedColor& fill = args->interiorCol;
        if (fill.parsedOk && fill.pdfCol != 0 && AnnotationSupportsInteriorColor(type)) {
            u8 r, g, b, alpha;
            UnpackPdfColor(fill.pdfCol, r, g, b, alpha);
            WriteColor(a, true, MkPdfColor(r, g, b, 0xff), opacity);
        }
        if (type == AnnotationType::Ink) {
            Vec<int> counts;
            Vec<PointF> points;
            NewInk(pos, args, counts, points);
            return WriteInk(page, info, a, counts, points, width);
        }
        // PDFium draws a note's icon 20 units square, and resizes /Rect to that
        constexpr float kNoteSize = 20;
        RectF r = args->hasRect ? args->rect : RectF{pos.x, pos.y, 100, 50};
        if (type == AnnotationType::Text) {
            r = {pos.x, pos.y, kNoteSize, kNoteSize};
        }
        FS_RECTF pr = ToPdfRect(page, info, r);
        return gPdfium.FPDFAnnot_SetRect(a, &pr);
    }

    // MuPDF's defaults for new annotations
    static PdfColor DefaultColor(AnnotationType type) {
        switch (type) {
            case AnnotationType::Highlight:
            case AnnotationType::Text:
                return MkPdfColor(0xff, 0xff, 0);
            case AnnotationType::Underline:
                return MkPdfColor(0, 0xff, 0);
            case AnnotationType::Squiggly:
                return MkPdfColor(0xff, 0, 0xff);
            default:
                return MkPdfColor(0xff, 0, 0);
        }
    }

    // Text markup gets its quads from the caller (MakeAnnotationsFromSelection). A note's icon
    // can't be chosen: PDFium can't write /Name.
    Annotation* Create(int pageNo, PointF pos, AnnotCreateArgs* args) override {
        AnnotationType type = args->annotType;
        if (!CanCreate(type)) {
            return nullptr;
        }
        ScopedMutex lock(&gPdfiumLock);
        PdfiumPage* info = Page(pageNo);
        if (!info) {
            return nullptr;
        }
        LoadAnnots(pageNo, info);
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return nullptr;
        }
        Annotation* res = nullptr;
        FPDF_ANNOTATION a = gPdfium.FPDFPage_CreateAnnot(page, PdfiumSubtype(type));
        if (a) {
            gPdfium.FPDFAnnot_SetFlags(a, FPDF_ANNOT_FLAG_PRINT);
            SetAnnotString(a, "M", FormatPdfDateUtcTemp(time(nullptr)));
            Str author = DefaultAnnotAuthor();
            if (len(author) > 0) {
                SetAnnotString(a, "T", author);
            }
            if (!str::IsEmptyOrWhiteSpace(args->content)) {
                SetAnnotString(a, "Contents", args->content);
            }
            // like EngineMupdfCreateAnnotation: the color's alpha is the opacity, unless given
            bool hasCol = args->col.parsedOk && args->col.pdfCol != 0;
            PdfColor col = hasCol ? args->col.pdfCol : DefaultColor(type);
            u8 r, g, b, alpha;
            UnpackPdfColor(col, r, g, b, alpha);
            int opacity = args->opacity < 100 ? (args->opacity * 255) / 100 : alpha;
            WriteColor(a, false, MkPdfColor(r, g, b, 0xff), opacity);
            if (!AnnotationIsTextMarkup(type) && !InitShape(page, info, a, pos, args, opacity)) {
                int idx = gPdfium.FPDFPage_GetAnnotIndex(page, a);
                gPdfium.FPDFPage_CloseAnnot(a);
                gPdfium.FPDFPage_RemoveAnnot(page, idx);
                gPdfium.FPDF_ClosePage(page);
                return nullptr;
            }
            auto* rec = new PdfiumAnnot();
            rec->index = gPdfium.FPDFPage_GetAnnotIndex(page, a);
            ReadAnnot(page, info, a, rec);
            res = rec->annot = NewAnnotation(type, pageNo, rec);
            VecAppend(info->annots, rec);
            annotsModified = true;
            gPdfium.FPDFPage_CloseAnnot(a);
        }
        gPdfium.FPDF_ClosePage(page);
        return res;
    }

    bool HasUnsaved() override { return annotsModified; }

    struct FileWriter : FPDF_FILEWRITE {
        HANDLE h = INVALID_HANDLE_VALUE;
        bool ok = true;
    };

    static int WriteBlock(FPDF_FILEWRITE* w, const void* data, unsigned long size) {
        auto* fw = (FileWriter*)w;
        DWORD written = 0;
        fw->ok = fw->ok && WriteFile(fw->h, data, size, &written, nullptr) && written == size;
        return fw->ok ? 1 : 0;
    }

    // Writes the document next to path and swaps it in, so a failed save leaves the file alone.
    bool WritePdf(Str path, FPDF_DWORD flags, TempStr* err) {
        TempStr tmp = str::JoinTemp(path, StrL(".solokpdf-tmp"));
        FileWriter w;
        w.version = 1;
        w.WriteBlock = WriteBlock;
        w.h = CreateFileW(CWStrTemp(ToWStrTemp(tmp)), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                          nullptr);
        if (w.h == INVALID_HANDLE_VALUE) {
            *err = fmt("can't create '%s' (error %d)", tmp, (int)GetLastError());
            return false;
        }
        bool ok;
        {
            ScopedMutex lock(&gPdfiumLock);
            ok = gPdfium.FPDF_SaveAsCopy(doc, &w, flags) && w.ok;
        }
        ok = CloseHandle(w.h) && ok;
        if (ok && !MoveFileExW(CWStrTemp(ToWStrTemp(tmp)), CWStrTemp(ToWStrTemp(path)), MOVEFILE_REPLACE_EXISTING)) {
            *err = fmt("can't replace '%s' (error %d)", path, (int)GetLastError());
            ok = false;
        } else if (!ok) {
            *err = StrL("PDFium could not write the document");
        }
        if (!ok) {
            DeleteFileW(CWStrTemp(ToWStrTemp(tmp)));
        }
        return ok;
    }

    // An incremental update, as EngineMupdf writes; the caller reloads the document.
    bool SaveUpdated(Str path, const Func1<Str>& showError) override {
        if (!annotsModified) {
            return false;
        }
        TempStr err;
        if (!WritePdf(len(path) > 0 ? path : FilePath(), FPDF_INCREMENTAL, &err)) {
            logf("EnginePdfium::SaveUpdated: %s\n", err);
            if (showError.IsValid()) {
                showError.Call(err);
            }
            return false;
        }
        annotsModified = false;
        return true;
    }

    bool SaveCopy(Str path) override {
        TempStr err;
        bool ok = WritePdf(path, FPDF_NO_INCREMENTAL, &err);
        if (!ok) {
            logf("EnginePdfium::SaveCopy: %s\n", err);
        }
        return ok;
    }

    bool IsLive(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        return Record(annot) != nullptr;
    }

    RectF Bounds(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return rec ? AnnotBounds(rec) : (annot ? annot->bounds : RectF{});
    }

    // Ink moves its strokes (it can't be resized). Line and polygon geometry is /L and
    // /Vertices, which PDFium can't write; moving /Rect alone would leave it behind.
    void SetRect(Annotation* annot, RectF r) override {
        AnnotationType type = annot ? annot->type : AnnotationType::Unknown;
        if (type == AnnotationType::Line || type == AnnotationType::Polygon || type == AnnotationType::PolyLine) {
            return;
        }
        EditAnnot(annot, [&](FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
            if (type == AnnotationType::Ink) {
                Vec<PointF> moved;
                for (PointF p : rec->inkPoints) {
                    VecAppend(moved, PointF{p.x + r.x - rec->rect.x, p.y + r.y - rec->rect.y});
                }
                return WriteInk(page, info, a, rec->inkCounts, moved, rec->borderWidth);
            }
            DropAppearance(a, annot);
            FS_RECTF pr = ToPdfRect(page, info, r);
            return (bool)gPdfium.FPDFAnnot_SetRect(a, &pr);
        });
    }

    Vec<RectF> QuadPoints(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        Vec<RectF> res;
        if (rec) {
            VecAppendVec(res, rec->quads);
        }
        return res;
    }

    // PDFium can't drop quads; extra old ones repeat the last new one. /Rect becomes their union.
    void SetQuadPoints(Annotation* annot, const Vec<RectF>& rects) override {
        if (len(rects) == 0) {
            return;
        }
        EditAnnot(annot, [&](FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, PdfiumAnnot*) {
            DropAppearance(a, annot);
            int nOld = (int)gPdfium.FPDFAnnot_CountAttachmentPoints(a);
            RectF all = rects[0];
            for (int i = 0; i < std::max(nOld, len(rects)); i++) {
                RectF r = rects[std::min(i, len(rects) - 1)];
                all = all.Union(r);
                FS_QUADPOINTSF q = ToPdfQuad(page, info, r);
                if (i < nOld) {
                    gPdfium.FPDFAnnot_SetAttachmentPoints(a, i, &q);
                } else {
                    gPdfium.FPDFAnnot_AppendAttachmentPoints(a, &q);
                }
            }
            FS_RECTF pr = ToPdfRect(page, info, all);
            gPdfium.FPDFAnnot_SetRect(a, &pr);
            return true;
        });
    }

    Str Contents(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return rec ? str::DupTemp(rec->contents) : Str{};
    }

    bool SetContents(Annotation* annot, Str v) override {
        return EditAnnot(annot, [&](FPDF_PAGE, PdfiumPage*, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
            return !str::Eq(rec->contents, v) && SetAnnotString(a, "Contents", v);
        });
    }

    Str Author(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return rec ? str::DupTemp(rec->author) : Str{};
    }

    time_t ModificationDate(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return rec ? rec->modDate : 0;
    }

    void SetModificationDateToNow(Annotation* annot) override {
        EditAnnot(annot, [&](FPDF_PAGE, PdfiumPage*, FPDF_ANNOTATION a, PdfiumAnnot*) {
            return SetAnnotString(a, "M", FormatPdfDateUtcTemp(time(nullptr)));
        });
    }

    PdfColor Color(Annotation* annot, bool interior) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return !rec ? 0 : interior ? rec->interior : rec->color;
    }

    // Like Annotation.cpp: c's alpha is the opacity; no color (0) hides text markup. PDFium can't
    // remove /IC, so an interior color can't go back to none.
    bool SetColor(Annotation* annot, PdfColor c, bool interior) override {
        return EditAnnot(annot, [&](FPDF_PAGE, PdfiumPage*, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
            u8 r, g, b, alpha;
            UnpackPdfColor(c, r, g, b, alpha);
            PdfColor rgb = MkPdfColor(r, g, b, 0xff);
            if (interior) {
                if (c == 0 || rgb == rec->interior) {
                    return false;
                }
                DropAppearance(a, annot);
                return WriteColor(a, true, rgb, rec->opacity);
            }
            if (c == 0) {
                rgb = rec->color;
                alpha = AnnotationIsTextMarkup(annot->type) ? 0 : (u8)rec->opacity;
            }
            if (rgb == rec->color && alpha == rec->opacity) {
                return false;
            }
            DropAppearance(a, annot);
            return WriteColor(a, false, rgb, alpha);
        });
    }

    int Opacity(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return rec ? rec->opacity : 255;
    }

    void SetOpacity(Annotation* annot, int opacity) override {
        EditAnnot(annot, [&](FPDF_PAGE, PdfiumPage*, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
            if (opacity == rec->opacity) {
                return false;
            }
            DropAppearance(a, annot);
            return WriteColor(a, false, rec->color, opacity);
        });
    }

    int BorderWidth(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return rec ? rec->borderWidth : 0;
    }

    // PDFium writes /Border only, which a /BS width overrides
    void SetBorderWidth(Annotation* annot, int width) override {
        EditAnnot(annot, [&](FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
            if (width < 0 || width == rec->borderWidth || rec->hasBorderStyle) {
                return false;
            }
            if (!gPdfium.FPDFAnnot_SetBorder(a, 0, 0, (float)width)) {
                return false;
            }
            if (annot->type == AnnotationType::Ink) {
                WriteInk(page, info, a, rec->inkCounts, rec->inkPoints, width);
            }
            return true;
        });
    }

    Str IconName(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        return rec ? str::DupTemp(rec->iconName) : Str{};
    }

    void InkList(Annotation* annot, Vec<int>& counts, Vec<PointF>& points) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumAnnot* rec = Record(annot);
        if (rec) {
            VecAppendVec(counts, rec->inkCounts);
            VecAppendVec(points, rec->inkPoints);
        }
    }

    bool SetInkList(Annotation* annot, const Vec<int>& counts, const Vec<PointF>& points) override {
        return EditAnnot(annot, [&](FPDF_PAGE page, PdfiumPage* info, FPDF_ANNOTATION a, PdfiumAnnot* rec) {
            return WriteInk(page, info, a, counts, points, rec->borderWidth);
        });
    }

    void Delete(Annotation* annot) override {
        ScopedMutex lock(&gPdfiumLock);
        PdfiumPage* info = nullptr;
        PdfiumAnnot* rec = Record(annot, &info);
        if (!rec) {
            return;
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, annot->pageNo - 1);
        if (!page) {
            return;
        }
        if (gPdfium.FPDFPage_RemoveAnnot(page, rec->index)) {
            for (auto* other : info->annots) {
                if (other->index > rec->index) {
                    other->index--;
                }
            }
            VecRemove(info->annots, rec);
            delete rec;
            annotsModified = true;
        }
        gPdfium.FPDF_ClosePage(page);
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
