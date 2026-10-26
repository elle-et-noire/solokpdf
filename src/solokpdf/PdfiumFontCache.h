/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

// PDFium's default system font info, with the font reads made while enumerating installed fonts
// served from a cache file. Rendering is unchanged: PDFium gets the same bytes it would read.
struct PdfiumFontCache;

PdfiumFontCache* PdfiumFontCacheNew(FPDF_SYSFONTINFO* defaultInfo, Str path, Str key);
FPDF_SYSFONTINFO* PdfiumFontCacheInfo(PdfiumFontCache* cache);
void PdfiumFontCacheDelete(PdfiumFontCache* cache);
