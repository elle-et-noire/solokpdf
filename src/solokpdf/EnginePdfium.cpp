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
#include "Annotation.h"
#include "Settings.h"
#include "SumatraConfig.h"
#include "PdfDarkMode.h"
#include <psapi.h>
#include <dpapi.h>
#include <zlib.h>
#include "PdfiumRuntime.h"
#include "EnginePdfium.h"
#include "SumatraLog.h"

TempStr ProtectPdfPasswordTemp(Str password, const u8 digest[16]) {
    DATA_BLOB input{(DWORD)len(password), (BYTE*)password.s};
    DATA_BLOB entropy{16, (BYTE*)digest};
    DATA_BLOB output{};
    if (!CryptProtectData(&input, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
        return {};
    }
    TempStr sealed = str::MemToHexTemp(Str((const char*)output.pbData, (int)output.cbData));
    LocalFree(output.pbData);
    return sealed;
}

Str UnprotectPdfPassword(Str sealed, const u8 digest[16]) {
    if (len(sealed) == 0 || len(sealed) % 2 != 0) {
        return {};
    }
    int n = len(sealed) / 2;
    BYTE* bytes = AllocArrayTemp<BYTE>(n);
    if (!str::HexToMem(sealed, Str((char*)bytes, n))) {
        return {};
    }
    DATA_BLOB input{(DWORD)n, bytes};
    DATA_BLOB entropy{16, (BYTE*)digest};
    DATA_BLOB output{};
    if (!CryptUnprotectData(&input, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) {
        return {};
    }
    Str password = str::Dup(Str((char*)output.pbData, (int)output.cbData));
    SecureZeroMemory(output.pbData, output.cbData);
    LocalFree(output.pbData);
    return password;
}

Kind kindEnginePdfium = "enginePdfium";
constexpr int kUnresolvedAttachment = -1;

struct PdfiumWidget {
    RectF rect;
    WidgetCursorKind cursor = WidgetCursorKind::None;
};

enum class DrawStatus {
    Done,
    NeedsMupdf,
    Canceled,
    Failed,
};

struct PageDrawResult {
    DrawStatus status;
    RenderPageColor color = RenderPageColor::Original;
};

struct PdfiumPage {
    SizeF size;
    PdfRenderRoute renderRoute = PdfRenderRoute::Unchecked;
    bool annotationsChecked = false;
    bool hasAnnotations = false;
    bool linksLoaded = false;
    bool hasFileAttachments = false;
    bool attachmentLinksLoaded = false;
    bool useMupdfElements = false;
    Vec<IPageElement*> links;
    // photos a themed page keeps in their colors, in page space
    bool imagesLoaded = false;
    Vec<RectF> images;
    bool imageElementsLoaded = false;
    Vec<IPageElement*> imageElements;
    // empty fillable form fields, in page space, until the editor holds field values
    bool formRectsLoaded = false;
    Vec<RectF> formRects;
    // form widgets for hover and click hit tests, until the editor is loaded
    bool widgetsLoaded = false;
    Vec<PdfiumWidget> widgets;
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

// Keys a byte scan looks for; each needs a MuPDF query.
enum PdfKeys {
    kGeometryKeys = 1, // /UserUnit, /Rotate off a multiple of 90
    kCatalogKeys = 2,  // /OpenAction, /PageLayout, /ViewerPreferences /Direction
};

static int ScanObjStream(FPDF_FILEACCESS& access, unsigned long marker, int want);

static bool HasName(Str data, int i, Str name) {
    return i + len(name) <= len(data) && memcmp(data.s + i, name.s, len(name)) == 0;
}

// Returns the keys of want that data may hold. Without access an object stream may hold any:
// encrypted ones can't be inflated.
static int ScanPdfKeys(Str data, int want, FPDF_FILEACCESS* access = nullptr, unsigned long offset = 0) {
    int found = 0;
    int i = 0;
    while (i < len(data) && found != want) {
        char* slash = (char*)memchr(data.s + i, '/', len(data) - i);
        if (!slash) {
            break;
        }
        i = (int)(slash - data.s);
        if (HasName(data, i, StrL("/ObjStm"))) {
            found |= access ? ScanObjStream(*access, offset + i, want & ~found) : want;
        }
        if (HasName(data, i, StrL("/OpenAction")) || HasName(data, i, StrL("/PageLayout")) ||
            HasName(data, i, StrL("/Direction"))) {
            found |= kCatalogKeys & want;
        }
        if (!(want & kGeometryKeys)) {
            i++;
            continue;
        }
        if (HasName(data, i, StrL("/UserUnit"))) {
            found |= kGeometryKeys;
        }
        if (!HasName(data, i, StrL("/Rotate"))) {
            i++;
            continue;
        }
        int at = i + len(StrL("/Rotate"));
        while (at < len(data) && (data.s[at] == ' ' || data.s[at] == '\r' || data.s[at] == '\n')) {
            at++;
        }
        int sign = 1;
        if (at < len(data) && (data.s[at] == '-' || data.s[at] == '+')) {
            sign = data.s[at++] == '-' ? -1 : 1;
        }
        int rotation = 0;
        bool hasDigit = false;
        while (at < len(data) && data.s[at] >= '0' && data.s[at] <= '9') {
            hasDigit = true;
            rotation = (rotation * 10 + data.s[at++] - '0') % 360;
        }
        if (!hasDigit || (sign * rotation) % 90 != 0) {
            found |= kGeometryKeys;
        }
        i = at;
    }
    return found & want;
}

// Inspect plain and Flate objects; unsupported stream filters may hold any key.
static int ScanObjStream(FPDF_FILEACCESS& access, unsigned long marker, int want) {
    constexpr unsigned long kPrefix = 512;
    constexpr unsigned long kHeader = 8192;
    constexpr unsigned long kBlock = 64 * 1024;
    unsigned long start = marker > kPrefix ? marker - kPrefix : 0;
    unsigned long size = access.m_FileLen - start < kHeader ? access.m_FileLen - start : kHeader;
    char header[kHeader + 1]{};
    if (!access.m_GetBlock(access.m_Param, start, (unsigned char*)header, size)) {
        return want;
    }
    char* obj = header + marker - start;
    char* dict = obj;
    while (dict > header && (dict[0] != '<' || dict[1] != '<')) {
        dict--;
    }
    if (dict == header) {
        return want;
    }
    char* stream = strstr(obj, "stream");
    char* length = strstr(dict, "/Length");
    if (!stream || !length || length > stream) {
        return want;
    }
    char* end = nullptr;
    unsigned long bytes = strtoul(length + 7, &end, 10);
    if (end == length + 7 || bytes > access.m_FileLen) {
        return want;
    }
    unsigned long offset = start + (unsigned long)(stream - header) + 6;
    if (header[offset - start] == '\r') {
        offset++;
    }
    if (header[offset - start] != '\n') {
        return want;
    }
    offset++;
    if (bytes > access.m_FileLen - offset) {
        return want;
    }
    char* filter = strstr(dict, "/Filter");
    char* params = strstr(dict, "/DecodeParms");
    if (!filter || filter > stream || (params && params < stream)) {
        return want;
    }
    char* codec = filter + 7;
    while (codec < stream && (*codec == ' ' || *codec == '\r' || *codec == '\n')) {
        codec++;
    }
    constexpr char kFlate[] = "/FlateDecode";
    if (stream - codec <= (int)sizeof(kFlate) || memcmp(codec, kFlate, sizeof(kFlate) - 1) != 0 ||
        (codec[sizeof(kFlate) - 1] != ' ' && codec[sizeof(kFlate) - 1] != '/' && codec[sizeof(kFlate) - 1] != '\r' &&
         codec[sizeof(kFlate) - 1] != '\n' && codec[sizeof(kFlate) - 1] != '>')) {
        return want;
    }
    z_stream z{};
    if (inflateInit(&z) != Z_OK) {
        return want;
    }
    unsigned char input[kBlock];
    unsigned char output[kBlock + 32];
    int overlap = 0;
    int found = 0;
    bool done = false;
    while (bytes > 0 && !done) {
        unsigned long n = bytes < kBlock ? bytes : kBlock;
        if (!access.m_GetBlock(access.m_Param, offset, input, n)) {
            found = want;
            break;
        }
        offset += n;
        bytes -= n;
        z.next_in = input;
        z.avail_in = n;
        while (z.avail_in > 0 && !done) {
            z.next_out = output + overlap;
            z.avail_out = kBlock;
            int status = inflate(&z, Z_NO_FLUSH);
            if (status != Z_OK && status != Z_STREAM_END) {
                found = want;
                done = true;
                break;
            }
            int produced = kBlock - (int)z.avail_out;
            int total = overlap + produced;
            found |= ScanPdfKeys(Str((char*)output, total), want & ~found);
            if (found == want) {
                done = true;
                break;
            }
            overlap = total < 32 ? total : 32;
            memmove(output, output + total - overlap, overlap);
            done = status == Z_STREAM_END;
        }
    }
    if (!done) {
        found = want;
    }
    inflateEnd(&z);
    return found;
}

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
    bool documentJs = false;
    // false when a byte scan found no /OpenAction, /PageLayout or /Direction
    bool catalogKeys = true;
    HANDLE file = INVALID_HANDLE_VALUE;
    Str fileData;
    bool dataBacked = false;
    FPDF_FILEACCESS access{};
    Str password;
    bool runtime = false;
    Vec<PdfiumPage*> pages;
    Vec<PdfPageGeometry> geometry;
    Vec<IPageDestination*> namedDests;
    StrVec pageLabels;
    TocTree* toc = nullptr;
    AtomicInt tocLoaded = 0;
    bool tocFromEditor = false;
    enum class XmpState {
        Unknown,
        Absent,
        Present
    };
    Mutex xmpLock;
    XmpState xmpState = XmpState::Unknown;
    // PDFium can't write most annotation properties, so an EngineMupdf of the file edits them and,
    // once loaded, draws them over PDFium's pages. Saving writes MuPDF's incremental update.
    EngineBase* editor = nullptr;
    bool editorFailed = false;
    Mutex editorLock;
    Mutex fileLock;
    Mutex themeLock;
    PdfRenderProbe* renderProbe = nullptr;
    struct ThemeEntry {
        PdfThemeSnapshot snapshot;
        int pageNo = 0;
        Color foreground = 0;
        Color background = 0;
        Color link = 0;
        u64 used = 0;
    };
    static constexpr int kThemeCacheEntries = 4;
    static constexpr u64 kThemeCacheBytes = 64 * 1024 * 1024;
    ThemeEntry themeEntries[kThemeCacheEntries];
    u64 themeClock = 0;

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
        ScopedMutex lock(&e->fileLock);
        return SetFilePointerEx(e->file, pos, nullptr, FILE_BEGIN) && ReadFile(e->file, data, count, &read, nullptr) &&
               read == count;
    }

    static int ReadThemeSource(void* user, u32 offset, u8* data, u32 count) {
        return ReadBlock(user, offset, data, count);
    }

    PdfRenderSource ReadSource() { return {this, (u32)access.m_FileLen, ReadThemeSource, nullptr, nullptr}; }

    struct ThemeAccess {
        EnginePdfium* engine;
        Str suffix;
        u32 sourceSize;
    };

    static int ReadThemeBlock(void* user, unsigned long offset, unsigned char* data, unsigned long count) {
        auto* access = (ThemeAccess*)user;
        u32 sourceSize = access->sourceSize;
        u64 total = (u64)sourceSize + (u32)len(access->suffix);
        if (offset > total || count > total - offset) {
            return 0;
        }
        if (offset < sourceSize) {
            u32 first = count < sourceSize - offset ? count : sourceSize - offset;
            if (!ReadBlock(access->engine, offset, data, first)) {
                return 0;
            }
            offset += first;
            data += first;
            count -= first;
        }
        if (count) {
            memcpy(data, access->suffix.s + (offset - sourceSize), count);
        }
        return 1;
    }

    static void ClearTheme(ThemeEntry& entry) {
        str::Free(entry.snapshot.data);
        entry = {};
    }

    ThemeEntry* PrepareTheme(int pageNo, const DarkModeProfile& profile, PdfiumCookie* cookie, PdfiumProfile& timing) {
        ThemeEntry* oldest = &themeEntries[0];
        for (auto& entry : themeEntries) {
            if (entry.pageNo == pageNo && entry.foreground == profile.foreground &&
                entry.background == profile.pageBackground && entry.link == profile.linkColor) {
                entry.used = ++themeClock;
                return &entry;
            }
            if (entry.used < oldest->used) {
                oldest = &entry;
            }
        }
        ClearTheme(*oldest);
        PdfRenderSource source{this, (u32)access.m_FileLen, ReadThemeSource, cookie, PdfiumCookie::IsCanceled};
        PdfThemeSnapshot snapshot;
        WCHAR failTheme[2]{};
        bool forceFallback =
            gForTesting && GetEnvironmentVariableW(L"SOLOKPDF_TEST_THEME_FALLBACK", failTheme, dimofi(failTheme));
        if (!forceFallback) {
            snapshot = PdfThemePageMupdf(source, password, pageNo, profile);
        }
        if (PdfiumCookie::IsCanceled(cookie)) {
            str::Free(snapshot.data);
            return nullptr;
        }
        u64 bytes = len(snapshot.data);
        for (auto& entry : themeEntries) {
            bytes += len(entry.snapshot.data);
        }
        while (bytes > kThemeCacheBytes) {
            ThemeEntry* victim = nullptr;
            for (auto& entry : themeEntries) {
                if (&entry != oldest && entry.used && (!victim || entry.used < victim->used)) {
                    victim = &entry;
                }
            }
            if (!victim) {
                break;
            }
            bytes -= len(victim->snapshot.data);
            ClearTheme(*victim);
        }
        oldest->snapshot = snapshot;
        oldest->pageNo = pageNo;
        oldest->foreground = profile.foreground;
        oldest->background = profile.pageBackground;
        oldest->link = profile.linkColor;
        oldest->used = ++themeClock;
        if (timing.enabled) {
            logf("PDFium theme conversion: page=%d\n", pageNo);
        }
        return oldest;
    }

    // PDFium exposes Info but not Catalog XMP; scan only when a property is missing.
    bool HasXmp() {
        ScopedMutex lock(&xmpLock);
        if (xmpState != XmpState::Unknown) {
            return xmpState == XmpState::Present;
        }
        constexpr Str marker = StrL("/Metadata");
        if (fileData.s) {
            xmpState = str::Contains(fileData, marker) ? XmpState::Present : XmpState::Absent;
            return xmpState == XmpState::Present;
        }

        constexpr unsigned long kScanSize = 64 * 1024;
        u8 data[kScanSize];
        unsigned long overlap = len(marker) - 1;
        for (unsigned long offset = 0; offset < access.m_FileLen;) {
            unsigned long count = std::min(kScanSize, access.m_FileLen - offset);
            if (!ReadBlock(this, offset, data, count)) {
                break;
            }
            if (str::Contains(Str((char*)data, (int)count), marker)) {
                xmpState = XmpState::Present;
                return true;
            }
            if (count == access.m_FileLen - offset) {
                break;
            }
            offset += count - overlap;
        }
        xmpState = XmpState::Absent;
        return false;
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
            if (len(geometry) == pageCount) {
                FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
                if (!page) {
                    return nullptr;
                }
                int rotation = geometry[pageNo - 1].rotation;
                if (gPdfium.FPDFPage_GetRotation(page) != rotation) {
                    gPdfium.FPDFPage_SetRotation(page, rotation);
                }
                gPdfium.FPDF_ClosePage(page);
                size.width = geometry[pageNo - 1].size.dx;
                size.height = geometry[pageNo - 1].size.dy;
            } else if (!gPdfium.FPDF_GetPageSizeByIndexF(doc, pageNo - 1, &size)) {
                return nullptr;
            }
            if (!isfinite(size.width) || !isfinite(size.height) || size.width <= 0 || size.height <= 0) {
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

    void AddImageElement(FPDF_PAGE page, PdfiumPage* info, FPDF_PAGEOBJECT obj, const FS_MATRIX& parent, int depth) {
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
                AddImageElement(page, info, gPdfium.FPDFFormObj_GetObject(obj, (unsigned long)i), m, depth + 1);
            }
            return;
        }
        if (type != FPDF_PAGEOBJ_IMAGE) {
            return;
        }

        PointF c[4];
        double unit[4][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}};
        for (int i = 0; i < 4; i++) {
            double ux = unit[i][0], uy = unit[i][1];
            c[i] = ToPage(page, info, m.a * ux + m.c * uy + m.e, m.b * ux + m.d * uy + m.f);
        }
        RectF pageBounds(0, 0, info->size.dx, info->size.dy);
        RectF rect = RectF::FromXY(c[0], c[3]).Union(RectF::FromXY(c[1], c[2])).Intersect(pageBounds);
        rect = ClipToPaths(page, info, obj, parent, rect);
        if (rect.IsEmpty()) {
            return;
        }
        auto* element = new PageElementImage();
        element->rect = rect;
        VecAppend(info->imageElements, (IPageElement*)element);
    }

    // Caller holds gPdfiumLock. rect cut to obj's clip paths, as MuPDF clips image elements (#6441).
    // A clip path is in the space of the stream holding obj, which `parent` maps to the page.
    RectF ClipToPaths(FPDF_PAGE page, PdfiumPage* info, FPDF_PAGEOBJECT obj, const FS_MATRIX& parent, RectF rect) {
        FPDF_CLIPPATH clip = gPdfium.FPDFPageObj_GetClipPath(obj);
        int nPaths = clip ? gPdfium.FPDFClipPath_CountPaths(clip) : 0;
        for (int i = 0; i < nPaths && !rect.IsEmpty(); i++) {
            int nSegments = gPdfium.FPDFClipPath_CountPathSegments(clip, i);
            float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
            int nPoints = 0;
            for (int j = 0; j < nSegments; j++) {
                float x = 0, y = 0;
                FPDF_PATHSEGMENT segment = gPdfium.FPDFClipPath_GetPathSegment(clip, i, j);
                if (!segment || !gPdfium.FPDFPathSegment_GetPoint(segment, &x, &y)) {
                    continue;
                }
                PointF p =
                    ToPage(page, info, parent.a * x + parent.c * y + parent.e, parent.b * x + parent.d * y + parent.f);
                x0 = nPoints == 0 ? p.x : std::min(x0, p.x);
                y0 = nPoints == 0 ? p.y : std::min(y0, p.y);
                x1 = nPoints == 0 ? p.x : std::max(x1, p.x);
                y1 = nPoints == 0 ? p.y : std::max(y1, p.y);
                nPoints++;
            }
            if (nPoints > 0) {
                rect = rect.Intersect(RectF(x0, y0, x1 - x0, y1 - y0));
            }
        }
        return rect;
    }

    void CollectImageElements(FPDF_PAGE page, int pageNo, PdfiumPage* info) {
        info->imageElementsLoaded = true;
        FS_MATRIX identity{1, 0, 0, 1, 0, 0};
        int n = gPdfium.FPDFPage_CountObjects(page);
        for (int i = 0; i < n; i++) {
            AddImageElement(page, info, gPdfium.FPDFPage_GetObject(page, i), identity, 0);
        }
        for (IPageElement* element : info->imageElements) {
            element->pageNo = pageNo;
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
        // an image fills the unit square of its matrix
        PointF c[4];
        double unit[4][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}};
        for (int i = 0; i < 4; i++) {
            double ux = unit[i][0], uy = unit[i][1];
            c[i] = ToPage(page, info, m.a * ux + m.c * uy + m.e, m.b * ux + m.d * uy + m.f);
        }
        RectF pageBounds(0, 0, info->size.dx, info->size.dy);
        RectF r = RectF::FromXY(c[0], c[3]).Union(RectF::FromXY(c[1], c[2])).Intersect(pageBounds);
        if (!r.IsEmpty()) {
            VecAppend(info->images, r);
        }
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

    // Distiller's Latin-1 ToUnicode map mislabels CP-1251 Type1 glyphs in these families.
    bool IsCp1251Font(FPDF_PAGEOBJECT obj) {
        FPDF_FONT font = obj ? gPdfium.FPDFTextObj_GetFont(obj) : nullptr;
        char name[128]{};
        if (!font || gPdfium.FPDFFont_GetBaseFontName(font, name, sizeof(name)) >= sizeof(name)) {
            return false;
        }
        const char* family = name;
        if (strlen(family) > 7 && family[6] == '+') {
            family += 7;
        }
        return _strnicmp(family, "Literaturnaya", 13) == 0 ||
               (_strnicmp(family, "Academy", 7) == 0 && (family[7] == 0 || family[7] == '-'));
    }

    // The order to read a text page's chars in. A glyph whose unicode is several chars (a
    // lam-alef ligature) or a letter with its marks share one origin; PDFium reverses a
    // right-to-left run with such a cluster in it, so its chars are put back (#6483, #6485).
    static void RtlClusterOrder(FPDF_TEXTPAGE textPage, int count, Vec<int>& order) {
        for (int i = 0; i < count; i++) {
            VecAppend(order, i);
        }
        int start = 0;
        bool rtl = false;
        double sx = 0, sy = 0;
        for (int i = 0; i <= count; i++) {
            double x = 0, y = 0;
            bool isRtl = i < count && IsRtlCodepoint((int)gPdfium.FPDFText_GetUnicode(textPage, i));
            bool hasOrigin = (isRtl || rtl) && i < count && gPdfium.FPDFText_GetCharOrigin(textPage, i, &x, &y);
            constexpr double kSameOrigin = 0.01;
            if (i > start && rtl && isRtl && hasOrigin && fabs(x - sx) < kSameOrigin && fabs(y - sy) < kSameOrigin) {
                continue;
            }
            for (int a = start, b = i - 1; rtl && a < b; a++, b--) {
                std::swap(order[a], order[b]);
            }
            start = i;
            rtl = isRtl;
            sx = x;
            sy = y;
        }
    }

    PageText ReadPageText(FPDF_PAGE page, PdfiumPage* info, bool* missingUnicode = nullptr,
                          Vec<int>* sourceIndices = nullptr, PdfiumCookie* cookie = nullptr) {
        constexpr UINT kCyrillicCodePage = 1251;
        constexpr double kMinWordGapEm = 0.1;
        constexpr double kMaxWordGapEm = 1.5;
        constexpr float kMaxLooseBoxEm = 3;
        PageText result;
        FPDF_TEXTPAGE textPage = gPdfium.FPDFText_LoadPage(page);
        if (!textPage) {
            result.failed = true;
            return result;
        }
        int count = gPdfium.FPDFText_CountChars(textPage);
        if (count < 0) {
            gPdfium.FPDFText_ClosePage(textPage);
            result.failed = true;
            return result;
        }
        constexpr int kMaxPageChars = 2000000;
        if (count > 0 && count <= kMaxPageChars) {
            str::Builder text;
            Vec<Rect> coords;
            Vec<QuadF> quads;
            bool hasRotated = false;
            FPDF_PAGEOBJECT lastObj = nullptr;
            bool cp1251Font = false;
            unsigned int prevCode = 0;
            double prevRight = 0, prevBottom = 0, prevTop = 0;
            Vec<int> order;
            RtlClusterOrder(textPage, count, order);
            for (int k = 0; k < count; k++) {
                if (cookie && PdfiumCookie::IsCanceled(cookie)) {
                    gPdfium.FPDFText_ClosePage(textPage);
                    return {};
                }
                int i = order[k];
                int next = k + 1 < count ? order[k + 1] : -1;
                unsigned int code = gPdfium.FPDFText_GetUnicode(textPage, i);
                if (code == 2 && gPdfium.FPDFText_IsHyphen(textPage, i) == 1) {
                    continue;
                }
                if (!code && missingUnicode && gPdfium.FPDFText_IsGenerated(textPage, i) == 0) {
                    *missingUnicode = true;
                }
                unsigned int nextCode = next >= 0 ? gPdfium.FPDFText_GetUnicode(textPage, next) : 0;
                if ((code == '\r' && nextCode == '\n') || (code == ' ' && (nextCode == '\r' || nextCode == '\n'))) {
                    continue;
                }
                if (code == ' ' && (prevCode == 0 || prevCode == '\n' || prevCode == '\r')) {
                    continue;
                }
                FPDF_PAGEOBJECT obj = gPdfium.FPDFText_GetTextObject(textPage, i);
                if (obj != lastObj) {
                    cp1251Font = IsCp1251Font(obj);
                    lastObj = obj;
                }
                if (cp1251Font && code >= 0xc0 && code <= 0xff) {
                    char ch = (char)code;
                    WCHAR mapped = 0;
                    if (MultiByteToWideChar(kCyrillicCodePage, 0, &ch, 1, &mapped, 1) == 1) {
                        code = mapped;
                    }
                }
                if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
                    code = 0xfffd;
                }
                double left = 0, right = 0, bottom = 0, top = 0;
                double wordLeft = 0, wordRight = 0;
                bool useLoose = false;
                Rect box;
                if (gPdfium.FPDFText_GetCharBox(textPage, i, &left, &right, &bottom, &top)) {
                    FS_RECTF loose{};
                    float size = (float)gPdfium.FPDFText_GetFontSize(textPage, i);
                    wordLeft = left;
                    wordRight = right;
                    if (gPdfium.FPDFText_GetLooseCharBox(textPage, i, &loose)) {
                        wordLeft = loose.left;
                        wordRight = loose.right;
                        if (size > 0 && loose.top - loose.bottom <= kMaxLooseBoxEm * size) {
                            useLoose = true;
                            left = loose.left;
                            right = loose.right;
                            bottom = loose.bottom;
                            top = loose.top;
                        }
                    }
                    RectF rect = ToPageRect(page, info, left, bottom, right, top);
                    if (isfinite(rect.x) && isfinite(rect.y) && isfinite(rect.dx) && isfinite(rect.dy) &&
                        fabs(rect.x) < INT_MAX / 4 && fabs(rect.y) < INT_MAX / 4 && rect.dx < INT_MAX / 4 &&
                        rect.dy < INT_MAX / 4) {
                        box = rect.Round();
                        if (useLoose) {
                            box.dx = std::max(1, (int)roundf(rect.dx));
                        }
                    }
                }
                if (code == '\n' || code == '\r') {
                    box = Rect();
                }
                bool sameLine = prevTop > bottom && top > prevBottom;
                double gap = wordLeft - prevRight;
                double em = std::max(prevTop - prevBottom, top - bottom);
                // a tracking space is a left-to-right problem: before right-to-left text the
                // next letter is to the left, so every word space would look like one (#6483)
                if (code == ' ' && sameLine && next >= 0 && !IsRtlCodepoint((int)nextCode)) {
                    FS_RECTF nextBox{};
                    if (gPdfium.FPDFText_GetLooseCharBox(textPage, next, &nextBox) &&
                        nextBox.left - prevRight < kMinWordGapEm * em) {
                        continue;
                    }
                }
                if (prevCode > ' ' && code > ' ' && sameLine && gap > kMinWordGapEm * em && gap < kMaxWordGapEm * em) {
                    text.Append(StrL(" "));
                    VecAppend(coords, Rect());
                    VecAppend(quads, QuadF());
                    if (sourceIndices) {
                        VecAppend(*sourceIndices, -1);
                    }
                }
                char buf[8]{};
                int bytes = 0;
                str::Utf8Encode(buf, bytes, (int)code);
                text.Append(Str(buf, bytes));
                VecAppend(coords, box);
                if (sourceIndices) {
                    VecAppend(*sourceIndices, i);
                }

                // rotated glyphs select along their quads (#4839), upright ones use their box
                float x0 = (float)box.x, y0 = (float)box.y, x1 = (float)(box.x + box.dx), y1 = (float)(box.y + box.dy);
                QuadF quad{PointF(x0, y0), PointF(x1, y0), PointF(x0, y1), PointF(x1, y1)};
                if (RotatedGlyphQuad(page, info, textPage, i, code, &quad)) {
                    hasRotated = true;
                }
                VecAppend(quads, quad);
                prevCode = code;
                prevRight = wordRight;
                prevBottom = bottom;
                prevTop = top;
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
    void AddMupdfLinks(int pageNo, PdfiumPage* info, int insertAt = -1) {
        Vec<PdfLinkMupdf> links;
        PdfLinksMupdf(ReadSource(), password, pageNo, links);
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
            IPageDestination* dest = nullptr;
            if (link.uri.s) {
                Str uri = link.uri;
                if (str::TrimPrefix(uri, StrL("file:"))) {
                    for (int i = 0; i < 3; i++) {
                        str::TrimPrefix(uri, StrL("/"));
                    }
                    Str fragment = str::SliceFromChar(uri, '#');
                    if (fragment) {
                        uri = Str(uri.s, (int)(fragment.s - uri.s));
                        fragment = Str(fragment.s + 1);
                    }
                    TempStr file = path::ToOSTemp(url::DecodeTemp(uri));
                    if (len(file) > 0) {
                        dest = new PageDestinationFile(file, url::DecodeTemp(fragment));
                    }
                } else {
                    dest = new PageDestinationURL(uri);
                }
            } else if (Page(link.targetPage)) {
                auto* page = new PdfiumDest();
                page->pageNo = link.targetPage;
                page->rect = link.hasDestRect
                                 ? link.destRect
                                 : RectF(kDestUseDefault, kDestUseDefault, kDestUseDefault, kDestUseDefault);
                page->zoom = link.zoom;
                page->kind = kindDestinationScrollTo;
                dest = page;
            }
            if (dest) {
                auto* element = new PageElementDestination(dest);
                element->pageNo = pageNo;
                element->rect = link.rect;
                if (insertAt >= 0) {
                    VecInsertAt(info->links, insertAt++, (IPageElement*)element);
                } else {
                    VecAppend(info->links, (IPageElement*)element);
                }
            }
            str::Free(link.uri);
        }
    }

    // A link's /QuadPoints are its clickable areas within /Rect, like EngineMupdf's (#6472).
    void AddLinkQuads(FPDF_PAGE page, PdfiumPage* info, FPDF_LINK link, PageElementDestination* element) {
        int n = gPdfium.FPDFLink_CountQuadPoints(link);
        for (int i = 0; i < n; i++) {
            FS_QUADPOINTSF q{};
            if (!gPdfium.FPDFLink_GetQuadPoints(link, i, &q)) {
                VecReset(element->quads);
                return;
            }
            VecAppend(element->quads, QuadF{ToPage(page, info, q.x1, q.y1), ToPage(page, info, q.x2, q.y2),
                                            ToPage(page, info, q.x3, q.y3), ToPage(page, info, q.x4, q.y4)});
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
            AddLinkQuads(page, info, link, element);
            VecAppend(info->links, (IPageElement*)element);
        }
        if (needsMupdf) {
            AddMupdfLinks(pageNo, info);
            info->useMupdfElements = true;
        }
        if (!disableAutoLinks) {
            AddAutoLinks(page, pageNo, info);
        }
        if (!info->imageElementsLoaded) {
            CollectImageElements(page, pageNo, info);
        }
        int annotCount = gPdfium.FPDFPage_GetAnnotCount(page);
        bool widgetLinks = false;
        for (int i = 0; i < annotCount; i++) {
            FPDF_ANNOTATION annot = gPdfium.FPDFPage_GetAnnot(page, i);
            if (!annot) {
                continue;
            }
            auto subtype = gPdfium.FPDFAnnot_GetSubtype(annot);
            bool isAttachment = subtype == FPDF_ANNOT_FILEATTACHMENT;
            if (isAttachment) {
                FS_RECTF r{};
                if (gPdfium.FPDFAnnot_GetRect(annot, &r)) {
                    RectF rect = ToPageRect(page, info, r.left, r.bottom, r.right, r.top);
                    if (!rect.IsEmpty()) {
                        auto* dest = new PageDestination();
                        dest->kind = kindDestinationLaunchEmbedded;
                        dest->pageNo = pageNo;
                        dest->rect = rect;
                        dest->embedObjNum = kUnresolvedAttachment;
                        auto* element = new PageElementDestination(dest);
                        element->pageNo = pageNo;
                        element->rect = rect;
                        VecAppend(info->links, (IPageElement*)element);
                    }
                }
            }
            if (subtype == FPDF_ANNOT_WIDGET) {
                if (WidgetIsLink(annot)) {
                    widgetLinks = true;
                } else {
                    AddWidgetTip(page, pageNo, info, annot);
                }
            } else if (subtype != FPDF_ANNOT_LINK) {
                info->useMupdfElements = true;
                if (!isAttachment && subtype != FPDF_ANNOT_POPUP) {
                    AddAnnotTip(page, pageNo, info, annot, subtype);
                }
            }
            gPdfium.FPDFPage_CloseAnnot(annot);
            if (isAttachment) {
                info->hasFileAttachments = true;
            }
        }
        if (widgetLinks && !needsMupdf) {
            // Hit testing walks backward; keep real /Link annotations above widgets.
            AddMupdfLinks(pageNo, info, 0);
        }
        gPdfium.FPDF_ClosePage(page);
        info->linksLoaded = true;
        profile.Mark(StrL("load-and-scan"));
    }

    // Caller holds gPdfiumLock. MuPDF makes links of push buttons that navigate (issue #1914).
    bool WidgetIsLink(FPDF_ANNOTATION annot) {
        constexpr int kHidden = FPDF_ANNOT_FLAG_HIDDEN | FPDF_ANNOT_FLAG_NOVIEW | FPDF_ANNOT_FLAG_INVISIBLE;
        if (gPdfium.FPDFAnnot_GetFlags(annot) & kHidden) {
            return false;
        }
        int type = form ? gPdfium.FPDFAnnot_GetFormFieldType(form, annot) : -1;
        if (type != FPDF_FORMFIELD_PUSHBUTTON && type != -1) {
            return false;
        }
        int destType = gPdfium.FPDFAnnot_GetValueType(annot, "Dest");
        return destType == FPDF_OBJECT_ARRAY || destType == FPDF_OBJECT_NAME || destType == FPDF_OBJECT_STRING ||
               gPdfium.FPDFAnnot_GetValueType(annot, "A") == FPDF_OBJECT_DICTIONARY ||
               gPdfium.FPDFAnnot_GetValueType(annot, "AA") == FPDF_OBJECT_DICTIONARY;
    }

    // Caller holds gPdfiumLock. A form field's /TU tooltip as a comment, as MuPDF shows it (issue #2083).
    void AddWidgetTip(FPDF_PAGE page, int pageNo, PdfiumPage* info, FPDF_ANNOTATION annot) {
        unsigned long bytes = form ? gPdfium.FPDFAnnot_GetFormFieldAlternateName(form, annot, nullptr, 0) : 0;
        bool fromField = bytes > sizeof(WCHAR);
        if (!fromField) {
            bytes = gPdfium.FPDFAnnot_GetStringValue(annot, "TU", nullptr, 0);
        }
        constexpr unsigned long kMaxTipBytes = 64 * 1024;
        if (bytes <= sizeof(WCHAR) || bytes > kMaxTipBytes || bytes % sizeof(WCHAR) != 0) {
            return;
        }
        WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
        unsigned long got = fromField
                                ? gPdfium.FPDFAnnot_GetFormFieldAlternateName(form, annot, (FPDF_WCHAR*)buf, bytes)
                                : gPdfium.FPDFAnnot_GetStringValue(annot, "TU", (FPDF_WCHAR*)buf, bytes);
        FS_RECTF r{};
        if (got != bytes || !gPdfium.FPDFAnnot_GetRect(annot, &r)) {
            return;
        }
        RectF rect = ToPageRect(page, info, r.left, r.bottom, r.right, r.top);
        if (rect.IsEmpty()) {
            return;
        }
        auto* tip = new PageElementComment(ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1)));
        tip->pageNo = pageNo;
        tip->rect = rect;
        VecAppend(info->links, (IPageElement*)tip);
    }

    TempStr AnnotString(FPDF_ANNOTATION annot, const char* key) {
        unsigned long bytes = gPdfium.FPDFAnnot_GetStringValue(annot, key, nullptr, 0);
        constexpr unsigned long kMaxTipBytes = 64 * 1024;
        if (bytes <= sizeof(WCHAR) || bytes > kMaxTipBytes || bytes % sizeof(WCHAR) != 0) {
            return {};
        }
        WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
        if (gPdfium.FPDFAnnot_GetStringValue(annot, key, (FPDF_WCHAR*)buf, bytes) != bytes) {
            return {};
        }
        return ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1));
    }

    void AddAnnotTip(FPDF_PAGE page, int pageNo, PdfiumPage* info, FPDF_ANNOTATION annot,
                     FPDF_ANNOTATION_SUBTYPE subtype) {
        Str contents =
            subtype == FPDF_ANNOT_FREETEXT ? Str{} : NormalizeCommentNewlinesTemp(AnnotString(annot, "Contents"));
        Str author = AnnotAuthorInTooltip() ? AnnotString(annot, "T") : Str{};
        if (str::IsEmptyOrWhiteSpace(contents)) {
            contents = {};
        }
        if (str::IsEmptyOrWhiteSpace(author)) {
            author = {};
        }
        Str tip = contents;
        if (author) {
            TempStr authorLine = fmt("Author: %s", author);
            tip = contents ? str::JoinTemp(contents, StrL("\n"), authorLine) : authorLine;
        }
        FS_RECTF r{};
        if (len(tip) == 0 || !gPdfium.FPDFAnnot_GetRect(annot, &r)) {
            return;
        }
        RectF rect = ToPageRect(page, info, r.left, r.bottom, r.right, r.top);
        if (rect.IsEmpty()) {
            return;
        }
        auto* element = new PageElementComment(tip);
        element->pageNo = pageNo;
        element->rect = rect;
        VecAppend(info->links, (IPageElement*)element);
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
            item->fontFlags = gPdfium.FPDFBookmark_GetStyle(mark) & 3;
            float red = 0, green = 0, blue = 0;
            if (gPdfium.FPDFBookmark_GetColor(mark, &red, &green, &blue)) {
                u8 r = (u8)(red * 255), g = (u8)(green * 255), b = (u8)(blue * 255);
                if (r || g || b) {
                    item->color = MkRgb(r, g, b);
                }
            }
            item->child = ReadBookmarks(gPdfium.FPDFBookmark_GetFirstChild(doc, mark), item, depth + 1, budget, id);
            *tail = item;
            tail = &item->next;
        }
        return head;
    }

    bool NeedsMupdfToc(FPDF_BOOKMARK first, int depth, int& budget) {
        if (depth > 64) {
            return false;
        }
        for (auto mark = first; mark && budget > 0; mark = gPdfium.FPDFBookmark_GetNextSibling(doc, mark)) {
            budget--;
            FPDF_ACTION action = gPdfium.FPDFBookmark_GetAction(mark);
            unsigned long type = action ? gPdfium.FPDFAction_GetType(action) : PDFACTION_GOTO;
            if (type == PDFACTION_UNSUPPORTED || type == PDFACTION_REMOTEGOTO) {
                return true;
            }
            if (NeedsMupdfToc(gPdfium.FPDFBookmark_GetFirstChild(doc, mark), depth + 1, budget)) {
                return true;
            }
        }
        return false;
    }

  public:
    bool IsDataBacked() const { return dataBacked; }

    // The end and corner points of the page's vector paths, in page coordinates, as
    // EngineMupdfPagePathPoints() reads them: the measuring tool snaps to them.
    bool PagePathPoints(int pageNo, Vec<PointF>& out) {
        VecReset(out);
        ScopedMutex lock(&gPdfiumLock);
        PdfiumPage* info = Page(pageNo);
        FPDF_PAGE page = info ? gPdfium.FPDF_LoadPage(doc, pageNo - 1) : nullptr;
        if (!page) {
            return false;
        }
        FS_MATRIX identity{1, 0, 0, 1, 0, 0};
        int n = gPdfium.FPDFPage_CountObjects(page);
        for (int i = 0; i < n; i++) {
            AddPathPoints(page, info, gPdfium.FPDFPage_GetObject(page, i), identity, 0, out);
        }
        gPdfium.FPDF_ClosePage(page);
        return true;
    }

    // Caller holds gPdfiumLock. A curve adds only its end point: its control points are off it.
    void AddPathPoints(FPDF_PAGE page, PdfiumPage* info, FPDF_PAGEOBJECT obj, const FS_MATRIX& parent, int depth,
                       Vec<PointF>& out) {
        constexpr int kMaxFormDepth = 16;
        // a CAD page can have millions; as in EngineMupdf, the rest are ignored
        constexpr int kMaxPathPoints = 500000;
        FS_MATRIX m{};
        if (!obj || !gPdfium.FPDFPageObj_GetMatrix(obj, &m)) {
            return;
        }
        m = ConcatMatrix(m, parent);
        int type = gPdfium.FPDFPageObj_GetType(obj);
        if (type == FPDF_PAGEOBJ_FORM && depth < kMaxFormDepth) {
            int n = gPdfium.FPDFFormObj_CountObjects(obj);
            for (int i = 0; i < n; i++) {
                AddPathPoints(page, info, gPdfium.FPDFFormObj_GetObject(obj, (unsigned long)i), m, depth + 1, out);
            }
            return;
        }
        if (type != FPDF_PAGEOBJ_PATH) {
            return;
        }
        int n = gPdfium.FPDFPath_CountSegments(obj);
        // a curve is three BEZIERTO segments: two control points, then its end
        int bezierPos = 0;
        for (int i = 0; i < n && len(out) < kMaxPathPoints; i++) {
            FPDF_PATHSEGMENT segment = gPdfium.FPDFPath_GetPathSegment(obj, i);
            float x = 0, y = 0;
            if (!segment || !gPdfium.FPDFPathSegment_GetPoint(segment, &x, &y)) {
                continue;
            }
            if (gPdfium.FPDFPathSegment_GetType(segment) == FPDF_SEGMENT_BEZIERTO) {
                bezierPos = (bezierPos + 1) % 3;
                if (bezierPos != 0) {
                    continue;
                }
            } else {
                bezierPos = 0;
            }
            VecAppend(out, ToPage(page, info, m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f));
        }
    }

    EnginePdfium() {
        kind = kindEnginePdfium;
        defaultExt = str::Dup(StrL(".pdf"));
        fileDPI = 72;
    }

    ~EnginePdfium() override {
        PdfiumProfile profile(StrL("close"));
        profile.Mark(StrL("start"));
        ScopedMutex lock(&gPdfiumLock);
        if (!tocFromEditor) {
            DestroyTocTree(toc);
        }
        for (auto* p : pages) {
            if (!p) {
                continue;
            }
            for (auto* link : p->links) {
                delete link;
            }
            for (auto* image : p->imageElements) {
                delete image;
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
        DeletePdfRenderProbe(renderProbe);
        if (file != INVALID_HANDLE_VALUE) {
            CloseHandle(file);
        }
        str::Free(fileData);
        str::Free(password);
        for (auto& entry : themeEntries) {
            ClearTheme(entry);
        }
        if (runtime) {
            gPdfium.Release();
        }
        profile.Mark(StrL("runtime"));
        if (editor) {
            editor->Release();
        }
    }

    // Caller holds gPdfiumLock; it's released while pwdUI asks, as a dialog may run a message loop.
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
                if (saveKey && !dataBacked) {
                    decryptionKey = str::Dup(arena, PdfDecryptionKeyMupdfTemp(FilePath(), fileData, pwd));
                    protectedPassword = str::Dup(arena, ProtectPdfPasswordTemp(pwd, digest));
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

    bool Load(Str path, Str data, PasswordUI* pwdUI, TempStr* error, PdfiumFailure* failure,
              EnginePdfium* source = nullptr) {
        PdfiumProfile profile(StrL("load"));
        profile.Mark(StrL("start"));
        SetFilePath(path);

        dataBacked = source ? source->dataBacked : len(data) > 0;
        if (source) {
            data = source->fileData;
        }
        if (data.s) {
            fileData = str::Dup(data);
            if (!fileData.s) {
                *error = StrL("PDFium memory allocation failed.");
                return false;
            }
            access.m_FileLen = (unsigned long)len(fileData);
        } else {
            // Share writes so producers can overwrite a file kept open; it then reloads.
            DWORD share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
            file = source ? ReOpenFile(source->file, GENERIC_READ, share, FILE_FLAG_RANDOM_ACCESS)
                          : CreateFileW(CWStrTemp(ToWStrTemp(path)), GENERIC_READ, share, nullptr, OPEN_EXISTING,
                                        FILE_ATTRIBUTE_NORMAL, nullptr);
            LARGE_INTEGER size{};
            if (file == INVALID_HANDLE_VALUE || !GetFileSizeEx(file, &size) || size.QuadPart <= 0 ||
                size.QuadPart > MAXDWORD) {
                *error = StrL("PDFium file open failed (this backend currently supports files smaller than 4 GiB).");
                return false;
            }
            access.m_FileLen = (unsigned long)size.QuadPart;
            if (!source && size.QuadPart < kMaxMemoryFileSize && !ReadIntoMemory()) {
                *error = StrL("PDFium file read failed.");
                return false;
            }
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
        int revision = gPdfium.FPDF_GetSecurityHandlerRevision(doc);
        // One byte scan gates the MuPDF geometry and catalog queries.
        if (fileData.s && len(fileData) < kMaxMemoryFileSize) {
            int want = isPasswordProtected ? kCatalogKeys : kGeometryKeys | kCatalogKeys;
            int keys = ScanPdfKeys(fileData, want, revision >= 0 ? nullptr : &access);
            catalogKeys = (keys & kCatalogKeys) != 0;
            if ((keys & kGeometryKeys) && !PdfPageGeometryMupdf(path, fileData, password, pageCount, geometry)) {
                VecClear(geometry);
            }
        }
        isPasswordProtected = revision >= 0;
        unsigned long permissions = gPdfium.FPDF_GetDocPermissions(doc);
        unsigned long userPermissions = gPdfium.FPDF_GetDocUserPermissions(doc);
        constexpr unsigned long kPrint = 1UL << 2;
        constexpr unsigned long kCopy = 1UL << 4;
        constexpr unsigned long kAnnotate = 1UL << 5;
        constexpr unsigned long kForm = 1UL << 8;
        allowsPrinting = (permissions & kPrint) != 0;
        allowsCopyingText = (permissions & kCopy) != 0;
        allowsAnnotations = (permissions & kAnnotate) != 0;
        allowsFormFilling = (permissions & kForm) != 0;
        if (isPasswordProtected) {
            logf("PDFium security R%d: effective=0x%lx user=0x%lx\n", revision, permissions, userPermissions);
        }
        int formType = gPdfium.FPDF_GetFormType(doc);
        acroForm = formType == FORMTYPE_ACRO_FORM;
        documentJs = gPdfium.FPDFDoc_GetJavaScriptActionCount(doc) > 0;
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

    bool HasSignedSigsLocked() {
        int count = gPdfium.FPDF_GetSignatureCount(doc);
        for (int i = 0; i < count; i++) {
            FPDF_SIGNATURE sig = gPdfium.FPDF_GetSignatureObject(doc, i);
            if (sig && gPdfium.FPDFSignatureObj_GetContents(sig, nullptr, 0) > 0) {
                return true;
            }
        }
        return false;
    }

    bool HasSignatures() override {
        ScopedMutex lock(&gPdfiumLock);
        return HasSignedSigsLocked();
    }

    bool HasPageAnnotations(int pageNo) override {
        ScopedMutex lock(&gPdfiumLock);
        return HasAnnotsLocked(pageNo);
    }

    // Caller holds gPdfiumLock.
    bool HasAnnotsLocked(int pageNo) {
        PdfiumPage* info = Page(pageNo);
        if (!info) {
            return true;
        }
        if (info->annotationsChecked) {
            return info->hasAnnotations;
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return true;
        }
        int count = gPdfium.FPDFPage_GetAnnotCount(page);
        for (int i = 0; i < count; i++) {
            FPDF_ANNOTATION annot = gPdfium.FPDFPage_GetAnnot(page, i);
            if (!annot) {
                info->hasAnnotations = true;
                break;
            }
            FPDF_ANNOTATION_SUBTYPE subtype = gPdfium.FPDFAnnot_GetSubtype(annot);
            gPdfium.FPDFPage_CloseAnnot(annot);
            if (subtype != FPDF_ANNOT_LINK && subtype != FPDF_ANNOT_WIDGET) {
                info->hasAnnotations = true;
                break;
            }
        }
        gPdfium.FPDF_ClosePage(page);
        info->annotationsChecked = true;
        return info->hasAnnotations;
    }

    // Hover skips a page while its render owns PDFium's global lock (not recursive).
    bool TryHasPageAnnotations(int pageNo) override {
        if (!gPdfiumLock.TryLock()) {
            return false;
        }
        bool res = HasAnnotsLocked(pageNo);
        gPdfiumLock.Unlock();
        return res;
    }

    // Empty fillable fields by EngineMupdfGetFormFieldHighlightRects' rules, read with PDFium's form
    // API. Once the editor is loaded it holds the edited values, so it answers instead.
    PageReadResult TryFormHighlightRects(int pageNo, Vec<RectF>& out) override {
        if (AnnotationEditor(EditorLoad::IfLoaded)) {
            return PageReadResult::UseEditor;
        }
        if (!gPdfiumLock.TryLock()) {
            return PageReadResult::Pending;
        }
        defer {
            gPdfiumLock.Unlock();
        };
        PdfiumPage* info = Page(pageNo);
        if (!form || !info) {
            return PageReadResult::Ready;
        }
        if (!info->formRectsLoaded && !LoadFormRects(pageNo, info)) {
            return PageReadResult::UseEditor;
        }
        for (RectF& r : info->formRects) {
            VecAppend(out, r);
        }
        return PageReadResult::Ready;
    }

    // Caller holds gPdfiumLock. False when a signature's state needs MuPDF.
    bool LoadFormRects(int pageNo, PdfiumPage* info) {
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return false;
        }
        VecClear(info->formRects);
        bool ok = true;
        int count = gPdfium.FPDFPage_GetAnnotCount(page);
        for (int i = 0; i < count && ok; i++) {
            FPDF_ANNOTATION annot = gPdfium.FPDFPage_GetAnnot(page, i);
            if (!annot) {
                continue;
            }
            int highlight = FormFieldHighlight(annot);
            if (highlight < 0) {
                ok = false;
            }
            FS_RECTF r{};
            if (highlight > 0 && gPdfium.FPDFAnnot_GetRect(annot, &r)) {
                RectF rect = ToPageRect(page, info, r.left, r.bottom, r.right, r.top);
                if (!rect.IsEmpty()) {
                    VecAppend(info->formRects, rect);
                }
            }
            gPdfium.FPDFPage_CloseAnnot(annot);
        }
        gPdfium.FPDF_ClosePage(page);
        if (!ok) {
            VecClear(info->formRects);
            return false;
        }
        info->formRectsLoaded = true;
        return true;
    }

    // Caller holds gPdfiumLock. 1: empty fillable field, 0: not, -1: unknown signature state.
    int FormFieldHighlight(FPDF_ANNOTATION annot) {
        constexpr int kHidden = FPDF_ANNOT_FLAG_HIDDEN | FPDF_ANNOT_FLAG_NOVIEW | FPDF_ANNOT_FLAG_INVISIBLE;
        if (gPdfium.FPDFAnnot_GetSubtype(annot) != FPDF_ANNOT_WIDGET || (gPdfium.FPDFAnnot_GetFlags(annot) & kHidden)) {
            return 0;
        }
        if (gPdfium.FPDFAnnot_GetFormFieldFlags(form, annot) & FPDF_FORMFLAG_READONLY) {
            return 0;
        }
        int type = gPdfium.FPDFAnnot_GetFormFieldType(form, annot);
        if (type == FPDF_FORMFIELD_SIGNATURE) {
            // PDFium has no signed-state query; /V is the signature dictionary, maybe on a parent field
            if (gPdfium.FPDFAnnot_HasKey(annot, "V")) {
                return gPdfium.FPDFAnnot_GetValueType(annot, "V") == FPDF_OBJECT_DICTIONARY ? 0 : 1;
            }
            if (!gPdfium.FPDFAnnot_HasKey(annot, "Parent") || !HasSignedSigsLocked()) {
                return 1;
            }
            return -1;
        }
        bool button = type == FPDF_FORMFIELD_CHECKBOX || type == FPDF_FORMFIELD_RADIOBUTTON;
        bool fillable = button || type == FPDF_FORMFIELD_TEXTFIELD || type == FPDF_FORMFIELD_COMBOBOX ||
                        type == FPDF_FORMFIELD_LISTBOX;
        if (!fillable) {
            return 0;
        }
        unsigned long bytes = gPdfium.FPDFAnnot_GetFormFieldValue(form, annot, nullptr, 0);
        if (bytes <= sizeof(FPDF_WCHAR)) {
            return 1;
        }
        WCHAR* value = AllocArrayTemp<WCHAR>(bytes / sizeof(WCHAR) + 1);
        gPdfium.FPDFAnnot_GetFormFieldValue(form, annot, (FPDF_WCHAR*)value, bytes);
        TempStr v = ToUtf8Temp(WStr(value));
        bool empty = button ? str::Eq(v, StrL("Off")) : str::IsEmptyOrWhiteSpace(v);
        return empty ? 1 : 0;
    }

    // Form field under pos by EngineMupdfGetWidgetAtPos' rules (the smallest widget containing it)
    // with GetWidgetCursorKind's cursor, read with PDFium so hover and clicks off fields don't load
    // the editor. Once it is loaded it answers instead.
    bool FormWidgetAt(int pageNo, PointF pos, bool& found, WidgetCursorKind& cursor) override {
        if (AnnotationEditor(EditorLoad::IfLoaded)) {
            return false;
        }
        ScopedMutex lock(&gPdfiumLock);
        return FormWidgetLocked(pageNo, pos, found, cursor);
    }

    // Caller holds gPdfiumLock.
    bool FormWidgetLocked(int pageNo, PointF pos, bool& found, WidgetCursorKind& cursor) {
        found = false;
        cursor = WidgetCursorKind::None;
        PdfiumPage* info = Page(pageNo);
        if (!form || !info) {
            return true;
        }
        if (!info->widgetsLoaded) {
            LoadWidgets(pageNo, info);
        }
        PdfiumWidget* best = nullptr;
        float bestArea = 0;
        for (PdfiumWidget& w : info->widgets) {
            if (!w.rect.Contains(pos)) {
                continue;
            }
            float area = w.rect.dx * w.rect.dy;
            if (!best || area < bestArea) {
                best = &w;
                bestArea = area;
            }
        }
        if (best) {
            found = true;
            cursor = best->cursor;
        }
        return true;
    }

    // Hover skips a page while its render owns the lock.
    PageReadResult TryFormWidgetAt(int pageNo, PointF pos, bool& found, WidgetCursorKind& cursor) override {
        found = false;
        cursor = WidgetCursorKind::None;
        if (AnnotationEditor(EditorLoad::IfLoaded)) {
            return PageReadResult::UseEditor;
        }
        if (!gPdfiumLock.TryLock()) {
            return PageReadResult::Pending;
        }
        FormWidgetLocked(pageNo, pos, found, cursor);
        gPdfiumLock.Unlock();
        return PageReadResult::Ready;
    }

    // Caller holds gPdfiumLock. Every widget, hidden ones too, as MuPDF lists them.
    void LoadWidgets(int pageNo, PdfiumPage* info) {
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return;
        }
        VecClear(info->widgets);
        int count = gPdfium.FPDFPage_GetAnnotCount(page);
        for (int i = 0; i < count; i++) {
            FPDF_ANNOTATION annot = gPdfium.FPDFPage_GetAnnot(page, i);
            if (!annot) {
                continue;
            }
            FS_RECTF r{};
            if (gPdfium.FPDFAnnot_GetSubtype(annot) == FPDF_ANNOT_WIDGET && gPdfium.FPDFAnnot_GetRect(annot, &r)) {
                PdfiumWidget w;
                w.rect = ToPageRect(page, info, r.left, r.bottom, r.right, r.top);
                w.cursor = FormFieldCursor(annot);
                VecAppend(info->widgets, w);
            }
            gPdfium.FPDFPage_CloseAnnot(annot);
        }
        gPdfium.FPDF_ClosePage(page);
        info->widgetsLoaded = true;
    }

    // Caller holds gPdfiumLock. I-beam over text and choice fields, hand over check boxes and radio buttons.
    WidgetCursorKind FormFieldCursor(FPDF_ANNOTATION annot) {
        if (gPdfium.FPDFAnnot_GetFormFieldFlags(form, annot) & FPDF_FORMFLAG_READONLY) {
            return WidgetCursorKind::None;
        }
        switch (gPdfium.FPDFAnnot_GetFormFieldType(form, annot)) {
            case FPDF_FORMFIELD_TEXTFIELD:
            case FPDF_FORMFIELD_COMBOBOX:
            case FPDF_FORMFIELD_LISTBOX:
                return WidgetCursorKind::Text;
            case FPDF_FORMFIELD_CHECKBOX:
            case FPDF_FORMFIELD_RADIOBUTTON:
                return WidgetCursorKind::Button;
            default:
                return WidgetCursorKind::None;
        }
    }

    // Run document scripts before rendering so their widget values appear on the first page.
    void LoadDocumentJs() {
        if (documentJs && MupdfJavaScriptEnabled()) {
            AnnotationEditor(EditorLoad::Load);
        }
    }

    // Use the displayed document's bytes or file object, even after its path changes.
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
        WCHAR failEditor[2]{};
        bool forceFailure =
            gForTesting && GetEnvironmentVariableW(L"SOLOKPDF_TEST_EDITOR_FAILURE", failEditor, dimofi(failEditor));
        if (!forceFailure) {
            res = fileData.s
                      ? CreateEngineMupdfFromData(fileData, StrL("file.pdf"), &pwdUI, dataBacked ? Str{} : FilePath())
                      : CreateEngineMupdfFromHandle(file, FilePath(), &pwdUI);
        }
        profile.Mark(StrL("loaded"));
        if (!res) {
            logf("EnginePdfium: MuPDF can't open '%s' to edit annotations\n", FilePath());
            editorFailed = true;
            return nullptr;
        }
        // it draws pages an applied redaction rewrote; SetHideAnnotations keeps this in step
        res->hideAnnotations = hideAnnotations;
        InterlockedExchangePointer((void* volatile*)&editor, res);
        return res;
    }

    EngineBase* HeadingTocEngine(EditorLoad load) override {
        if (load == EditorLoad::IfLoaded && !AnnotationEditor(load)) {
            return nullptr;
        }
        {
            ScopedMutex lock(&gPdfiumLock);
            if (gPdfium.FPDFBookmark_GetFirstChild(doc, nullptr)) {
                return nullptr;
            }
        }
        return AnnotationEditor(load);
    }

    EngineBase* Clone() override {
        // the file still has what a redaction applied in the editor removed
        if (EngineBase* redacted = EngineMupdfRedactedEngine(this)) {
            return redacted;
        }
        TempStr error;
        PasswordCloner pwdUI(password);
        auto* clone = new EnginePdfium();
        PdfiumFailure failure = PdfiumFailure::Fallback;
        if (!clone->Load(FilePath(), {}, &pwdUI, &error, &failure, this)) {
            clone->Release();
            return nullptr;
        }
        clone->LoadDocumentJs();
        clone->disableAutoLinks = disableAutoLinks;
        return clone;
    }

    int GetOpenActionPageNo() override {
        if (!catalogKeys) {
            return 0;
        }
        logf("PDFium: catalog query\n");
        PdfiumProfile profile(StrL("openaction"));
        int pageNo = PdfOpenActionPageMupdf(ReadSource(), password, &preferredLayout);
        profile.Mark(StrL("read"));
        return pageNo;
    }

    bool GetViewerPrintPrefs(PdfViewerPrintPrefs& prefs) override {
        return PdfViewerPrintPrefsMupdf(ReadSource(), password, prefs);
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

    RectF PageContentBox(int pageNo, RenderTarget) override {
        ScopedMutex lock(&gPdfiumLock);
        auto* info = Page(pageNo);
        if (!info) {
            return {};
        }
        RectF media(0, 0, info->size.dx, info->size.dy);
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            return media;
        }
        RectF content;
        bool found = false;
        int count = gPdfium.FPDFPage_CountObjects(page);
        for (int i = 0; i < count; i++) {
            FPDF_PAGEOBJECT obj = gPdfium.FPDFPage_GetObject(page, i);
            float left = 0, bottom = 0, right = 0, top = 0;
            if (!obj || !gPdfium.FPDFPageObj_GetBounds(obj, &left, &bottom, &right, &top)) {
                continue;
            }
            RectF box = ToPageRect(page, info, left, bottom, right, top).Intersect(media);
            if (box.IsEmpty() || !isfinite(box.x) || !isfinite(box.y) || !isfinite(box.dx) || !isfinite(box.dy)) {
                continue;
            }
            content = found ? content.Union(box) : box;
            found = true;
        }
        gPdfium.FPDF_ClosePage(page);
        return found ? content : media;
    }

    void GetPdfPageBoxes(int pageNo, Vec<PdfPageBox>& out) override {
        VecReset(out);
        bool hasMedia = false;
        bool missingNamedBox = false;
        {
            ScopedMutex lock(&gPdfiumLock);
            auto* info = Page(pageNo);
            if (!info) {
                return;
            }
            FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
            if (!page) {
                return;
            }
            struct BoxSpec {
                PdfPageBoxKind kind;
                Str name;
                decltype(gPdfium.FPDFPage_GetMediaBox) get;
            };
            const BoxSpec specs[] = {
                {PdfPageBoxKind::Media, StrL("/MediaBox"), gPdfium.FPDFPage_GetMediaBox},
                {PdfPageBoxKind::Crop, StrL("/CropBox"), gPdfium.FPDFPage_GetCropBox},
                {PdfPageBoxKind::Bleed, StrL("/BleedBox"), gPdfium.FPDFPage_GetBleedBox},
                {PdfPageBoxKind::Trim, StrL("/TrimBox"), gPdfium.FPDFPage_GetTrimBox},
                {PdfPageBoxKind::Art, StrL("/ArtBox"), gPdfium.FPDFPage_GetArtBox},
            };
            for (const BoxSpec& spec : specs) {
                float left = 0, bottom = 0, right = 0, top = 0;
                if (!spec.get(page, &left, &bottom, &right, &top)) {
                    missingNamedBox = missingNamedBox || (fileData.s && str::Contains(fileData, spec.name));
                    continue;
                }
                hasMedia = hasMedia || spec.kind == PdfPageBoxKind::Media;
                RectF rect = ToPageRect(page, info, left, bottom, right, top);
                if (!rect.IsEmpty()) {
                    VecAppend(out, PdfPageBox{spec.kind, rect});
                }
            }
            gPdfium.FPDF_ClosePage(page);
        }
        if (!hasMedia || missingNamedBox) {
            // PDFium only reads box entries on the page; MuPDF resolves inherited boxes.
            EngineBase* source = AnnotationEditor(EditorLoad::Load);
            if (source) {
                source->GetPdfPageBoxes(pageNo, out);
            }
        }
    }

    PdfRenderRoute PrepareRenderRoute(int pageNo, PdfiumCookie* cookie, PdfiumProfile& profile) {
        PdfiumPage* info = nullptr;
        {
            ScopedMutex lock(&gPdfiumLock);
            info = Page(pageNo);
            if (!info) {
                return PdfRenderRoute::Failed;
            }
            if (info->renderRoute != PdfRenderRoute::Unchecked) {
                return info->renderRoute;
            }
        }
        if (PdfiumCookie::IsCanceled(cookie)) {
            return PdfRenderRoute::Unchecked;
        }
        PdfRenderSource source{this, (u32)access.m_FileLen, ReadThemeSource, cookie, PdfiumCookie::IsCanceled};
        if (!renderProbe) {
            renderProbe = NewPdfRenderProbe(source, password);
            if (renderProbe && profile.enabled) {
                logf("PDFium render probe: opened\n");
            }
        }
        PdfRenderCheck check = PdfPageRenderRouteMupdf(renderProbe, source, pageNo);
        if (PdfiumCookie::IsCanceled(cookie)) {
            if (renderProbe && profile.enabled) {
                logf("PDFium render probe: canceled\n");
            }
            DeletePdfRenderProbe(renderProbe);
            renderProbe = nullptr;
            return PdfRenderRoute::Unchecked;
        }
        info->renderRoute = check.route;
        if (profile.enabled) {
            Str backend = check.route == PdfRenderRoute::Mupdf ? StrL("mupdf") : StrL("pdfium");
            logf("PDFium render check: page=%d probe=%d backend=%s\n", pageNo, (int)check.scannedContents, backend);
        }
        return check.route;
    }

    // Borrows BGRA pixels; PDFium leaves straight alpha. Post-processing stays outside the locks.
    PageDrawResult DrawPage(RenderPageArgs& args, Pixmap* pixmap, double x, double y, RectF full, PdfRenderParts parts,
                            PdfiumCookie* cookie, PdfiumProfile& profile) {
        ScopedMutex themeScope(&themeLock);

        PdfRenderRoute route = PrepareRenderRoute(args.pageNo, cookie, profile);
        if (PdfiumCookie::IsCanceled(cookie)) {
            return {DrawStatus::Canceled};
        }
        if (route == PdfRenderRoute::Mupdf) {
            return {DrawStatus::NeedsMupdf};
        }

        ThemeEntry* theme = nullptr;
        if (KeepsImageColors(args)) {
            theme = PrepareTheme(args.pageNo, *args.darkProfile, cookie, profile);
        }
        if (PdfiumCookie::IsCanceled(cookie)) {
            return {DrawStatus::Canceled};
        }
        if (theme && theme->snapshot.status == PdfThemeStatus::Failed) {
            return {DrawStatus::NeedsMupdf};
        }
        u32 sourceSize = theme && theme->snapshot.layout == PdfThemeLayout::Incremental ? (u32)access.m_FileLen : 0;
        ThemeAccess themedAccess{this, theme ? theme->snapshot.data : Str{}, sourceSize};
        ScopedMutex lock(&gPdfiumLock);
        profile.Mark(StrL("lock"));
        if (AtomicIntGet(&cookie->aborted)) {
            return {DrawStatus::Canceled};
        }
        bool drawAnnots = parts == PdfRenderParts::ContentsAndAnnotations;
        FPDF_FILEACCESS themedFile{};
        struct ThemeDocument {
            FPDF_DOCUMENT doc = nullptr;
            FPDF_FORMHANDLE form = nullptr;
            ~ThemeDocument() {
                if (form) {
                    gPdfium.FPDFDOC_ExitFormFillEnvironment(form);
                }
                if (doc) {
                    gPdfium.FPDF_CloseDocument(doc);
                }
            }
        } themed;
        FPDF_DOCUMENT drawDoc = doc;
        FPDF_FORMHANDLE drawForm = form;
        if (theme && theme->snapshot.data.s) {
            themedFile.m_FileLen = sourceSize + (u32)len(theme->snapshot.data);
            themedFile.m_GetBlock = ReadThemeBlock;
            themedFile.m_Param = &themedAccess;
            themed.doc = gPdfium.FPDF_LoadCustomDocument(&themedFile, CStrTemp(password));
            if (themed.doc && form && drawAnnots) {
                themed.form = gPdfium.FPDFDOC_InitFormFillEnvironment(themed.doc, &formInfo);
            }
            if (!themed.doc || (form && drawAnnots && !themed.form)) {
                return {DrawStatus::NeedsMupdf};
            }
            if (themed.doc) {
                drawDoc = themed.doc;
                drawForm = themed.form;
            }
        }

        FPDF_PAGE page = gPdfium.FPDF_LoadPage(drawDoc, args.pageNo - 1);
        if (!page) {
            return {themed.doc ? DrawStatus::NeedsMupdf : DrawStatus::Failed};
        }
        profile.Mark(StrL("page"));
        if (PdfiumCookie::IsCanceled(cookie)) {
            gPdfium.FPDF_ClosePage(page);
            profile.Mark(StrL("canceled-page"));
            return {DrawStatus::Canceled};
        }
        // the form module keeps a view per loaded page; it must drop it before the page closes
        if (drawForm) {
            gPdfium.FORM_OnAfterLoadPage(page, drawForm);
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
            if (drawForm && drawAnnots && !hideAnnotations && status == FPDF_RENDER_DONE &&
                !AtomicIntGet(&cookie->aborted)) {
                gPdfium.FPDF_FFLDraw(drawForm, bmp, page, -(int)x, -(int)y, dx, dy, rotation, flags);
                profile.Mark(StrL("widgets"));
            }
            gPdfium.FPDF_RenderPage_Close(page);
            gPdfium.FPDFBitmap_Destroy(bmp);
        }
        if (drawForm) {
            gPdfium.FORM_OnBeforeClosePage(page, drawForm);
        }
        gPdfium.FPDF_ClosePage(page);
        profile.Mark(StrL("bitmap"));
        if (PdfiumCookie::IsCanceled(cookie)) {
            return {DrawStatus::Canceled};
        }
        if (status != FPDF_RENDER_DONE) {
            return {DrawStatus::Failed};
        }
        pixmap->premultiplied = false;
        return {DrawStatus::Done, theme ? RenderPageColor::Themed : RenderPageColor::Original};
    }

    PageDrawResult DrawMupdf(RenderPageArgs& args, Pixmap* pixmap, double x, double y, RectF full, PdfRenderParts parts,
                             PdfiumCookie* cookie, PdfiumProfile& profile) {
        if (PdfiumCookie::IsCanceled(cookie)) {
            return {DrawStatus::Canceled};
        }
        float m[6];
        TileMatrix(args.pageNo, args.zoom, args.rotation, x, y, full, m);
        PdfRenderSource source{this, (u32)access.m_FileLen, ReadThemeSource, cookie, PdfiumCookie::IsCanceled};
        PdfRenderAntialias antialias = disableAntiAlias ? PdfRenderAntialias::Disabled : PdfRenderAntialias::Enabled;
        profile.Mark(StrL("mupdf-start"));
        bool drawn =
            PdfRenderMupdf(source, password, args.pageNo, m, pixmap, args.darkProfile, parts, args.target, antialias);
        if (PdfiumCookie::IsCanceled(cookie)) {
            return {DrawStatus::Canceled};
        }
        if (!drawn) {
            return {DrawStatus::Failed};
        }
        return {DrawStatus::Done, KeepsImageColors(args) ? RenderPageColor::Themed : RenderPageColor::Original};
    }

    // The editor, when an applied redaction rewrote pageNo: PDFium still has the file's content.
    EngineBase* RedactedEditor(int pageNo) {
        EngineBase* res = AnnotationEditor(EditorLoad::IfLoaded);
        return res && EngineMupdfPageRedacted(res, pageNo) ? res : nullptr;
    }

    Pixmap* RenderPage(RenderPageArgs& args) override {
        if (EngineBase* redacted = RedactedEditor(args.pageNo)) {
            return redacted->RenderPage(args);
        }
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
        pixmap->hasAlpha = args.transparentBackdrop;
        profile.Mark(StrL("setup"));

        // white or transparent backdrop, filled without the lock
        memset(pixmap->data, args.transparentBackdrop ? 0 : 0xff, (size_t)pixmap->stride * pixmap->height);
        if (!args.transparentBackdrop && KeepsImageColors(args)) {
            Color bg = args.darkProfile->pageBackground;
            for (int row = 0; row < pixmap->height; row++) {
                u8* pixel = pixmap->data + (size_t)row * pixmap->stride;
                for (int col = 0; col < pixmap->width; col++, pixel += 4) {
                    pixel[0] = GetBlue(bg);
                    pixel[1] = GetGreen(bg);
                    pixel[2] = GetRed(bg);
                }
            }
        }
        profile.Mark(StrL("fill"));

        // read once: a tile must not get annotations from both engines
        EngineBase* annotEditor = AnnotationEditor(EditorLoad::IfLoaded);
        PdfRenderParts parts =
            !hideAnnotations && !annotEditor ? PdfRenderParts::ContentsAndAnnotations : PdfRenderParts::Contents;
        PageDrawResult result = DrawPage(args, pixmap, x, y, full, parts, cookie, profile);
        if (result.status == DrawStatus::NeedsMupdf) {
            result = DrawMupdf(args, pixmap, x, y, full, parts, cookie, profile);
        }
        if (result.status != DrawStatus::Done || PdfiumCookie::IsCanceled(cookie)) {
            profile.Mark(StrL("canceled-or-failed"));
            FreePixmap(pixmap);
            return nullptr;
        }
        if (pixmap->hasAlpha && !pixmap->premultiplied) {
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
            pixmap->premultiplied = true;
        }
        pixmap->xres = pixmap->yres = args.zoom * fileDPI;
        profile.Mark(StrL("alpha"));
        if (annotEditor && !hideAnnotations) {
            float m[6];
            TileMatrix(args.pageNo, args.zoom, args.rotation, x, y, full, m);
            bool drawn = EngineMupdfDrawAnnotations(annotEditor, args.pageNo, m, pixmap, args.target, args.darkProfile);
            profile.Mark(StrL("annotations"));
            if (!drawn) {
                FreePixmap(pixmap);
                return nullptr;
            }
        }
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
        if (PdfiumCookie::IsCanceled(cookie)) {
            FreePixmap(pixmap);
            profile.Mark(StrL("canceled-output"));
            return nullptr;
        }
        if (profile.enabled) {
            u64 pixels = (u64)pixmap->stride * pixmap->height;
            u64 storage = pixmap->hbmp ? pixels : (u64)_msize(pixmap->data);
            logf("PDFium output: thread=%lu pixels=%llu storage=%llu format=%d\n", GetCurrentThreadId(), pixels,
                 storage, (int)pixmap->format);
        }
        if (args.color_out) {
            *args.color_out = result.color;
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
        if (EngineBase* redacted = RedactedEditor(pageNo)) {
            redacted->GetBitmapRecolorSkipRects(pageNo, zoom, rotation, renderPageRect, bmpSize, skipRects);
            return;
        }
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
            int x0 = (int)ceil(dev.x), y0 = (int)ceil(dev.y);
            Rect keep = Rect::FromXY(x0, y0, (int)floor(dev.x + dev.dx), (int)floor(dev.y + dev.dy));
            keep = keep.Intersect(tile);
            if (!keep.IsEmpty()) {
                VecAppend(skipRects, keep);
            }
        }
    }

    // Caller holds gPdfiumLock. Whether a shown widget draws text, which MuPDF's text includes and
    // PDFium's doesn't. Without an appearance MuPDF makes one that shows the field's value.
    bool WidgetHasText(FPDF_ANNOTATION annot) {
        constexpr int kHidden = FPDF_ANNOT_FLAG_HIDDEN | FPDF_ANNOT_FLAG_NOVIEW;
        if (gPdfium.FPDFAnnot_GetSubtype(annot) != FPDF_ANNOT_WIDGET || (gPdfium.FPDFAnnot_GetFlags(annot) & kHidden)) {
            return false;
        }
        bool hasText = false;
        unsigned long bytes = gPdfium.FPDFAnnot_GetAP(annot, FPDF_ANNOT_APPEARANCEMODE_NORMAL, nullptr, 0);
        if (bytes > sizeof(FPDF_WCHAR)) {
            WCHAR* ap = AllocArray<WCHAR>(bytes / sizeof(WCHAR) + 1);
            gPdfium.FPDFAnnot_GetAP(annot, FPDF_ANNOT_APPEARANCEMODE_NORMAL, (FPDF_WCHAR*)ap, bytes);
            hasText = wcsstr(ap, L"BT") != nullptr;
            free(ap);
            return hasText;
        }
        bytes = form ? gPdfium.FPDFAnnot_GetFormFieldValue(form, annot, nullptr, 0) : 0;
        if (bytes <= sizeof(FPDF_WCHAR)) {
            return false;
        }
        WCHAR* value = AllocArray<WCHAR>(bytes / sizeof(WCHAR) + 1);
        gPdfium.FPDFAnnot_GetFormFieldValue(form, annot, (FPDF_WCHAR*)value, bytes);
        hasText = !wstr::Eq(WStr(value), WStrL(L"Off"));
        free(value);
        return hasText;
    }

    PageText ExtractPageText(int pageNo) override { return ExtractText(pageNo, EditorLoad::Load); }

    EngineBase* TextEditor(int pageNo) {
        EngineBase* res = AnnotationEditor(EditorLoad::IfLoaded);
        return res && ((acroForm && res->TextGeneration() != 0) || EngineMupdfHasUnsavedAnnotations(res) ||
                       EngineMupdfPageRedacted(res, pageNo))
                   ? res
                   : nullptr;
    }

    // Hover's prefetch never loads the editor: without it, text MuPDF must supply is left partial.
    PageText ExtractPrefetchText(int pageNo) override { return ExtractText(pageNo, EditorLoad::IfLoaded); }

    // False while a render owns the lock or the text needs the editor, which can't load here:
    // the I-beam hover only reads cached text and search then reads the page once, blocking.
    bool TryExtractPageText(int pageNo, PageText* out) override {
        if (EngineBase* source = TextEditor(pageNo)) {
            return source->TryExtractPageText(pageNo, out);
        }
        *out = {};
        if (!gPdfiumLock.TryLock()) {
            return false;
        }
        bool needsEditor = false;
        PageText text = TextLocked(pageNo, &needsEditor);
        gPdfiumLock.Unlock();
        if (text.failed) {
            FreePageText(&text);
            return false;
        }
        if (!needsEditor) {
            *out = text;
            return true;
        }
        FreePageText(&text);
        EngineBase* editor = AnnotationEditor(EditorLoad::IfLoaded);
        return editor && editor->TryExtractPageText(pageNo, out);
    }

    PageText ExtractText(int pageNo, EditorLoad load) {
        if (EngineBase* source = TextEditor(pageNo)) {
            return source->ExtractPageText(pageNo);
        }
        PdfiumProfile profile(StrL("text"), pageNo);
        PageText result;
        bool needsEditor = false;
        {
            ScopedMutex lock(&gPdfiumLock);
            profile.Mark(StrL("lock"));
            result = TextLocked(pageNo, &needsEditor);
        }
        if (needsEditor) {
            EngineBase* editor = AnnotationEditor(load);
            if (editor) {
                FreePageText(&result);
                return editor->ExtractPageText(pageNo);
            }
            result.partial = true;
        }
        profile.Mark(StrL("characters"));
        return result;
    }

    // Caller holds gPdfiumLock. needsEditor: MuPDF's text has more (widget text, missing Unicode).
    PageText TextLocked(int pageNo, bool* needsEditor) {
        *needsEditor = false;
        auto* info = Page(pageNo);
        if (!info) {
            PageText result;
            result.failed = true;
            return result;
        }
        FPDF_PAGE page = gPdfium.FPDF_LoadPage(doc, pageNo - 1);
        if (!page) {
            PageText result;
            result.failed = true;
            return result;
        }
        bool missingUnicode = false;
        bool widgetText = false;
        PageText result = ReadPageText(page, info, &missingUnicode);
        int count = gPdfium.FPDFPage_GetAnnotCount(page);
        for (int i = 0; i < count && !widgetText; i++) {
            FPDF_ANNOTATION annot = gPdfium.FPDFPage_GetAnnot(page, i);
            if (annot) {
                widgetText = WidgetHasText(annot);
                gPdfium.FPDFPage_CloseAnnot(annot);
            }
        }
        gPdfium.FPDF_ClosePage(page);
        *needsEditor = widgetText || missingUnicode;
        return result;
    }

    Vec<IPageElement*> GetElements(int pageNo) override {
        EngineBase* redacted = RedactedEditor(pageNo);
        if (redacted && redacted->BenchLoadPage(pageNo)) {
            return redacted->GetElements(pageNo);
        }
        bool useMupdf = false;
        {
            ScopedMutex lock(&gPdfiumLock);
            Vec<IPageElement*> own;
            if (ElementsLocked(pageNo, own, &useMupdf)) {
                return own;
            }
        }

        if (useMupdf) {
            EngineBase* source = AnnotationEditor(EditorLoad::Load);
            if (source && source->BenchLoadPage(pageNo)) {
                return source->GetElements(pageNo);
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
        return PageElements(info);
    }

    // Caller holds gPdfiumLock. PDFium's elements; false when GetElements uses MuPDF's (useMupdf)
    // or adds attachment links.
    bool ElementsLocked(int pageNo, Vec<IPageElement*>& out, bool* useMupdf) {
        *useMupdf = false;
        auto* info = Page(pageNo);
        if (!info) {
            return true;
        }
        LoadLinks(pageNo, info);
        out = PageElements(info);
        *useMupdf = info->useMupdfElements;
        return !info->useMupdfElements && (!info->hasFileAttachments || info->attachmentLinksLoaded);
    }

    // Paint's link outlines and link recompute skip a page while its render owns the lock.
    // Attachment targets resolve only when followed.
    bool TryGetElements(int pageNo, Vec<IPageElement*>* out) override {
        if (EngineBase* redacted = RedactedEditor(pageNo)) {
            return redacted->TryGetElements(pageNo, out);
        }
        *out = Vec<IPageElement*>();
        if (!gPdfiumLock.TryLock()) {
            return false;
        }
        bool useMupdf = false;
        ElementsLocked(pageNo, *out, &useMupdf);
        gPdfiumLock.Unlock();
        EngineBase* source = useMupdf ? AnnotationEditor(EditorLoad::IfLoaded) : nullptr;
        Vec<IPageElement*> mupdf;
        // empty until the editor loaded the page
        if (source && source->TryGetElements(pageNo, &mupdf) && len(mupdf) > 0) {
            *out = mupdf;
        }
        return true;
    }

    Vec<IPageElement*> PageElements(PdfiumPage* info) {
        Vec<IPageElement*> elements;
        VecReserve(elements, len(info->imageElements) + len(info->links));
        for (IPageElement* image : info->imageElements) {
            VecAppend(elements, image);
        }
        for (IPageElement* link : info->links) {
            VecAppend(elements, link);
        }
        return elements;
    }

    IPageElement* GetElementAtPos(int pageNo, PointF point) override {
        Vec<IPageElement*> links;
        if (EngineBase* redacted = RedactedEditor(pageNo)) {
            return redacted->GetElementAtPos(pageNo, point);
        }
        // Hover reads PDFium's cached links and comments without opening the editor.
        if (!gPdfiumLock.TryLock()) {
            return nullptr;
        }
        bool useMupdf = false;
        ElementsLocked(pageNo, links, &useMupdf);
        gPdfiumLock.Unlock();
        EngineBase* source = AnnotationEditor(EditorLoad::IfLoaded);
        if (source) {
            IPageElement* edited = source->GetElementAtPos(pageNo, point);
            if (edited) {
                return edited;
            }
        }
        IPageElement* fallback = nullptr;
        for (int i = len(links) - 1; i >= 0; i--) {
            if (LinkContainsPoint(links[i], point)) {
                if (links[i]->Is(kindPageElementDest)) {
                    return links[i];
                }
                if (!fallback) {
                    fallback = links[i];
                }
            }
        }
        return fallback;
    }

    // Image IDs differ between engines, so match page bounds before MuPDF extracts the bytes.
    IPageElement* MupdfImage(IPageElement* element) {
        if (!element || element->GetKind() != kindPageElementImage) {
            return nullptr;
        }
        int pageNo = element->pageNo;
        EngineBase* source = AnnotationEditor(EditorLoad::Load);
        if (!source || !source->BenchLoadPage(pageNo)) {
            return nullptr;
        }

        IPageElement* match = nullptr;
        float bestArea = 0;
        for (IPageElement* candidate : source->GetElements(pageNo)) {
            if (candidate->GetKind() != kindPageElementImage) {
                continue;
            }
            RectF overlap = candidate->rect.Intersect(element->rect);
            float area = overlap.dx * overlap.dy;
            if (area > bestArea) {
                bestArea = area;
                match = candidate;
            }
        }
        return match;
    }

    RenderedBitmap* GetImageForPageElement(IPageElement* element) override {
        IPageElement* image = MupdfImage(element);
        EngineBase* source = AnnotationEditor(EditorLoad::IfLoaded);
        return image && source ? source->GetImageForPageElement(image) : nullptr;
    }

    Str GetImageDataForPageElement(IPageElement* element) override {
        IPageElement* image = MupdfImage(element);
        EngineBase* source = AnnotationEditor(EditorLoad::IfLoaded);
        return image && source ? source->GetImageDataForPageElement(image) : Str{};
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
        if (dest->GetKind() == kindDestinationLaunchEmbedded &&
            ((PageDestination*)dest)->embedObjNum == kUnresolvedAttachment) {
            Vec<IPageElement*> links;
            EngineMupdfAttachmentLinks(this, dest->pageNo, links);
            for (IPageElement* link : links) {
                RectF overlap = link->rect.Intersect(dest->rect);
                IPageDestination* found = overlap.dx > 0 && overlap.dy > 0 ? link->AsLink() : nullptr;
                if (found && found->GetKind() == kindDestinationLaunchEmbedded) {
                    auto* target = (PageDestination*)found;
                    auto* placeholder = (PageDestination*)dest;
                    placeholder->embedObjNum = target->embedObjNum;
                    placeholder->value = str::Dup(target->GetValue());
                    break;
                }
            }
            DeleteVecMembers(links);
            if (((PageDestination*)dest)->embedObjNum == kUnresolvedAttachment) {
                return false;
            }
        }
        if (dest->GetKind() == kindDestinationMupdf) {
            EngineBase* source = AnnotationEditor(EditorLoad::IfLoaded);
            return source && source->HandleLink(dest, handler);
        }
        handler->GotoLink(dest);
        return true;
    }

    TocTree* GetToc() override {
        TocTree* headings = EngineMupdfGetHeadingToc(this);
        if (headings) {
            return headings;
        }
        if (AtomicIntGet(&tocLoaded)) {
            return toc;
        }
        bool hasAttachments = false;
        bool needsMupdf = false;
        {
            ScopedMutex lock(&gPdfiumLock);
            if (AtomicIntGet(&tocLoaded)) {
                return toc;
            }
            hasAttachments = gPdfium.FPDFDoc_GetAttachmentCount(doc) > 0;
            int budget = 4096;
            needsMupdf = NeedsMupdfToc(gPdfium.FPDFBookmark_GetFirstChild(doc, nullptr), 0, budget);
        }

        if (needsMupdf) {
            EngineBase* source = AnnotationEditor(EditorLoad::Load);
            TocTree* sourceToc = source ? source->GetToc() : nullptr;
            if (sourceToc) {
                ScopedMutex lock(&gPdfiumLock);
                if (!AtomicIntGet(&tocLoaded)) {
                    toc = sourceToc;
                    tocFromEditor = true;
                    AtomicIntSet(&tocLoaded, 1);
                }
                return toc;
            }
        }

        // Read attachment names only for PDFs that have them; plain PDFs keep the PDFium-only path.
        TocTree* editorToc = hasAttachments ? EngineMupdfAttachmentToc(this) : nullptr;

        ScopedMutex lock(&gPdfiumLock);
        if (AtomicIntGet(&tocLoaded)) {
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
            dest->attachmentNo = ((PageDestination*)sourceDest)->attachmentNo;
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
        AtomicIntSet(&tocLoaded, 1);
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
        if (len(features) == 0) {
            return {};
        }
        return JoinTemp(&features, StrL(", "));
    }

    // "1.7", with the Adobe Extension Level of AES-256 encryption, as EngineMupdf says it
    TempStr PdfVersionTemp() {
        ScopedMutex lock(&gPdfiumLock);
        int version = 0;
        if (!gPdfium.FPDF_GetFileVersion(doc, &version) || version <= 0) {
            return {};
        }
        int major = version / 10, minor = version % 10;
        int revision = gPdfium.FPDF_GetSecurityHandlerRevision(doc);
        if (major == 1 && minor == 7 && (revision == 5 || revision == 6)) {
            return fmt("%d.%d Adobe Extension Level %d", major, minor, revision == 5 ? 3 : 8);
        }
        return fmt("%d.%d", major, minor);
    }

    TempStr GetPropertyTemp(DocProp prop) override {
        if (prop == DocProp::UnsupportedFeatures) {
            return UnsupportedFeaturesTemp();
        }
        if (prop == DocProp::PdfVersion) {
            return PdfVersionTemp();
        }
        const char* key = nullptr;
        switch (prop) {
            case DocProp::Title:
                key = "Title";
                break;
            case DocProp::Author:
                key = "Author";
                break;
            case DocProp::Copyright:
                key = "Copyright";
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
        TempStr value;
        {
            ScopedMutex lock(&gPdfiumLock);
            unsigned long bytes = gPdfium.FPDF_GetMetaText(doc, key, nullptr, 0);
            if (bytes >= sizeof(WCHAR) && bytes <= 2 * 1024 * 1024 && bytes % sizeof(WCHAR) == 0) {
                WCHAR* buf = AllocArrayTemp<WCHAR>((int)(bytes / sizeof(WCHAR)));
                if (gPdfium.FPDF_GetMetaText(doc, key, buf, bytes) == bytes) {
                    value = ToUtf8Temp(WStr(buf, (int)(bytes / sizeof(WCHAR)) - 1));
                }
            }
        }
        return value;
    }

    void GetProperties(Props& propsOut) override {
        EngineBase::GetProperties(propsOut);
        TempStr keywords = GetPropertyTemp(DocProp::Keywords);
        if (len(keywords) > 0) {
            AddProp(propsOut, DocProp::Keywords, keywords);
        }

        // Document Properties only (the frame title runs on every open): PDFium can't read
        // the catalog's XMP, so fields missing from Info come from MuPDF
        if (HasXmp()) {
            EngineBase* source = AnnotationEditor(EditorLoad::Load);
            Props xmpProps;
            if (source) {
                source->GetProperties(xmpProps);
            }
            constexpr DocProp kXmpProps[] = {DocProp::Title,        DocProp::Author,           DocProp::Subject,
                                             DocProp::Copyright,    DocProp::CreatorApp,       DocProp::PdfProducer,
                                             DocProp::CreationDate, DocProp::ModificationDate, DocProp::Keywords};
            for (DocProp prop : kXmpProps) {
                Str val = GetPropValueTemp(xmpProps, prop);
                if (len(GetPropValueTemp(propsOut, prop)) == 0 && len(val) > 0) {
                    AddProp(propsOut, prop, str::DupTemp(val));
                }
            }
        }

        if (!HasSignatures()) {
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

    Str GetFileData() override {
        if (fileData.s) {
            return str::Dup(fileData);
        }
        if (access.m_FileLen > INT_MAX - 1) {
            return {};
        }
        int n = (int)access.m_FileLen;
        char* data = AllocArray<char>(n + 1);
        if (!data || !ReadBlock(this, 0, (unsigned char*)data, (unsigned long)n)) {
            free(data);
            return {};
        }
        data[n] = 0;
        return Str(data, n);
    }

    bool SaveFileAs(Str path) override {
        WCHAR failure[2]{};
#if IS_DEBUG
        if (gForTesting) {
            GetEnvironmentVariableW(L"SOLOKPDF_TEST_SAVE_FAILURE", failure, dimofi(failure));
        }
#endif
        // A renamed source or hard link may name the retained input itself.
        if (!fileData.s && file::Exists(path)) {
            HANDLE existing = CreateFileW(CWStrTemp(path), FILE_READ_ATTRIBUTES,
                                          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                          OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (existing == INVALID_HANDLE_VALUE) {
                return false;
            }
            BY_HANDLE_FILE_INFORMATION srcInfo{}, dstInfo{};
            bool infoOk = GetFileInformationByHandle(file, &srcInfo) && GetFileInformationByHandle(existing, &dstInfo);
            CloseHandle(existing);
            if (!infoOk) {
                return false;
            }
            bool same = srcInfo.dwVolumeSerialNumber == dstInfo.dwVolumeSerialNumber &&
                        srcInfo.nFileIndexHigh == dstInfo.nFileIndexHigh &&
                        srcInfo.nFileIndexLow == dstInfo.nFileIndexLow;
            if (same) {
                return true;
            }
        }
        TempStr staged = file::CreateTempNear(path);
        if (len(staged) == 0) {
            return false;
        }
        defer {
            file::Delete(staged);
        };
        HANDLE dst =
            CreateFileW(CWStrTemp(staged), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (dst == INVALID_HANDLE_VALUE) {
            return false;
        }

        constexpr unsigned long kCopyChunkSize = 64 * 1024;
        unsigned char data[kCopyChunkSize];
        bool ok = true;
        for (unsigned long offset = 0; offset < access.m_FileLen;) {
            if (failure[0] == L'r' && offset >= access.m_FileLen / 2) {
                ok = false;
                break;
            }
            DWORD count = access.m_FileLen - offset;
            if (count > kCopyChunkSize) {
                count = kCopyChunkSize;
            }
            DWORD written = 0;
            if (!ReadBlock(this, offset, data, count) || !WriteFile(dst, data, count, &written, nullptr) ||
                written != count) {
                ok = false;
                break;
            }
            offset += count;
            if (failure[0] == L'w' && offset >= access.m_FileLen / 2) {
                ok = false;
                break;
            }
        }
        if (ok) {
            ok = FlushFileBuffers(dst) != 0;
        }
        CloseHandle(dst);
        return ok && file::RenameReplace(path, staged);
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
    gPdfium.SetFontCacheDir(dir);
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
    bool ok = engine->Load(path, {}, pwdUI, errorOut, &failure);
    if (failureOut) {
        *failureOut = failure;
    }
    if (ok) {
        engine->LoadDocumentJs();
        return engine;
    }
    logf("PDFium: %s File: '%s'\n", *errorOut, path);
    engine->Release();
    return nullptr;
}

EngineBase* CreateEnginePdfiumFromData(Str data, PasswordUI* pwdUI, TempStr* errorOut, PdfiumFailure* failureOut) {
    auto* engine = new EnginePdfium();
    PdfiumFailure failure = PdfiumFailure::Fallback;
    bool ok = engine->Load({}, data, pwdUI, errorOut, &failure);
    if (failureOut) {
        *failureOut = failure;
    }
    if (ok) {
        engine->LoadDocumentJs();
        return engine;
    }
    logf("PDFium: %s (memory document)\n", *errorOut);
    engine->Release();
    return nullptr;
}

bool EnginePdfiumPagePathPoints(EngineBase* engine, int pageNo, Vec<PointF>& out) {
    auto* pdfium = engine && engine->kind == kindEnginePdfium ? (EnginePdfium*)engine : nullptr;
    return pdfium && pdfium->PagePathPoints(pageNo, out);
}

bool EnginePdfiumIsDataBacked(EngineBase* engine) {
    auto* pdfium = engine && engine->kind == kindEnginePdfium ? (EnginePdfium*)engine : nullptr;
    return pdfium && pdfium->IsDataBacked();
}
