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
#include <psapi.h>
#include <fpdfview.h>
#include <fpdf_annot.h>
#include <fpdf_doc.h>
#include <fpdf_text.h>
#include <fpdf_progressive.h>
#include <fpdf_sysfontinfo.h>
#include "PdfiumFontCache.h"
#include "EnginePdfium.h"
#include "SumatraLog.h"

#define PDFIUM_API(X)                 \
    X(FPDF_InitLibraryWithConfig)     \
    X(FPDF_DestroyLibrary)            \
    X(FPDF_GetDefaultSystemFontInfo)  \
    X(FPDF_SetSystemFontInfo)         \
    X(FPDF_FreeDefaultSystemFontInfo) \
    X(FPDF_LoadCustomDocument)        \
    X(FPDF_LoadMemDocument)           \
    X(FPDF_CloseDocument)             \
    X(FPDF_GetLastError)              \
    X(FPDF_GetPageCount)              \
    X(FPDF_GetDocPermissions)         \
    X(FPDF_GetPageSizeByIndexF)       \
    X(FPDF_LoadPage)                  \
    X(FPDF_ClosePage)                 \
    X(FPDF_PageToDevice)              \
    X(FPDFBitmap_CreateEx)            \
    X(FPDFBitmap_FillRect)            \
    X(FPDFBitmap_Destroy)             \
    X(FPDF_RenderPageBitmap_Start)    \
    X(FPDF_RenderPage_Continue)       \
    X(FPDF_RenderPage_Close)          \
    X(FPDFText_LoadPage)              \
    X(FPDFText_ClosePage)             \
    X(FPDFText_CountChars)            \
    X(FPDFText_GetUnicode)            \
    X(FPDFText_GetCharBox)            \
    X(FPDFLink_Enumerate)             \
    X(FPDFLink_GetAnnotRect)          \
    X(FPDFLink_GetDest)               \
    X(FPDFLink_GetAction)             \
    X(FPDFLink_GetAnnot)              \
    X(FPDFAnnot_GetStringValue)       \
    X(FPDFPage_CloseAnnot)            \
    X(FPDFAction_GetType)             \
    X(FPDFAction_GetDest)             \
    X(FPDFAction_GetURIPath)          \
    X(FPDFAction_GetFilePath)         \
    X(FPDFDest_GetDestPageIndex)      \
    X(FPDFDest_GetLocationInPage)     \
    X(FPDFDest_GetView)               \
    X(FPDF_GetNamedDestByName)        \
    X(FPDFBookmark_GetFirstChild)     \
    X(FPDFBookmark_GetNextSibling)    \
    X(FPDFBookmark_GetTitle)          \
    X(FPDFBookmark_GetDest)           \
    X(FPDFBookmark_GetAction)         \
    X(FPDF_GetMetaText)               \
    X(FPDF_GetPageLabel)

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
    Vec<IPageElement*> links;
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

class EnginePdfium : public EngineBase {
    FPDF_DOCUMENT doc = nullptr;
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
            p = new PdfiumPage();
            p->size = SizeF(size.width, size.height);
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
            }
            result.text = text.TakeStr();
            result.nCodepoints = len(coords);
            result.coords = VecTake(coords);
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
        constexpr int kMaxLinks = 100000;
        while (len(info->links) < kMaxLinks && gPdfium.FPDFLink_Enumerate(page, &pos, &link)) {
            FS_RECTF box{};
            if (!gPdfium.FPDFLink_GetAnnotRect(link, &box)) {
                continue;
            }
            auto* dest = Destination(gPdfium.FPDFLink_GetDest(doc, link), gPdfium.FPDFLink_GetAction(link));
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
            delete p;
        }
        for (auto* dest : namedDests) {
            delete dest;
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
        ScopedMutex lock(&gPdfiumLock);
        profile.Mark(StrL("lock"));
        SetFilePath(path);
        if (!gPdfium.Acquire(error)) {
            return false;
        }
        runtime = true;
        profile.Mark(StrL("runtime"));
        file = CreateFileW(CWStrTemp(ToWStrTemp(path)), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
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
        LoadPageLabels();
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

    RectF PageMediabox(int pageNo) override {
        ScopedMutex lock(&gPdfiumLock);
        auto* p = Page(pageNo);
        return p ? RectF(0, 0, p->size.dx, p->size.dy) : RectF{};
    }

    Pixmap* RenderPage(RenderPageArgs& args) override {
        PdfiumProfile profile(StrL("render"), args.pageNo);
        PdfiumCookie localCookie;
        PdfiumCookie* cookie = &localCookie;
        if (args.cookie_out) {
            cookie = new PdfiumCookie();
            *args.cookie_out = cookie;
        }
        RectF box = PageMediabox(args.pageNo);
        if (box.IsEmpty() || !isfinite(args.zoom) || args.zoom <= 0) {
            return nullptr;
        }
        RectF full = Transform(box, args.pageNo, args.zoom, args.rotation);
        RectF area = args.pageRect ? Transform(*args.pageRect, args.pageNo, args.zoom, args.rotation) : full;
        double x = floor(area.x), y = floor(area.y);
        double w = ceil(area.x + area.dx) - x, h = ceil(area.y + area.dy) - y;
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
        ScopedMutex lock(&gPdfiumLock);
        profile.Mark(StrL("lock"));
        if (AtomicIntGet(&cookie->aborted)) {
            FreePixmap(pixmap);
            return nullptr;
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, args.pageNo - 1);
        if (!page) {
            FreePixmap(pixmap);
            return nullptr;
        }
        profile.Mark(StrL("page"));
        if (PdfiumCookie::IsCanceled(cookie)) {
            gPdfium.FPDF_ClosePage(page);
            FreePixmap(pixmap);
            profile.Mark(StrL("canceled-page"));
            return nullptr;
        }
        FPDF_BITMAP bmp =
            gPdfium.FPDFBitmap_CreateEx(pixmap->width, pixmap->height, FPDFBitmap_BGRA, pixmap->data, pixmap->stride);
        profile.Mark(StrL("bitmap-create"));
        int status = FPDF_RENDER_FAILED;
        if (bmp) {
            gPdfium.FPDFBitmap_FillRect(bmp, 0, 0, pixmap->width, pixmap->height,
                                        args.transparentBackdrop ? 0 : 0xffffffff);
            profile.Mark(StrL("fill"));
            if (PdfiumCookie::IsCanceled(cookie)) {
                gPdfium.FPDFBitmap_Destroy(bmp);
                gPdfium.FPDF_ClosePage(page);
                FreePixmap(pixmap);
                profile.Mark(StrL("canceled-fill"));
                return nullptr;
            }
            int flags = hideAnnotations ? 0 : FPDF_ANNOT;
            if (disableAntiAlias) {
                flags |= FPDF_RENDER_NO_SMOOTHTEXT | FPDF_RENDER_NO_SMOOTHIMAGE | FPDF_RENDER_NO_SMOOTHPATH;
            } else {
                flags |= FPDF_LCD_TEXT;
            }
            if (args.target == RenderTarget::Print) {
                flags |= FPDF_PRINTING;
            }
            status =
                gPdfium.FPDF_RenderPageBitmap_Start(bmp, page, -(int)x, -(int)y, (int)ceil(full.dx), (int)ceil(full.dy),
                                                    NormalizeRotation(args.rotation) / 90, flags, &cookie->pause);
            while (status == FPDF_RENDER_TOBECONTINUED && !AtomicIntGet(&cookie->aborted)) {
                status = gPdfium.FPDF_RenderPage_Continue(page, &cookie->pause);
            }
            profile.Mark(StrL("draw"));
            gPdfium.FPDF_RenderPage_Close(page);
            gPdfium.FPDFBitmap_Destroy(bmp);
        }
        gPdfium.FPDF_ClosePage(page);
        profile.Mark(StrL("bitmap"));
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
                bool packed = CompactOpaquePixmap(pixmap, &cookie->aborted);
                profile.Mark(StrL("bgr"));
                if (!packed) {
                    FreePixmap(pixmap);
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
