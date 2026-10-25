/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include "base/Base.h"
#include "base/File.h"
#include "base/Pixmap.h"
#include "base/Timer.h"
#include "gui/UIModels.h"
#include "DocProperties.h"
#include "EngineBase.h"
#include <fpdfview.h>
#include <fpdf_doc.h>
#include <fpdf_text.h>
#include <fpdf_progressive.h>
#include "EnginePdfium.h"
#include "SumatraLog.h"

#define PDFIUM_API(X)              \
    X(FPDF_InitLibraryWithConfig)  \
    X(FPDF_DestroyLibrary)         \
    X(FPDF_LoadCustomDocument)     \
    X(FPDF_CloseDocument)          \
    X(FPDF_GetLastError)           \
    X(FPDF_GetPageCount)           \
    X(FPDF_GetDocPermissions)      \
    X(FPDF_GetPageSizeByIndexF)    \
    X(FPDF_LoadPage)               \
    X(FPDF_ClosePage)              \
    X(FPDF_PageToDevice)           \
    X(FPDFBitmap_CreateEx)         \
    X(FPDFBitmap_FillRect)         \
    X(FPDFBitmap_Destroy)          \
    X(FPDF_RenderPageBitmap_Start) \
    X(FPDF_RenderPage_Continue)    \
    X(FPDF_RenderPage_Close)       \
    X(FPDFText_LoadPage)           \
    X(FPDFText_ClosePage)          \
    X(FPDFText_CountChars)         \
    X(FPDFText_GetUnicode)         \
    X(FPDFText_GetCharBox)         \
    X(FPDFLink_Enumerate)          \
    X(FPDFLink_GetAnnotRect)       \
    X(FPDFLink_GetDest)            \
    X(FPDFLink_GetAction)          \
    X(FPDFAction_GetType)          \
    X(FPDFAction_GetDest)          \
    X(FPDFAction_GetURIPath)       \
    X(FPDFDest_GetDestPageIndex)   \
    X(FPDFDest_GetLocationInPage)  \
    X(FPDF_GetNamedDestByName)     \
    X(FPDFBookmark_GetFirstChild)  \
    X(FPDFBookmark_GetNextSibling) \
    X(FPDFBookmark_GetTitle)       \
    X(FPDFBookmark_GetDest)        \
    X(FPDFBookmark_GetAction)      \
    X(FPDF_GetMetaText)

// PDFium forbids concurrent calls even for different documents.
static Mutex gPdfiumLock;
static struct PdfiumApi {
    HMODULE module = nullptr;
    int users = 0;
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
        }
        users++;
        return true;
    }

    void Release() {
        if (--users == 0) {
            FPDF_DestroyLibrary();
        }
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
        logf("PDFium profile: %s thread=%lu page=%d %s=%.3f ms\n", operation, GetCurrentThreadId(), pageNo, phase,
             TimeSinceInMs(start));
        start = TimeGet();
    }
};

// Drop opaque alpha bytes without changing RGB values or allocating a second pixmap.
static void CompactOpaquePixmap(Pixmap* pixmap) {
    const int srcBpp = PixmapBytesPerPixel(PixmapFormat::BGRA8);
    const int dstBpp = PixmapBytesPerPixel(PixmapFormat::BGR8);
    constexpr int kRowAlign = sizeof(u32);
    int stride = (pixmap->width * dstBpp + kRowAlign - 1) & ~(kRowAlign - 1);
    for (int y = 0; y < pixmap->height; y++) {
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
    static FPDF_BOOL NeedPause(IFSDK_PAUSE* pause) { return AtomicIntGet(&((PdfiumCookie*)pause->user)->aborted) != 0; }
    void Abort() override { AtomicIntSet(&aborted, 1); }
    void* GetData() override { return &pause; }
};

class EnginePdfium : public EngineBase {
    FPDF_DOCUMENT doc = nullptr;
    HANDLE file = INVALID_HANDLE_VALUE;
    FPDF_FILEACCESS access{};
    bool runtime = false;
    Vec<PdfiumPage*> pages;
    Vec<IPageDestination*> namedDests;
    TocTree* toc = nullptr;
    bool tocLoaded = false;

    static int ReadBlock(void* user, unsigned long offset, unsigned char* data, unsigned long count) {
        auto* e = (EnginePdfium*)user;
        if (offset > e->access.m_FileLen || count > e->access.m_FileLen - offset) {
            return 0;
        }
        LARGE_INTEGER pos{};
        pos.QuadPart = offset;
        DWORD read = 0;
        return SetFilePointerEx(e->file, pos, nullptr, FILE_BEGIN) && ReadFile(e->file, data, count, &read, nullptr) &&
               read == count;
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
        PointF point;
        bool hasX = false;
        bool hasY = false;

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
            rect.x = hasX ? pt.x : 0;
            rect.y = hasY ? pt.y : 0;
            gPdfium.FPDF_ClosePage(page);
            engine = nullptr;
            return rect;
        }
    };

    IPageDestination* Destination(FPDF_DEST dest, FPDF_ACTION action, Arena* dstArena = nullptr) {
        if (!dest && action && gPdfium.FPDFAction_GetType(action) == PDFACTION_GOTO) {
            dest = gPdfium.FPDFAction_GetDest(doc, action);
        }
        if (!dest) {
            if (!action || gPdfium.FPDFAction_GetType(action) != PDFACTION_URI) {
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
        FPDF_BOOL hasX = 0, hasY = 0, hasZoom = 0;
        float x = 0, y = 0, zoom = 0;
        bool hasLocation = gPdfium.FPDFDest_GetLocationInPage(dest, &hasX, &hasY, &hasZoom, &x, &y, &zoom) != 0;
        auto* result = dstArena ? New<PdfiumDest>(dstArena) : new PdfiumDest();
        result->engine = hasLocation && (hasX || hasY) ? this : nullptr;
        result->point = PointF(x, y);
        result->hasX = hasX != 0;
        result->hasY = hasY != 0;
        result->pageNo = pageNo;
        result->rect = RectF(0, 0, kDestUseDefault, kDestUseDefault);
        result->kind = kindDestinationScrollTo;
        result->zoom = hasZoom ? zoom : 0.f;
        return result;
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
            auto* element = new PageElementDestination(dest);
            element->pageNo = pageNo;
            element->rect = ToPageRect(page, info, box.left, box.bottom, box.right, box.top);
            VecAppend(info->links, (IPageElement*)element);
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
        kind = "enginePdfium";
        defaultExt = str::Dup(StrL(".pdf"));
        fileDPI = 72;
    }

    ~EnginePdfium() override {
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
        if (file != INVALID_HANDLE_VALUE) {
            CloseHandle(file);
        }
        if (runtime) {
            gPdfium.Release();
        }
    }

    bool Load(Str path, TempStr* error) {
        PdfiumProfile profile(StrL("load"));
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
        access.m_GetBlock = ReadBlock;
        access.m_Param = this;
        doc = gPdfium.FPDF_LoadCustomDocument(&access, nullptr);
        if (!doc) {
            *error = fmt("PDFium document load failed (error %lu). Password UI is not implemented.",
                         gPdfium.FPDF_GetLastError());
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
        logf("PDFium 158.0.8111.0: opened '%s', %d pages; no MuPDF document\n", path, pageCount);
        return true;
    }

    EngineBase* Clone() override {
        TempStr error;
        return CreateEnginePdfium(FilePath(), &error);
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
        auto* pixmap = AllocPixmap((int)w, (int)h);
        if (!pixmap) {
            return nullptr;
        }
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
        FPDF_BITMAP bmp =
            gPdfium.FPDFBitmap_CreateEx(pixmap->width, pixmap->height, FPDFBitmap_BGRA, pixmap->data, pixmap->stride);
        int status = FPDF_RENDER_FAILED;
        if (bmp) {
            gPdfium.FPDFBitmap_FillRect(bmp, 0, 0, pixmap->width, pixmap->height,
                                        args.transparentBackdrop ? 0 : 0xffffffff);
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
            gPdfium.FPDF_RenderPage_Close(page);
            gPdfium.FPDFBitmap_Destroy(bmp);
        }
        gPdfium.FPDF_ClosePage(page);
        profile.Mark(StrL("bitmap"));
        if (status != FPDF_RENDER_DONE || AtomicIntGet(&cookie->aborted)) {
            FreePixmap(pixmap);
            return nullptr;
        }
        if (args.transparentBackdrop) {
            pixmap->hasAlpha = true;
            pixmap->premultiplied = true;
            for (int row = 0; row < pixmap->height; row++) {
                u8* px = pixmap->data + (size_t)row * pixmap->stride;
                for (int col = 0; col < pixmap->width; col++, px += 4) {
                    for (int c = 0; c < 3; c++) {
                        px[c] = (u8)((px[c] * px[3] + 127) / 255);
                    }
                }
            }
        }
        pixmap->xres = pixmap->yres = args.zoom * fileDPI;
        if (!pixmap->hasAlpha && args.target == RenderTarget::View) {
            CompactOpaquePixmap(pixmap);
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
        PageText result;
        profile.Mark(StrL("page"));
        FPDF_TEXTPAGE textPage = gPdfium.FPDFText_LoadPage(page);
        profile.Mark(StrL("text-page"));
        if (textPage) {
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
        }
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
                "attachments, page labels, automatic links and advanced PDF dark mode are not implemented.");
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

    Str GetFileData() override { return file::ReadFile(FilePath()); }
    bool SaveFileAs(Str path) override { return file::Copy(path, FilePath(), false); }
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

bool PdfiumRequested() {
    WCHAR value[32]{};
    DWORD count = GetEnvironmentVariableW(L"SOLOKPDF_ENGINE", value, dimofi(value));
    return count == 0 || (count < dimofi(value) && wcscmp(value, L"pdfium") == 0);
}

EngineBase* CreateEnginePdfium(Str path, TempStr* errorOut) {
    auto* engine = new EnginePdfium();
    if (engine->Load(path, errorOut)) {
        return engine;
    }
    logf("PDFium: %s File: '%s'\n", *errorOut, path);
    engine->Release();
    return nullptr;
}
