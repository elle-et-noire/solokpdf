/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include <fpdfview.h>
#include <fpdf_annot.h>
#include <fpdf_attachment.h>
#include <fpdf_doc.h>
#include <fpdf_edit.h>
#include <fpdf_formfill.h>
#include <fpdf_javascript.h>
#include <fpdf_signature.h>
#include <fpdf_text.h>
#include <fpdf_transformpage.h>
#include <fpdf_progressive.h>
#include <fpdf_sysfontinfo.h>

#define PDFIUM_API(X)                      \
    X(FPDF_InitLibraryWithConfig)          \
    X(FPDF_DestroyLibrary)                 \
    X(FPDF_GetDefaultSystemFontInfo)       \
    X(FPDF_SetSystemFontInfo)              \
    X(FPDF_FreeDefaultSystemFontInfo)      \
    X(FPDF_LoadCustomDocument)             \
    X(FPDF_LoadMemDocument)                \
    X(FPDF_CloseDocument)                  \
    X(FPDF_GetLastError)                   \
    X(FPDF_GetPageCount)                   \
    X(FPDF_GetDocPermissions)              \
    X(FPDF_GetDocUserPermissions)          \
    X(FPDF_GetSecurityHandlerRevision)     \
    X(FPDF_GetFileVersion)                 \
    X(FPDF_GetPageSizeByIndexF)            \
    X(FPDF_LoadPage)                       \
    X(FPDF_ClosePage)                      \
    X(FPDFPage_GetRotation)                \
    X(FPDFPage_SetRotation)                \
    X(FPDF_PageToDevice)                   \
    X(FPDFPage_CountObjects)               \
    X(FPDFPage_GetObject)                  \
    X(FPDFPage_InsertObjectAtIndex)        \
    X(FPDFPageObj_CreateNewRect)           \
    X(FPDFPageObj_Destroy)                 \
    X(FPDFPageObj_SetFillColor)            \
    X(FPDFPageObj_GetFillColor)            \
    X(FPDFPath_SetDrawMode)                \
    X(FPDFTextObj_GetTextRenderMode)       \
    X(FPDFPageObj_GetType)                 \
    X(FPDFPageObj_GetMatrix)               \
    X(FPDFPageObj_GetBounds)               \
    X(FPDFPageObj_CountMarks)              \
    X(FPDFPageObj_GetMark)                 \
    X(FPDFPageObjMark_GetName)             \
    X(FPDFPageObjMark_GetParamIntValue)    \
    X(FPDFPageObjMark_CountParams)         \
    X(FPDFPageObjMark_GetParamKey)         \
    X(FPDFPageObj_GetClipPath)             \
    X(FPDFClipPath_CountPaths)             \
    X(FPDFClipPath_CountPathSegments)      \
    X(FPDFClipPath_GetPathSegment)         \
    X(FPDFPathSegment_GetPoint)            \
    X(FPDFPathSegment_GetType)             \
    X(FPDFPath_CountSegments)              \
    X(FPDFPath_GetPathSegment)             \
    X(FPDFPage_GetMediaBox)                \
    X(FPDFPage_GetCropBox)                 \
    X(FPDFPage_GetBleedBox)                \
    X(FPDFPage_GetTrimBox)                 \
    X(FPDFPage_GetArtBox)                  \
    X(FPDFFormObj_CountObjects)            \
    X(FPDFFormObj_GetObject)               \
    X(FPDFImageObj_GetImageMetadata)       \
    X(FPDFImageObj_GetImagePixelSize)      \
    X(FPDFImageObj_GetBitmap)              \
    X(FPDFBitmap_GetFormat)                \
    X(FPDFBitmap_GetBuffer)                \
    X(FPDFBitmap_GetWidth)                 \
    X(FPDFBitmap_GetHeight)                \
    X(FPDFBitmap_GetStride)                \
    X(FPDFBitmap_CreateEx)                 \
    X(FPDFBitmap_Destroy)                  \
    X(FPDF_RenderPageBitmap_Start)         \
    X(FPDF_RenderPage_Continue)            \
    X(FPDF_RenderPage_Close)               \
    X(FPDFText_LoadPage)                   \
    X(FPDFText_ClosePage)                  \
    X(FPDFText_CountChars)                 \
    X(FPDFText_GetUnicode)                 \
    X(FPDFText_IsGenerated)                \
    X(FPDFText_IsHyphen)                   \
    X(FPDFText_GetCharBox)                 \
    X(FPDFText_GetLooseCharBox)            \
    X(FPDFText_GetMatrix)                  \
    X(FPDFText_GetCharOrigin)              \
    X(FPDFText_GetFontSize)                \
    X(FPDFText_GetTextObject)              \
    X(FPDFTextObj_GetFont)                 \
    X(FPDFTextObj_GetFontSize)             \
    X(FPDFFont_GetAscent)                  \
    X(FPDFFont_GetDescent)                 \
    X(FPDFFont_GetGlyphWidth)              \
    X(FPDFFont_GetBaseFontName)            \
    X(FPDFLink_Enumerate)                  \
    X(FPDFLink_GetAnnotRect)               \
    X(FPDFLink_GetDest)                    \
    X(FPDFLink_GetAction)                  \
    X(FPDFLink_GetAnnot)                   \
    X(FPDFLink_CountQuadPoints)            \
    X(FPDFLink_GetQuadPoints)              \
    X(FPDFAnnot_GetStringValue)            \
    X(FPDFPage_GetAnnotCount)              \
    X(FPDFPage_GetAnnot)                   \
    X(FPDFAnnot_GetSubtype)                \
    X(FPDFAnnot_GetFlags)                  \
    X(FPDFAnnot_GetRect)                   \
    X(FPDFAnnot_HasKey)                    \
    X(FPDFAnnot_GetValueType)              \
    X(FPDFAnnot_GetFormFieldType)          \
    X(FPDFAnnot_GetFormFieldFlags)         \
    X(FPDFAnnot_GetFormFieldValue)         \
    X(FPDFAnnot_GetAP)                     \
    X(FPDFAnnot_GetFormFieldAlternateName) \
    X(FPDFPage_CloseAnnot)                 \
    X(FPDFAction_GetType)                  \
    X(FPDFAction_GetDest)                  \
    X(FPDFAction_GetURIPath)               \
    X(FPDFAction_GetFilePath)              \
    X(FPDFDest_GetDestPageIndex)           \
    X(FPDFDest_GetLocationInPage)          \
    X(FPDFDest_GetView)                    \
    X(FPDF_GetNamedDestByName)             \
    X(FPDFBookmark_GetFirstChild)          \
    X(FPDFBookmark_GetNextSibling)         \
    X(FPDFBookmark_GetTitle)               \
    X(FPDFBookmark_GetColor)               \
    X(FPDFBookmark_GetStyle)               \
    X(FPDFBookmark_GetDest)                \
    X(FPDFBookmark_GetAction)              \
    X(FPDF_GetMetaText)                    \
    X(FPDF_GetPageLabel)                   \
    X(FPDF_GetFormType)                    \
    X(FPDFDoc_GetJavaScriptActionCount)    \
    X(FPDF_GetSignatureCount)              \
    X(FPDFDoc_GetAttachmentCount)          \
    X(FPDFDOC_InitFormFillEnvironment)     \
    X(FPDFDOC_ExitFormFillEnvironment)     \
    X(FORM_OnAfterLoadPage)                \
    X(FORM_OnBeforeClosePage)              \
    X(FPDF_FFLDraw)                        \
    X(FPDF_GetSignatureObject)             \
    X(FPDFSignatureObj_GetContents)

struct PdfiumFontCache;

struct PdfiumRuntime {
#define DECLARE_PDFIUM(name) decltype(&::name) name = nullptr;
    PDFIUM_API(DECLARE_PDFIUM)
#undef DECLARE_PDFIUM

    bool Acquire(TempStr* error);
    void Release();
    void SetFontCacheDir(Str dir);

  private:
    HMODULE module = nullptr;
    int users = 0;
    FPDF_SYSFONTINFO* defaultFontInfo = nullptr;
    PdfiumFontCache* fontCache = nullptr;
    Str fontCacheDir;

    bool FontCacheEnabled();
    void InstallFontCache();
};

extern Mutex gPdfiumLock;
extern PdfiumRuntime gPdfium;
