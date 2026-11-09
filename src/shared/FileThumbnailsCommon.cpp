/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/Crypto.h"
#include "base/File.h"
#include "base/GuessFileType.h"
#include "base/Pixmap.h"
#include "Settings.h"
#include "AppSettings.h"
#include "ImageReader.h"
#include "PdfDarkMode.h"
#include "AppTools.h"
#include "FileThumbnails.h"
#include "FileThumbnailsCommon.h"

constexpr u32 kThumbnailSidecarMagic = 0x31435453;
constexpr u32 kThumbnailSidecarVersion = 1;
constexpr u32 kMaxThumbnailSkipRects = 4096;

struct ThumbnailSidecar {
    u32 magic = kThumbnailSidecarMagic;
    u32 version = kThumbnailSidecarVersion;
    u32 engineClass = 0;
    u32 width = 0;
    u32 height = 0;
    u32 rectCount = 0;
};

struct ThumbnailColorData {
    ViewEngineClass engineClass = ViewEngineClass::Image;
    Vec<Rect> skipRects;
    Pixmap* colored = nullptr;
    u32 hash = 0;

    ~ThumbnailColorData() { FreePixmap(colored); }
};

static ThumbnailColorData* ColorData(FileState* fs) {
    return (ThumbnailColorData*)fs->thumbnailColorData;
}

void FreeThumbnailColorData(FileState* fs) {
    if (!fs) {
        return;
    }
    delete ColorData(fs);
    fs->thumbnailColorData = nullptr;
}

void FreeThumbnailData(FileState* fs) {
    if (!fs) {
        return;
    }
    FreePixmap(fs->thumbnail);
    fs->thumbnail = nullptr;
    FreeThumbnailColorData(fs);
}

TempStr GetThumbnailSidecarPathTemp(Str filePath) {
    TempStr png = GetThumbnailPathTemp(filePath);
    return len(png) > 0 ? str::JoinTemp(png, StrL(".theme")) : TempStr();
}

static ThumbnailColorData* ReadColorData(FileState* fs) {
    auto* color = new ThumbnailColorData();
    bool valid = false;
    TempStr path = GetThumbnailSidecarPathTemp(fs->filePath);
    Str data = file::ReadFile(path);
    if (len(data) >= (int)sizeof(ThumbnailSidecar)) {
        ThumbnailSidecar header;
        memcpy(&header, data.s, sizeof(header));
        valid = header.magic == kThumbnailSidecarMagic && header.version == kThumbnailSidecarVersion &&
                header.engineClass <= (u32)ViewEngineClass::Captured && header.width == (u32)fs->thumbnail->width &&
                header.height == (u32)fs->thumbnail->height && header.rectCount <= kMaxThumbnailSkipRects &&
                len(data) == (int)(sizeof(header) + header.rectCount * sizeof(Rect));
        if (valid) {
            color->engineClass = (ViewEngineClass)header.engineClass;
            VecAppendBlanks(color->skipRects, header.rectCount);
            if (header.rectCount > 0) {
                memcpy(color->skipRects.els, data.s + sizeof(header), header.rectCount * sizeof(Rect));
            }
        }
    }
    if (!valid) {
        FileType type = GuessFileTypeFromName(fs->filePath);
        if (type == FileType::PDF) {
#if defined(SOLOKPDF_PDFIUM) && !defined(SUMATRA_NG)
            color->engineClass = ViewEngineClass::Pdfium;
#else
            color->engineClass = ViewEngineClass::Mupdf;
#endif
        } else if (type == FileType::Epub || type == FileType::Mobi || type == FileType::Fb2 ||
                   type == FileType::Fb2z || type == FileType::PalmDoc) {
            color->engineClass = ViewEngineClass::Reflowable;
        } else if (type == FileType::DjVu || type == FileType::Chm || type == FileType::Xps) {
            color->engineClass = ViewEngineClass::Fixed;
        }
    }
    str::Free(data);
    return color;
}

Pixmap* ColoredThumbnail(FileState* fs) {
    Pixmap* neutral = LoadThumbnail(fs);
    if (!neutral) {
        return nullptr;
    }
    if (!fs->thumbnailColorData) {
        fs->thumbnailColorData = ReadColorData(fs);
    }
    auto* color = ColorData(fs);
    const PageColorInput colors = CapturePageColors();
    DarkModeProfile profile;
    BuildViewDarkModeProfile(color->engineClass, colors, &profile);
    ViewPageOptions options;
    options.grayscale = gSettings->fixedPageUI.grayscale;
    options.brightness = fs->brightness;
    options.contrast = fs->contrast;
    PageColorPass colorPass = GetPageColorPass(color->engineClass, PageColorSource::Bitmap, profile);
    if (colorPass == PageColorPass::None && !options.grayscale && options.brightness == 0 && options.contrast == 0) {
        return neutral;
    }
    u32 hash = profile.hash;
    hash = hash * 31 + (u32)options.grayscale;
    hash = hash * 31 + (u32)options.brightness;
    hash = hash * 31 + (u32)options.contrast;
    if (color->colored && color->hash == hash) {
        return color->colored;
    }
    FreePixmap(color->colored);
    color->colored = ClonePixmap(neutral);
    color->hash = hash;
    color->colored = ApplyViewPageAdjust(color->colored, options);
    if (colorPass == PageColorPass::Bitmap && color->colored && !color->colored->hasAlpha) {
        Vec<Rect>* skip =
            profile.mode == PageColorMode::PreserveImages && profile.preservePdfImages && len(color->skipRects) > 0
                ? &color->skipRects
                : nullptr;
        RecolorPixmap(color->colored, profile.foreground, profile.pageBackground, profile.linkColor, skip);
    }
    return color->colored ? color->colored : neutral;
}

TempStr GetThumbnailPathTemp(Str filePath) {
    // create a fingerprint of a (normalized) path for the file name
    // I'd have liked to also include the file's last modification time
    // in the fingerprint (much quicker than hashing the entire file's
    // content), but that's too expensive for files on slow drives
    u8 digest[16]{};
    // Null/empty paths show up when a FileState has no path (corrupt settings
    // or a race while closing); never hash an empty path (crash e.g. 35043).
    if (len(filePath) == 0) {
        return {};
    }
    TempStr path = str::DupTemp(filePath);
    if (path::HasVariableDriveLetter(path)) {
        // ignore the drive letter, if it might change
        path.s[0] = '?';
    }
    CalcMD5Digest(path, digest);
    TempStr fingerPrint = str::MemToHexTemp(Str((const char*)digest, dimofi(digest)));

    TempStr thumbsDir = GetThumbnailCacheDirTemp();
    if (len(thumbsDir) == 0) {
        return {};
    }

    TempStr res = path::JoinTemp(thumbsDir, str::JoinTemp(fingerPrint, StrL(".png")));
    return res;
}

TempStr GetThumbnailCacheDirTemp() {
    TempStr thumbsDir = GetPathInAppDataDirTemp(StrL("sumatrapdfcache"));
    return thumbsDir;
}

// Empty rather than remove: SaveThumbnail runs on the UI thread and re-creates
// this directory, so deleting it out from under a save in flight made
// dir::CreateAll fail (crash 2026-08-05/8c3bf9e1f000001).
void EmptyThumbnailCacheDirectory() {
    TempStr thumbsDir = GetThumbnailCacheDirTemp();
    dir::Empty(thumbsDir);
}

void DeleteThumbnailForFile(Str filePath) {
    TempStr thumbPath = GetThumbnailPathTemp(filePath);
    if (len(thumbPath) == 0) {
        return;
    }
    bool ok = file::Delete(thumbPath);
    file::Delete(GetThumbnailSidecarPathTemp(filePath));
    const auto* status = ok ? "ok" : "failed";
    logf("DeleteThumbnailForFile: file::Remove('%s') %s\n", thumbPath, Str(status));
}

bool PixmapIsEmpty(const Pixmap* px) {
    return !px || px->width <= 0 || px->height <= 0 || !px->data;
}

#if defined(SUMATRA_NG)
constexpr bool kThumbnailsFullPageDefault = true;
#else
constexpr bool kThumbnailsFullPageDefault = false;
#endif

// ThumbnailsType: full (the whole first page) or legacy (the top of it);
// anything else is the app's default
bool ThumbnailsAreFullPage() {
    Str type = gSettings ? gSettings->thumbnailsType : Str();
    if (str::EqI(type, StrL("full"))) {
        return true;
    }
    if (str::EqI(type, StrL("legacy"))) {
        return false;
    }
    return kThumbnailsFullPageDefault;
}

Size ThumbnailFrameSize() {
    if (ThumbnailsAreFullPage()) {
        return Size(kThumbnailFullDx, kThumbnailFullDy);
    }
    return Size(kThumbnailLegacyDx, kThumbnailLegacyDy);
}

// the size a thumbnail is drawn at: scaled to fit the frame, keeping its aspect
Size ThumbnailDrawSize(Size thumb, Size frame) {
    if (thumb.dx <= 0 || thumb.dy <= 0) {
        return frame;
    }
    int dx = frame.dx;
    int dy = thumb.dy * dx / thumb.dx;
    if (dy > frame.dy) {
        dy = frame.dy;
        dx = thumb.dx * dy / thumb.dy;
    }
    return Size(dx, dy);
}

// a legacy thumbnail is as wide as its frame, a full one fits inside its frame
bool ThumbnailSizeMatchesType(Size sz) {
    if (sz.dx <= 0 || sz.dy <= 0) {
        return false;
    }
    if (ThumbnailsAreFullPage()) {
        return sz.dx <= kThumbnailFullDx && sz.dy <= kThumbnailFullDy;
    }
    return sz.dx == kThumbnailLegacyDx && sz.dy <= kThumbnailLegacyDy;
}

// width and height from the IHDR chunk that follows the 8-byte signature;
// empty if the data isn't a PNG
Size PngSizeFromData(Str data) {
    constexpr int kIhdrEnd = 24;
    static const u8 kSignature[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
    if (len(data) < kIhdrEnd || memcmp(data.s, kSignature, sizeof(kSignature)) != 0) {
        return {};
    }
    auto be32 = [](const u8* p) -> u32 { return ((u32)p[0] << 24) | ((u32)p[1] << 16) | ((u32)p[2] << 8) | (u32)p[3]; };
    const u8* s = (const u8*)data.s;
    u32 width = be32(s + 16);
    u32 height = be32(s + 20);
    // PNG dimensions must be positive and fit within a signed int.
    if (width == 0 || height == 0 || width > 0x7fffffffU || height > 0x7fffffffU) {
        return {};
    }
    return Size((int)width, (int)height);
}

Pixmap* LoadThumbnail(FileState* fs) {
    if (!fs || len(fs->filePath) == 0) {
        return nullptr;
    }
    if (fs->thumbnail) {
        return fs->thumbnail;
    }
    TempStr bmpPath = GetThumbnailPathTemp(fs->filePath);
    if (len(bmpPath) == 0) {
        return nullptr;
    }

    Str data = file::ReadFile(bmpPath);
    if (len(data) == 0) {
        return nullptr;
    }
    // 24bpp: thumbnails stay in memory for every Home entry shown
    Pixmap* px = PixmapToBgr(PixmapFromData(data));
    str::Free(data);
    if (PixmapIsEmpty(px)) {
        FreePixmap(px);
        return nullptr;
    }
    // made for the other ThumbnailsType: as good as missing, re-created the
    // next time the document is opened
    if (!ThumbnailSizeMatchesType(Size(px->width, px->height))) {
        FreePixmap(px);
        DeleteThumbnailForFile(fs->filePath);
        return nullptr;
    }

    fs->thumbnail = px;
    return fs->thumbnail;
}

bool HasThumbnail(FileState* fs) {
    if (!fs || len(fs->filePath) == 0) {
        return false;
    }
    // Prefer the in-memory thumbnail; only hit disk when missing.
    if (!fs->thumbnail && !LoadThumbnail(fs)) {
        return false;
    }

    TempStr bmpPath = GetThumbnailPathTemp(fs->filePath);
    if (len(bmpPath) == 0) {
        return fs->thumbnail != nullptr;
    }
    FILETIME bmpTime = file::GetModificationTime(bmpPath);
    FILETIME fileTime = file::GetModificationTime(fs->filePath);
    // delete the thumbnail if the file is newer than the thumbnail
    if (FileTimeDiffInSecs(fileTime, bmpTime) > 0) {
        FreeThumbnailData(fs);
        DeleteThumbnailForFile(fs->filePath);
        HomePageThumbnailChanged(fs);
    }

    return fs->thumbnail != nullptr;
}

void RemoveThumbnail(FileState* fs) {
    if (!fs || len(fs->filePath) == 0) {
        return;
    }
    DeleteThumbnailForFile(fs->filePath);
    FreeThumbnailData(fs);
    HomePageThumbnailChanged(fs);
}

// takes ownership of bmp
void SetThumbnail(FileState* fs, Pixmap* bmp, ViewEngineClass engineClass, const Vec<Rect>* skipRects) {
    ReportIf(bmp && PixmapIsEmpty(bmp));
    if (!fs || len(fs->filePath) == 0 || PixmapIsEmpty(bmp)) {
        FreePixmap(bmp);
        return;
    }
    FreeThumbnailData(fs);
    fs->thumbnail = PixmapToBgr(bmp);
    auto* color = new ThumbnailColorData();
    color->engineClass = engineClass;
    if (skipRects) {
        color->skipRects = *skipRects;
    }
    fs->thumbnailColorData = color;
    SaveThumbnail(fs);
    HomePageThumbnailChanged(fs);
}

void SetThumbnail(FileState* fs, Pixmap* bmp) {
    SetThumbnail(fs, bmp, ViewEngineClass::Image);
}

void SaveThumbnailSidecar(FileState* fs) {
    if (!fs || !fs->thumbnail || !fs->thumbnailColorData) {
        return;
    }
    auto* color = ColorData(fs);
    ThumbnailSidecar header;
    header.engineClass = (u32)color->engineClass;
    header.width = fs->thumbnail->width;
    header.height = fs->thumbnail->height;
    header.rectCount = len(color->skipRects);
    str::Builder data;
    data.Append(Str((const char*)&header, sizeof(header)));
    data.Append(Str((const char*)color->skipRects.els, header.rectCount * sizeof(Rect)));
    TempStr path = GetThumbnailSidecarPathTemp(fs->filePath);
    TempStr tmp = str::JoinTemp(path, StrL(".tmp"));
    if (!file::WriteFile(tmp, Str(data.els, len(data))) || !file::RenameReplace(path, tmp)) {
        file::Delete(tmp);
    }
}
