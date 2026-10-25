/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

// Fallback: MuPDF may open what PDFium couldn't. Final: no password was given, don't ask again.
enum class PdfiumFailure {
    Fallback,
    Final
};

bool PdfiumRequested();
EngineBase* CreateEnginePdfium(Str path, PasswordUI* pwdUI, TempStr* errorOut, PdfiumFailure* failureOut = nullptr);
