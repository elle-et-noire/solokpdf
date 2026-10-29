/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

// Fallback: MuPDF may open what PDFium couldn't. Final: no password was given, don't ask again.
enum class PdfiumFailure {
    Fallback,
    Final
};

void SetPdfiumFontCacheDir(Str dir);
void StartPdfiumWarmUp();
bool PdfiumRequested();
TempStr ProtectPdfPasswordTemp(Str password, const u8 digest[16]);
Str UnprotectPdfPassword(Str sealed, const u8 digest[16]);
EngineBase* CreateEnginePdfium(Str path, PasswordUI* pwdUI, TempStr* errorOut, PdfiumFailure* failureOut = nullptr);
EngineBase* CreateEnginePdfiumFromData(Str data, PasswordUI* pwdUI, TempStr* errorOut,
                                       PdfiumFailure* failureOut = nullptr);
bool EnginePdfiumIsDataBacked(EngineBase* engine);
