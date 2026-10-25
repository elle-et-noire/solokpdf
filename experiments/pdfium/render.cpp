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
                "usage: pdfium-render.exe input.pdf page dpi output.png [--lcd] [--font-info-v2] [--repeat N] [--scale "
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
    Memory("before_init");
    double start = NowMs();
    FPDF_LIBRARY_CONFIG config{};
    config.version = 2;
    pdf.api.FPDF_InitLibraryWithConfig(&config);
    pdf.initialized = true;
    if (fontInfoV2) {
        pdf.fontInfo = pdf.api.FPDF_GetDefaultSystemFontInfo();
        if (!pdf.fontInfo) return 1;
        constexpr int kPerRequestFonts = 2;
        pdf.fontInfo->version = kPerRequestFonts;
        pdf.api.FPDF_SetSystemFontInfo(pdf.fontInfo);
    }
    printf("\"init_ms\":%.6f,\n", NowMs() - start);
    start = NowMs();
    pdf.doc = pdf.api.FPDF_LoadCustomDocument(&file.access, nullptr);
    if (!pdf.doc) {
        fprintf(stderr, "PDF load failed (PDFium error %lu).\n", pdf.api.FPDF_GetLastError());
        return 1;
    }
    printf("\"document_load_ms\":%.6f,\n", NowMs() - start);
    int count = pdf.api.FPDF_GetPageCount(pdf.doc);
    if (pageNo > count) {
        fprintf(stderr, "Page out of range (1..%d).\n", count);
        return 2;
    }
    start = NowMs();
    pdf.page = pdf.api.FPDF_LoadPage(pdf.doc, static_cast<int>(pageNo - 1));
    if (!pdf.page) {
        fprintf(stderr, "PDF page load failed.\n");
        return 1;
    }
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
    printf("\"page\":%ld,\"pages\":%d,\"width\":%d,\"height\":%d,\n\"render_ms\":[", pageNo, count, width, height);
    for (int i = 0; i < repeat; i++) {
        pdf.api.FPDFBitmap_FillRect(pdf.bitmap, 0, 0, width, height, 0xffffffff);
        start = NowMs();
        pdf.api.FPDF_RenderPageBitmap(pdf.bitmap, pdf.page, 0, 0, width, height, 0, flags);
        printf("%s%.6f", i ? "," : "", NowMs() - start);
    }
    printf("],\n");
    Memory("after_render");
    start = NowMs();
    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool saved = SUCCEEDED(com) && SavePng(argv[4], pixels, width, height);
    if (SUCCEEDED(com)) CoUninitialize();
    printf("\"png_ms\":%.6f,\"png_saved\":%s\n}\n", NowMs() - start, saved ? "true" : "false");
    pdf.api.FPDFBitmap_Destroy(pdf.bitmap);
    pdf.bitmap = nullptr;
    free(pixels);
    if (!saved) fprintf(stderr, "Cannot save PNG. Ensure the output directory exists.\n");
    return saved ? 0 : 1;
}
