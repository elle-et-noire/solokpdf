// Copyright 2026 SolokPDF contributors. License: GPLv3.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <stdio.h>
#include <fpdfview.h>

static unsigned long long PrivateBytes() {
    PROCESS_MEMORY_COUNTERS_EX m{};
    m.cb = sizeof(m);
    if (!GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&m), sizeof(m))) return 0;
    return static_cast<unsigned long long>(m.PrivateUsage);
}

int wmain(int argc, wchar_t** argv) {
    constexpr int kMaxDocs = 8;
    if (argc < 3 || argc > kMaxDocs + 2) {
        fprintf(stderr, "usage: pdfium-multi-alloc.exe pdfium.dll input.pdf [input.pdf ...]\n");
        return 2;
    }

    HMODULE module = LoadLibraryExW(argv[1], nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module) return 1;
#define API(name) auto name = reinterpret_cast<decltype(&::name)>(GetProcAddress(module, #name));
    API(FPDF_InitLibraryWithConfig);
    API(FPDF_DestroyLibrary);
    API(FPDF_LoadDocument);
    API(FPDF_CloseDocument);
    API(FPDF_LoadPage);
    API(FPDF_ClosePage);
#undef API
    if (!FPDF_InitLibraryWithConfig || !FPDF_DestroyLibrary || !FPDF_LoadDocument || !FPDF_CloseDocument ||
        !FPDF_LoadPage || !FPDF_ClosePage)
        return 1;

    FPDF_DOCUMENT docs[kMaxDocs]{};
    unsigned long long baseline = PrivateBytes();
    FPDF_LIBRARY_CONFIG config{};
    config.version = 2;
    FPDF_InitLibraryWithConfig(&config);
    printf("{\"before_init\":%llu,\"after_init\":%llu,\"opened\":[", baseline, PrivateBytes());

    for (int i = 2; i < argc; i++) {
        char path[32768]{};
        if (!WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, path, sizeof(path), nullptr, nullptr)) return 1;
        docs[i - 2] = FPDF_LoadDocument(path, nullptr);
        if (!docs[i - 2]) return 1;
        unsigned long long afterDoc = PrivateBytes();
        FPDF_PAGE page = FPDF_LoadPage(docs[i - 2], 0);
        if (!page) return 1;
        unsigned long long afterPage = PrivateBytes();
        FPDF_ClosePage(page);
        printf("%s{\"after_document\":%llu,\"after_page\":%llu,\"after_page_close\":%llu}", i == 2 ? "" : ",", afterDoc,
               afterPage, PrivateBytes());
    }
    printf("],\"before_close\":%llu,\"closed\":[", PrivateBytes());
    for (int i = argc - 3; i >= 0; i--) {
        FPDF_CloseDocument(docs[i]);
        printf("%s%llu", i == argc - 3 ? "" : ",", PrivateBytes());
    }
    FPDF_DestroyLibrary();
    printf("],\"after_shutdown\":%llu}\n", PrivateBytes());
    FreeLibrary(module);
    return 0;
}
