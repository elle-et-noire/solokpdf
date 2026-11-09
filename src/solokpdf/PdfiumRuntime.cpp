/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include "base/Base.h"
#include "base/File.h"
#include <fpdf_sysfontinfo.h>
#include "PdfiumFontCache.h"
#include "PdfiumRuntime.h"

// PDFium forbids concurrent calls even for different documents.
Mutex gPdfiumLock;
PdfiumRuntime gPdfium;

static constexpr int kPdfiumConfigVersion = 2;
static constexpr Str kPdfiumVersion = StrL("158.0.8111.0");

// The engine holds gPdfiumLock across lifetime changes and document work.
bool PdfiumRuntime::Acquire(TempStr* error) {
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
        config.version = kPdfiumConfigVersion;
        FPDF_InitLibraryWithConfig(&config);
        InstallFontCache();
    }
    users++;
    return true;
}

void PdfiumRuntime::Release() {
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

void PdfiumRuntime::SetFontCacheDir(Str dir) {
    str::ReplaceWithCopy(&fontCacheDir, dir);
}

bool PdfiumRuntime::FontCacheEnabled() {
    WCHAR value[2]{};
    bool off = GetEnvironmentVariableW(L"SOLOKPDF_FONT_CACHE", value, dimofi(value)) == 1 && value[0] == L'0';
    return !off && len(fontCacheDir) > 0;
}

void PdfiumRuntime::InstallFontCache() {
    if (!FontCacheEnabled()) {
        return;
    }
    defaultFontInfo = FPDF_GetDefaultSystemFontInfo();
    if (!defaultFontInfo) {
        return;
    }
    TempStr path = path::JoinTemp(fontCacheDir, StrL("pdfium-fonts.cache"));
    fontCache = PdfiumFontCacheNew(defaultFontInfo, path, kPdfiumVersion);
    FPDF_SetSystemFontInfo(PdfiumFontCacheInfo(fontCache));
}
