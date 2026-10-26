// Copyright 2026 SolokPDF contributors. License: GPLv3.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <wincodec.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <fpdfview.h>
#include <fpdf_sysfontinfo.h>

#define PDF_API(X)                    \
    X(FPDF_InitLibraryWithConfig)     \
    X(FPDF_DestroyLibrary)            \
    X(FPDF_GetDefaultSystemFontInfo)  \
    X(FPDF_SetSystemFontInfo)         \
    X(FPDF_FreeDefaultSystemFontInfo) \
    X(FPDF_LoadCustomDocument)        \
    X(FPDF_GetLastError)              \
    X(FPDF_CloseDocument)             \
    X(FPDF_GetPageCount)              \
    X(FPDF_LoadPage)                  \
    X(FPDF_ClosePage)                 \
    X(FPDF_GetPageWidthF)             \
    X(FPDF_GetPageHeightF)            \
    X(FPDFBitmap_CreateEx)            \
    X(FPDFBitmap_Destroy)             \
    X(FPDFBitmap_FillRect)            \
    X(FPDF_RenderPageBitmap)

struct PdfApi {
    HMODULE module = nullptr;
#define DECLARE_API(name) decltype(&::name) name = nullptr;
    PDF_API(DECLARE_API)
#undef DECLARE_API
    bool Load(const wchar_t* path) {
        module = LoadLibraryExW(path, nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!module) {
            fwprintf(stderr, L"Cannot load PDFium DLL '%ls' (Windows error %lu).\n", path, GetLastError());
            return false;
        }
#define LOAD_API(name)                                                      \
    name = reinterpret_cast<decltype(name)>(GetProcAddress(module, #name)); \
    if (!name) {                                                            \
        fprintf(stderr, "Missing PDFium export: %s\n", #name);              \
        return false;                                                       \
    }
        PDF_API(LOAD_API)
#undef LOAD_API
        return true;
    }
    ~PdfApi() {
        if (module) FreeLibrary(module);
    }
};

struct PdfRuntime {
    PdfApi api;
    bool initialized = false;
    FPDF_DOCUMENT doc = nullptr;
    FPDF_PAGE page = nullptr;
    FPDF_BITMAP bitmap = nullptr;
    FPDF_SYSFONTINFO* fontInfo = nullptr;
    ~PdfRuntime() {
        if (bitmap) api.FPDFBitmap_Destroy(bitmap);
        if (page) api.FPDF_ClosePage(page);
        if (doc) api.FPDF_CloseDocument(doc);
        if (initialized) api.FPDF_DestroyLibrary();
        if (fontInfo) api.FPDF_FreeDefaultSystemFontInfo(fontInfo);
    }
};

struct InputFile {
    HANDLE handle = INVALID_HANDLE_VALUE;
    FPDF_FILEACCESS access{};
    static int Read(void* user, unsigned long offset, unsigned char* data, unsigned long size) {
        auto* self = static_cast<InputFile*>(user);
        if (offset > self->access.m_FileLen || size > self->access.m_FileLen - offset) return 0;
        LARGE_INTEGER pos{};
        pos.QuadPart = offset;
        DWORD read = 0;
        return SetFilePointerEx(self->handle, pos, nullptr, FILE_BEGIN) &&
               ReadFile(self->handle, data, size, &read, nullptr) && read == size;
    }
    bool Open(const wchar_t* path) {
        handle =
            CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        LARGE_INTEGER size{};
        if (handle == INVALID_HANDLE_VALUE || !GetFileSizeEx(handle, &size) || size.QuadPart <= 0 ||
            size.QuadPart > MAXDWORD)
            return false;
        access.m_FileLen = static_cast<unsigned long>(size.QuadPart);
        access.m_GetBlock = Read;
        access.m_Param = this;
        return true;
    }
    ~InputFile() {
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    }
};

template <typename T>
struct ComPtr {
    T* p = nullptr;
    ~ComPtr() {
        if (p) p->Release();
    }
    T** Out() { return &p; }
    T* operator->() { return p; }
};

static bool SavePng(const wchar_t* path, BYTE* pixels, UINT width, UINT height) {
    ComPtr<IWICImagingFactory> factory;
    ComPtr<IWICStream> stream;
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.Out()))) ||
        FAILED(factory->CreateStream(stream.Out())) || FAILED(stream->InitializeFromFilename(path, GENERIC_WRITE)) ||
        FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.Out())) ||
        FAILED(encoder->Initialize(stream.p, WICBitmapEncoderNoCache)) ||
        FAILED(encoder->CreateNewFrame(frame.Out(), nullptr)) || FAILED(frame->Initialize(nullptr)) ||
        FAILED(frame->SetSize(width, height)))
        return false;
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    if (FAILED(frame->SetPixelFormat(&format)) || !IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA) ||
        FAILED(frame->WritePixels(height, width * 4, width * height * 4, pixels)))
        return false;
    return SUCCEEDED(frame->Commit()) && SUCCEEDED(encoder->Commit());
}

static double NowMs() {
    LARGE_INTEGER counter, frequency;
    QueryPerformanceCounter(&counter);
    QueryPerformanceFrequency(&frequency);
    return 1000.0 * counter.QuadPart / frequency.QuadPart;
}

struct FontProfile {
    decltype(FPDF_SYSFONTINFO::EnumFonts) enumFonts = nullptr;
    decltype(FPDF_SYSFONTINFO::GetFontData) getData = nullptr;
    decltype(FPDF_SYSFONTINFO::GetFaceName) getName = nullptr;
    decltype(FPDF_SYSFONTINFO::MapFont) mapFont = nullptr;
    decltype(FPDF_SYSFONTINFO::GetFont) getFont = nullptr;
    decltype(FPDF_SYSFONTINFO::DeleteFont) deleteFont = nullptr;
    int enumCalls = 0;
    int dataCalls = 0;
    unsigned long long dataBytes = 0;
    double enumMs = 0;
    double dataMs = 0;
    // callbacks PDFium makes from inside EnumFonts (localized family names)
    bool inEnum = false;
    int nestedCalls = 0;
    int nestedOpens = 0;
    double nestedMs = 0;
    int mapCalls = 0;
    double mapMs = 0;

    void Nested(double ms) {
        if (!inEnum) return;
        nestedCalls++;
        nestedMs += ms;
    }

    static void Enum(FPDF_SYSFONTINFO* info, void* mapper) {
        double start = NowMs();
        fonts.inEnum = true;
        fonts.enumFonts(info, mapper);
        fonts.inEnum = false;
        fonts.enumMs += NowMs() - start;
        fonts.enumCalls++;
    }

    static unsigned long Data(FPDF_SYSFONTINFO* info, void* font, unsigned int table, unsigned char* buffer,
                              unsigned long size) {
        double start = NowMs();
        unsigned long result = fonts.getData(info, font, table, buffer, size);
        fonts.dataMs += NowMs() - start;
        fonts.Nested(NowMs() - start);
        fonts.dataCalls++;
        if (buffer && result <= size) fonts.dataBytes += result;
        return result;
    }

    static void* Map(FPDF_SYSFONTINFO* info, int weight, FPDF_BOOL italic, int charset, int pitch, const char* face,
                     FPDF_BOOL* exact) {
        double start = NowMs();
        void* result = fonts.mapFont(info, weight, italic, charset, pitch, face, exact);
        fonts.Nested(NowMs() - start);
        if (fonts.inEnum) {
            fonts.nestedOpens++;
        } else {
            fonts.mapCalls++;
            fonts.mapMs += NowMs() - start;
        }
        return result;
    }

    static void* Get(FPDF_SYSFONTINFO* info, const char* face) {
        double start = NowMs();
        void* result = fonts.getFont(info, face);
        fonts.Nested(NowMs() - start);
        if (fonts.inEnum) fonts.nestedOpens++;
        return result;
    }

    static void Delete(FPDF_SYSFONTINFO* info, void* font) {
        double start = NowMs();
        fonts.deleteFont(info, font);
        fonts.Nested(NowMs() - start);
    }

    static unsigned long Name(FPDF_SYSFONTINFO* info, void* font, char* buffer, unsigned long size) {
        unsigned long result = fonts.getName(info, font, buffer, size);
        // PDFium's internal font names exclude the default callback's trailing NUL.
        if (buffer && result > 0 && result <= size && buffer[result - 1] == 0) return result - 1;
        return result;
    }

    void Install(FPDF_SYSFONTINFO* info) {
        enumFonts = info->EnumFonts;
        getData = info->GetFontData;
        getName = info->GetFaceName;
        mapFont = info->MapFont;
        getFont = info->GetFont;
        deleteFont = info->DeleteFont;
        info->EnumFonts = Enum;
        info->GetFontData = Data;
        info->GetFaceName = Name;
        info->MapFont = Map;
        info->GetFont = Get;
        info->DeleteFont = Delete;
    }

    static FontProfile fonts;
};
FontProfile FontProfile::fonts;

struct GdiEnum {
    int callbacks = 0;
    int truetype = 0;
    int localized = 0;

    static int CALLBACK Proc(const LOGFONTA* lf, const TEXTMETRICA*, DWORD type, LPARAM param) {
        auto* self = reinterpret_cast<GdiEnum*>(param);
        self->callbacks++;
        if (type & TRUETYPE_FONTTYPE) self->truetype++;
        for (const char* c = lf->lfFaceName; *c; c++) {
            if (*c & 0x80) {
                self->localized++;
                break;
            }
        }
        return 1;
    }
};

// Raw GDI enumeration as PDFium's Windows font info does it: every family and charset.
static void TimeGdiEnum() {
    HDC dc = CreateCompatibleDC(nullptr);
    LOGFONTA lf{};
    lf.lfCharSet = DEFAULT_CHARSET;
    GdiEnum e;
    double start = NowMs();
    EnumFontFamiliesExA(dc, &lf, GdiEnum::Proc, reinterpret_cast<LPARAM>(&e), 0);
    double ms = NowMs() - start;
    DeleteDC(dc);
    printf("\"gdi_enum\":{\"ms\":%.6f,\"callbacks\":%d,\"truetype\":%d,\"localized\":%d},\n", ms, e.callbacks,
           e.truetype, e.localized);
}

static void Memory(const char* phase) {
    PROCESS_MEMORY_COUNTERS_EX m{};
    m.cb = sizeof(m);
    if (!GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&m), sizeof(m))) {
        fprintf(stderr, "Cannot read process memory counters.\n");
        return;
    }
    printf("\"%s\":{\"working_set_bytes\":%llu,\"private_bytes\":%llu,\"peak_working_set_bytes\":%llu},\n", phase,
           static_cast<unsigned long long>(m.WorkingSetSize), static_cast<unsigned long long>(m.PrivateUsage),
           static_cast<unsigned long long>(m.PeakWorkingSetSize));
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 5) {
        fprintf(stderr,
                "usage: pdfium-render.exe input.pdf page dpi output.png [--lcd] [--font-info-v2] [--font-profile] "
                "[--gdi-enum] "
                "[--repeat N] [--scale "
                "N] [--dll path]\n");
        return 2;
    }
    wchar_t* end = nullptr;
    long pageNo = wcstol(argv[2], &end, 10);
    if (!end || *end || pageNo < 1 || pageNo > INT_MAX) return 2;
    double dpi = wcstod(argv[3], &end);
    if (!end || *end || !isfinite(dpi) || dpi <= 0 || dpi > 2400) return 2;
    int repeat = 1;
    int flags = FPDF_ANNOT;
    bool fontInfoV2 = false;
    bool fontProfile = false;
    bool gdiEnum = false;
    wchar_t dllPath[32768]{};
    DWORD n = GetModuleFileNameW(nullptr, dllPath, _countof(dllPath));
    if (!n || n >= _countof(dllPath)) return 1;
    wchar_t* slash = wcsrchr(dllPath, L'\\');
    if (!slash) return 1;
    wcscpy_s(slash + 1, _countof(dllPath) - (slash + 1 - dllPath), L"pdfium.dll");
    for (int i = 5; i < argc; i++) {
        if (wcscmp(argv[i], L"--lcd") == 0) {
            flags |= FPDF_LCD_TEXT;
            continue;
        }
        if (wcscmp(argv[i], L"--font-info-v2") == 0) {
            fontInfoV2 = true;
            continue;
        }
        if (wcscmp(argv[i], L"--font-profile") == 0) {
            fontProfile = true;
            continue;
        }
        if (wcscmp(argv[i], L"--gdi-enum") == 0) {
            gdiEnum = true;
            continue;
        }
        if (i + 1 >= argc) return 2;
        if (wcscmp(argv[i], L"--dll") == 0) {
            if (!GetFullPathNameW(argv[++i], _countof(dllPath), dllPath, nullptr)) return 2;
        } else if (wcscmp(argv[i], L"--repeat") == 0) {
            long value = wcstol(argv[++i], &end, 10);
            if (*end || value < 1 || value > 1000) return 2;
            repeat = static_cast<int>(value);
        } else if (wcscmp(argv[i], L"--scale") == 0) {
            double scale = wcstod(argv[++i], &end);
            if (*end || !isfinite(scale) || scale <= 0 || scale > 2400.0 / 72) return 2;
            dpi = scale * 72;
        } else
            return 2;
    }

    InputFile file;
    if (!file.Open(argv[1])) {
        fprintf(stderr, "Cannot open PDF (empty or >4 GiB files are unsupported by this probe).\n");
        return 1;
    }
    PdfRuntime pdf;
    if (!pdf.api.Load(dllPath)) return 1;
    printf("{\n\"engine\":\"pdfium-158.0.8111.0\",\"renderer\":\"build-default (AGG)\",\"flags\":%d,\"dpi\":%.6f,\n",
           flags, dpi);
    if (gdiEnum) TimeGdiEnum();
    Memory("before_init");
    double start = NowMs();
    FPDF_LIBRARY_CONFIG config{};
    config.version = 2;
    pdf.api.FPDF_InitLibraryWithConfig(&config);
    pdf.initialized = true;
    if (fontInfoV2 || fontProfile) {
        pdf.fontInfo = pdf.api.FPDF_GetDefaultSystemFontInfo();
        if (!pdf.fontInfo) return 1;
        constexpr int kPerRequestFonts = 2;
        if (fontInfoV2) pdf.fontInfo->version = kPerRequestFonts;
        if (fontProfile) FontProfile::fonts.Install(pdf.fontInfo);
        pdf.api.FPDF_SetSystemFontInfo(pdf.fontInfo);
    }
    Memory("after_init");
    printf("\"init_ms\":%.6f,\n", NowMs() - start);
    start = NowMs();
    pdf.doc = pdf.api.FPDF_LoadCustomDocument(&file.access, nullptr);
    if (!pdf.doc) {
        fprintf(stderr, "PDF load failed (PDFium error %lu).\n", pdf.api.FPDF_GetLastError());
        return 1;
    }
    Memory("after_document");
    printf("\"document_load_ms\":%.6f,\n", NowMs() - start);
    int count = pdf.api.FPDF_GetPageCount(pdf.doc);
    if (pageNo > count) {
        fprintf(stderr, "Page out of range (1..%d).\n", count);
        return 2;
    }
    Memory("before_page");
    start = NowMs();
    pdf.page = pdf.api.FPDF_LoadPage(pdf.doc, static_cast<int>(pageNo - 1));
    if (!pdf.page) {
        fprintf(stderr, "PDF page load failed.\n");
        return 1;
    }
    Memory("after_page");
    printf("\"page_load_ms\":%.6f,\n", NowMs() - start);
    double w = ceil(pdf.api.FPDF_GetPageWidthF(pdf.page) * dpi / 72);
    double h = ceil(pdf.api.FPDF_GetPageHeightF(pdf.page) * dpi / 72);
    constexpr double kMaxPixels = 64 * 1024 * 1024;
    if (!isfinite(w) || !isfinite(h) || w < 1 || h < 1 || w > INT_MAX / 4 || h > INT_MAX || w * h > kMaxPixels) {
        fprintf(stderr, "Invalid or oversized render dimensions (limit 64M pixels).\n");
        return 2;
    }
    int width = static_cast<int>(w), height = static_cast<int>(h);
    BYTE* pixels = static_cast<BYTE*>(calloc(static_cast<size_t>(width) * height, 4));
    if (!pixels) return 1;
    pdf.bitmap = pdf.api.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, pixels, width * 4);
    if (!pdf.bitmap) {
        free(pixels);
        return 1;
    }
    Memory("after_bitmap_alloc");
    printf("\"page\":%ld,\"pages\":%d,\"width\":%d,\"height\":%d,\n\"render_ms\":[", pageNo, count, width, height);
    for (int i = 0; i < repeat; i++) {
        pdf.api.FPDFBitmap_FillRect(pdf.bitmap, 0, 0, width, height, 0xffffffff);
        start = NowMs();
        pdf.api.FPDF_RenderPageBitmap(pdf.bitmap, pdf.page, 0, 0, width, height, 0, flags);
        printf("%s%.6f", i ? "," : "", NowMs() - start);
    }
    printf("],\n");
    Memory("after_render");
    if (fontProfile) {
        const auto& p = FontProfile::fonts;
        printf(
            "\"font_profile\":{\"version\":%d,\"enum_calls\":%d,\"enum_ms\":%.6f,\"data_calls\":%d,"
            "\"data_ms\":%.6f,\"data_bytes\":%llu,\"nested_calls\":%d,\"nested_opens\":%d,\"nested_ms\":%.6f,"
            "\"map_calls\":%d,\"map_ms\":%.6f},\n",
            pdf.fontInfo->version, p.enumCalls, p.enumMs, p.dataCalls, p.dataMs, p.dataBytes, p.nestedCalls,
            p.nestedOpens, p.nestedMs, p.mapCalls, p.mapMs);
    }
    pdf.api.FPDFBitmap_Destroy(pdf.bitmap);
    pdf.bitmap = nullptr;
    Memory("after_bitmap_close");
    pdf.api.FPDF_ClosePage(pdf.page);
    pdf.page = nullptr;
    Memory("after_page_close");
    pdf.api.FPDF_CloseDocument(pdf.doc);
    pdf.doc = nullptr;
    Memory("after_document_close");
    pdf.api.FPDF_DestroyLibrary();
    pdf.initialized = false;
    Memory("after_shutdown");
    start = NowMs();
    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool saved = SUCCEEDED(com) && SavePng(argv[4], pixels, width, height);
    if (SUCCEEDED(com)) CoUninitialize();
    double pngMs = NowMs() - start;
    free(pixels);
    Memory("after_pixel_free");
    printf("\"png_ms\":%.6f,\"png_saved\":%s\n}\n", pngMs, saved ? "true" : "false");
    if (!saved) fprintf(stderr, "Cannot save PNG. Ensure the output directory exists.\n");
    return saved ? 0 : 1;
}
