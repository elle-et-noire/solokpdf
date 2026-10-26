/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include "base/Base.h"
#include "base/Crypto.h"
#include "base/File.h"
#include "base/Timer.h"
#include <fpdf_sysfontinfo.h>
#include "PdfiumFontCache.h"
#include "SumatraLog.h"

/*
PDFium enumerates installed fonts on the first page that uses a system font. For each localized
family name (e.g. "ＭＳ ゴシック") it opens the font with GDI and reads its 'name' table to learn
the PostScript name; that is ~240 fonts and ~250 ms on a Japanese system.

  PDFium mapper --EnumFonts--> cache --> default EnumFonts --> AddInstalledFont(name)
                                                               | localized name:
       GetFont / MapFont / GetFontData('name') / DeleteFont <--+
                 served from the cache file when it matches the installed fonts

The cache keeps the 'name' table records PDFium reads (nameID 6), byte for byte.
*/

constexpr u32 kTableName = 0x6e616d65; // 'name'
constexpr u16 kPostScriptNameId = 6;
constexpr int kNameHeaderSize = 6;
constexpr int kNameRecordSize = 12;
constexpr u16 kOutOfBoundsOffset = 0xffff;
static const char* kFontsKey = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
static Str kCacheHeader = StrL("SolokPDF PDFium font cache 1");

// what opening a localized family during enumeration produced
struct FontEntry {
    Str name;
    Str table; // filtered 'name' table, empty if the font had none
    bool hasFont = false;
};

struct PdfiumFontCache {
    // first, so PDFium's FPDF_SYSFONTINFO* is also a PdfiumFontCache*
    FPDF_SYSFONTINFO info{};
    FPDF_SYSFONTINFO* def = nullptr;
    Str path;
    Str pdfiumVersion;
    Vec<FontEntry> entries;
    bool inEnum = false;
    bool dirty = false;
    // the family being opened: replayed from its entry (behind kFakeFont), or recorded into it
    FontEntry* current = nullptr;
    bool recording = false;
    void* recordFont = nullptr;
};

// handed to PDFium in place of an HFONT for a cached font; only ever passed back to us
static char gFakeFontTarget;
static void* const kFakeFont = &gFakeFontTarget;

static u16 ReadU16(const u8* p) {
    return (u16)((p[0] << 8) | p[1]);
}

static void AppendU16(str::Builder& b, u16 v) {
    b.AppendChar((char)(v >> 8));
    b.AppendChar((char)(v & 0xff));
}

// The nameID 6 records of a 'name' table in their order, with their strings. PDFium's
// GetNameFromTT reads only those records, so it returns the same name for both tables.
// Malformed tables are kept whole.
static Str FilterNameTable(Str table) {
    const u8* t = (const u8*)table.s;
    int size = len(table);
    if (size < kNameHeaderSize) {
        return str::Dup(table);
    }
    int count = ReadU16(t + 2);
    int stringOffset = ReadU16(t + 4);
    if (size < stringOffset || size - kNameHeaderSize < count * kNameRecordSize) {
        return str::Dup(table);
    }
    int stringSize = size - stringOffset;
    Vec<int> records;
    for (int i = 0; i < count; i++) {
        const u8* r = t + kNameHeaderSize + i * kNameRecordSize;
        if (ReadU16(r + 6) == kPostScriptNameId) {
            VecAppend(records, i);
        }
    }
    int n = len(records);
    str::Builder strings;
    str::Builder res;
    res.Append(Str(table.s, 2)); // format
    AppendU16(res, (u16)n);
    AppendU16(res, (u16)(kNameHeaderSize + n * kNameRecordSize));
    for (int i : records) {
        const u8* r = t + kNameHeaderSize + i * kNameRecordSize;
        int length = ReadU16(r + 8);
        int offset = ReadU16(r + 10);
        res.Append(Str((const char*)r, 8));
        AppendU16(res, (u16)length);
        // an out-of-bounds string stays out of bounds
        if (offset + length > stringSize) {
            AppendU16(res, kOutOfBoundsOffset);
            continue;
        }
        AppendU16(res, (u16)strings.len);
        strings.Append(Str(table.s + stringOffset + offset, length));
    }
    res.Append(ToStrTemp(strings));
    return res.TakeStr();
}

static int CALLBACK HashFontProc(const LOGFONTA* lf, const TEXTMETRICA*, DWORD type, LPARAM param) {
    auto* b = (str::Builder*)param;
    b->Append(Str(lf->lfFaceName));
    b->Append(fmt("|%d|%d\n", (int)lf->lfCharSet, (int)type));
    return 1;
}

static void AppendKeyWriteTime(str::Builder& b, HKEY root) {
    HKEY key = nullptr;
    FILETIME t{};
    if (RegOpenKeyExA(root, kFontsKey, 0, KEY_READ, &key) == ERROR_SUCCESS) {
        RegQueryInfoKeyA(key, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
                         &t);
        RegCloseKey(key);
    }
    b.Append(fmt("%u.%u\n", (u32)t.dwHighDateTime, (u32)t.dwLowDateTime));
}

// Changes when fonts are installed, removed or replaced: GDI's family list (as PDFium enumerates
// it, ~4 ms) and the fonts registry keys' write times.
static TempStr FontSetKeyTemp(PdfiumFontCache* c) {
    str::Builder b;
    b.Append(c->pdfiumVersion);
    b.AppendChar('\n');
    AppendKeyWriteTime(b, HKEY_LOCAL_MACHINE);
    AppendKeyWriteTime(b, HKEY_CURRENT_USER);
    HDC dc = CreateCompatibleDC(nullptr);
    LOGFONTA lf{};
    lf.lfCharSet = DEFAULT_CHARSET;
    EnumFontFamiliesExA(dc, &lf, HashFontProc, (LPARAM)&b, 0);
    DeleteDC(dc);
    u8 digest[16]{};
    CalcMD5Digest(ToStrTemp(b), digest);
    return str::MemToHexTemp(Str((const char*)digest, dimofi(digest)));
}

static void ClearEntries(PdfiumFontCache* c) {
    for (FontEntry& e : c->entries) {
        str::Free(e.name);
        str::Free(e.table);
    }
    VecReset(c->entries);
}

static FontEntry* FindEntry(PdfiumFontCache* c, Str name) {
    for (FontEntry& e : c->entries) {
        if (str::Eq(e.name, name)) {
            return &e;
        }
    }
    return nullptr;
}

static TempStr HexToStrTemp(Str hex) {
    if (len(hex) % 2 != 0) {
        return {};
    }
    char* d = AllocArrayTemp<char>(len(hex) / 2 + 1);
    Str res(d, len(hex) / 2);
    if (!str::HexToMem(hex, res)) {
        return {};
    }
    return res;
}

// File: header line with the key, then "<name hex> <0|1> <table hex>" per entry.
static bool LoadEntries(PdfiumFontCache* c, Str key) {
    ClearEntries(c);
    Str data = file::ReadFile(c->path);
    if (!data.s) {
        return false;
    }
    StrVec lines;
    Split(&lines, data, StrL("\n"), true);
    str::Free(data);
    if (len(lines) < 1 || !str::Eq(lines[0], str::JoinTemp(kCacheHeader, StrL(" "), key))) {
        return false;
    }
    for (int i = 1; i < len(lines); i++) {
        StrVec parts;
        Split(&parts, lines[i], StrL(" "));
        TempStr name = len(parts) == 3 ? HexToStrTemp(parts[0]) : TempStr();
        TempStr table = len(parts) == 3 ? HexToStrTemp(parts[2]) : TempStr();
        if (len(name) == 0 || (len(table) == 0 && len(parts[2]) > 0)) {
            ClearEntries(c);
            return false;
        }
        FontEntry e;
        e.name = str::Dup(name);
        e.table = len(table) > 0 ? str::Dup(table) : Str();
        e.hasFont = str::Eq(parts[1], StrL("1"));
        VecAppend(c->entries, e);
    }
    return true;
}

static void SaveEntries(PdfiumFontCache* c, Str key) {
    str::Builder b;
    b.Append(str::JoinTemp(kCacheHeader, StrL(" "), key));
    b.AppendChar('\n');
    for (FontEntry& e : c->entries) {
        b.Append(str::MemToHexTemp(e.name));
        b.Append(e.hasFont ? StrL(" 1 ") : StrL(" 0 "));
        b.Append(str::MemToHexTemp(e.table));
        b.AppendChar('\n');
    }
    // write aside and rename, so a concurrent reader never sees half a file
    TempStr tmp = str::JoinTemp(c->path, fmt(".%d.tmp", (int)GetCurrentProcessId()));
    if (!file::WriteFile(tmp, ToStrTemp(b)) ||
        !MoveFileExW(CWStrTemp(tmp), CWStrTemp(c->path), MOVEFILE_REPLACE_EXISTING)) {
        logf("PdfiumFontCache: cannot write '%s'\n", c->path);
    }
}

static void CacheEnumFonts(FPDF_SYSFONTINFO* info, void* mapper) {
    auto* c = (PdfiumFontCache*)info;
    TimeStamp start = TimeGet();
    TempStr key = FontSetKeyTemp(c);
    bool replay = LoadEntries(c, key);
    double keyMs = TimeSinceInMs(start);
    c->dirty = !replay;
    c->inEnum = true;
    c->def->EnumFonts(c->def, mapper);
    c->inEnum = false;
    c->current = nullptr;
    c->recording = false;
    c->recordFont = nullptr;
    logf("PdfiumFontCache: %s %d localized fonts in %.1f ms (key and load %.1f ms)\n",
         replay && !c->dirty ? StrL("replayed") : StrL("recorded"), len(c->entries), TimeSinceInMs(start), keyMs);
    if (c->dirty) {
        SaveEntries(c, key);
    }
}

// Enumeration asks GetFont, then MapFont when that fails, for each localized family.
static void* CacheGetFont(FPDF_SYSFONTINFO* info, const char* face) {
    auto* c = (PdfiumFontCache*)info;
    if (!c->inEnum) {
        return c->def->GetFont(c->def, face);
    }
    c->current = FindEntry(c, Str(face));
    c->recording = !c->current;
    c->recordFont = nullptr;
    if (!c->recording) {
        return c->current->hasFont ? kFakeFont : nullptr;
    }
    FontEntry e;
    e.name = str::Dup(Str(face));
    VecAppend(c->entries, e);
    c->current = &VecLast(c->entries);
    c->dirty = true;
    c->recordFont = c->def->GetFont(c->def, face);
    c->current->hasFont = c->recordFont != nullptr;
    return c->recordFont;
}

static void* CacheMapFont(FPDF_SYSFONTINFO* info, int weight, FPDF_BOOL italic, int charset, int pitch,
                          const char* face, FPDF_BOOL* exact) {
    auto* c = (PdfiumFontCache*)info;
    bool enumerating = c->inEnum && c->current && str::Eq(c->current->name, Str(face));
    // a replayed GetFont returns null only for a family that had no font
    if (enumerating && !c->recording) {
        return nullptr;
    }
    void* font = c->def->MapFont(c->def, weight, italic, charset, pitch, face, exact);
    if (enumerating) {
        c->recordFont = font;
        c->current->hasFont = font != nullptr;
    }
    return font;
}

static unsigned long CacheGetFontData(FPDF_SYSFONTINFO* info, void* font, unsigned int table, unsigned char* buffer,
                                      unsigned long size) {
    auto* c = (PdfiumFontCache*)info;
    if (font == kFakeFont) {
        Str t = c->current && table == kTableName ? c->current->table : Str();
        unsigned long n = (unsigned long)len(t);
        if (!buffer || size == 0) {
            return n;
        }
        if (size < n) {
            return 0;
        }
        memcpy(buffer, t.s, n);
        return n;
    }
    unsigned long n = c->def->GetFontData(c->def, font, table, buffer, size);
    bool recording = c->inEnum && c->recording && font && font == c->recordFont && table == kTableName;
    if (recording && buffer && n == size && n > 0) {
        str::Free(c->current->table);
        c->current->table = FilterNameTable(Str((const char*)buffer, (int)n));
    }
    return n;
}

static void CacheDeleteFont(FPDF_SYSFONTINFO* info, void* font) {
    auto* c = (PdfiumFontCache*)info;
    if (font == kFakeFont) {
        return;
    }
    if (font == c->recordFont) {
        c->recordFont = nullptr;
    }
    (c->def->DeleteFont)(c->def, font);
}

// PDFium's FPDF_SYSFONTINFO wrapper keeps a returned trailing NUL as part of the name,
// unlike its built-in font info; drop it so face-name matching stays the same.
static unsigned long CacheGetFaceName(FPDF_SYSFONTINFO* info, void* font, char* buffer, unsigned long size) {
    auto* c = (PdfiumFontCache*)info;
    unsigned long n = c->def->GetFaceName(c->def, font, buffer, size);
    if (buffer && n > 0 && n <= size && buffer[n - 1] == 0) {
        return n - 1;
    }
    return n;
}

static int CacheGetFontCharset(FPDF_SYSFONTINFO* info, void* font) {
    auto* c = (PdfiumFontCache*)info;
    return c->def->GetFontCharset(c->def, font);
}

static void CacheRelease(FPDF_SYSFONTINFO* info) {
    auto* c = (PdfiumFontCache*)info;
    c->def->Release(c->def);
}

PdfiumFontCache* PdfiumFontCacheNew(FPDF_SYSFONTINFO* defaultInfo, Str path, Str pdfiumVersion) {
    auto* c = new PdfiumFontCache();
    c->def = defaultInfo;
    c->path = str::Dup(path);
    c->pdfiumVersion = str::Dup(pdfiumVersion);
    c->info.version = 1;
    c->info.Release = CacheRelease;
    c->info.EnumFonts = CacheEnumFonts;
    c->info.MapFont = CacheMapFont;
    c->info.GetFont = CacheGetFont;
    c->info.GetFontData = CacheGetFontData;
    c->info.GetFaceName = CacheGetFaceName;
    c->info.GetFontCharset = CacheGetFontCharset;
    c->info.DeleteFont = CacheDeleteFont;
    return c;
}

FPDF_SYSFONTINFO* PdfiumFontCacheInfo(PdfiumFontCache* c) {
    return &c->info;
}

void PdfiumFontCacheDelete(PdfiumFontCache* c) {
    if (!c) {
        return;
    }
    ClearEntries(c);
    str::Free(c->path);
    str::Free(c->pdfiumVersion);
    delete c;
}
