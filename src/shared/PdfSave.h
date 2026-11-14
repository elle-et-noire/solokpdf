/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

void SavePdfFile(fz_context*, pdf_document*, Str path, const pdf_write_options*);
void PublishPdfFile(fz_context*, Str path, Str staged);
