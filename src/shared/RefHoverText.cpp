/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

// Plain-text citation hover for PDFs without hyperref links: the engine-driven
// page walk and the per-document lookup cache that sit on top of the pure
// pattern matchers in RefHoverTextDetect. Split out of RefHover so the popup
// UI / render machinery stays separate from the citation-resolution logic.

#include "base/Base.h"

#include "gui/UIModels.h"

#include "DocController.h"
#include "EngineBase.h"
#include "RefHover.h"

TempWStr RefHoverPageTextToWStrTemp(Str text) {
    int nCodepoints = Utf8CodepointCount(text);
    WCHAR* dst = AllocArrayTemp<WCHAR>(nCodepoints + 1);
    int byteIdx = 0;
    for (int i = 0; i < nCodepoints; i++) {
        int rune = Utf8CodepointNext(text, byteIdx);
        dst[i] = rune > 0xffff ? L'?' : (WCHAR)rune;
    }
    dst[nCodepoints] = 0;
    return WStr(dst, nCodepoints);
}

// === Plain-text citation lookup cache ===
// Keyed by (surname, year, srcPage) so the same citation hovered repeatedly
// is resolved instantly. Negative results (citation not found) are also
// cached to avoid re-scanning the document on each hover.
struct CitationCacheEntry {
    Str surname; // owned UTF-8
    int year;
    int srcPage;  // page where the lookup was issued (so cap at srcPage works per-page)
    int destPage; // -1 if not found
    float destX;
    float destY;
    // > 0: the walk stopped at this page, its text not extracted yet; it resumes there
    int scanFrom = 0;
};

struct RefLookupCache {
    Vec<CitationCacheEntry> entries;

    ~RefLookupCache() {
        for (const auto& entry : entries) {
            str::Free(entry.surname);
        }
    }
};

// Free the lazy-init plain-text lookup cache held on the hover state.
void RefHoverFreeLookupCache(RefHoverState* s) {
    if (!s) {
        return;
    }
    delete s->lookupCache;
    s->lookupCache = nullptr;
}

enum class CitationKind {
    AuthorYear,
    Number
};

// pages whose extraction a waiting walk starts beyond the one it waits for
constexpr int kTextReadAhead = 3;

// A page's text. NoWait never extracts on this thread: busy until a background
// extraction (started then) has it.
static PageHit<Str> PageTextAt(EngineBase* engine, int pageNo, EngineWait wait, int* lenOut, Rect** coordsOut) {
    if (wait == EngineWait::Wait) {
        return {engine->GetTextForPage(pageNo, lenOut, coordsOut), false};
    }
    return engine->CachedTextForPage(pageNo, lenOut, coordsOut);
}

// Walk pages from pageCount (or where a busy walk stopped) → srcPage looking for
// a bibliography entry that matches the surname + year. Busy at the first page
// whose text isn't ready; the next pages' extraction starts too.
static PageHit<bool> FindReferenceLocation(EngineBase* engine, Str surname, CitationKind kind, EngineWait wait,
                                           CitationCacheEntry* entry) {
    int srcPage = entry->srcPage;
    int pageCount = engine ? engine->PageCount() : 0;
    int from = entry->scanFrom > 0 && entry->scanFrom <= pageCount ? entry->scanFrom : pageCount;
    entry->scanFrom = 0;
    if (!engine || len(surname) == 0 || pageCount <= 0 || srcPage < 1 || srcPage > pageCount) {
        return {};
    }

    TempWStr surnameW = kind == CitationKind::AuthorYear ? ToWStrTemp(surname) : TempWStr{};
    if (kind == CitationKind::AuthorYear && len(surnameW) < 2) {
        return {};
    }
    for (int p = from; p >= srcPage; p--) {
        int textLen = 0;
        Rect* coords = nullptr;
        PageHit<Str> textUtf8 = PageTextAt(engine, p, wait, &textLen, &coords);
        if (textUtf8.busy) {
            for (int ahead = p - 1; ahead >= srcPage && ahead >= p - kTextReadAhead; ahead--) {
                engine->CachedTextForPage(ahead);
            }
            entry->scanFrom = p;
            return {false, true};
        }
        TempWStr text = RefHoverPageTextToWStrTemp(textUtf8.value);
        float x = 0, y = 0;
        bool found = kind == CitationKind::Number
                         ? FindNumericReferenceInPageText(text, coords, textLen, entry->year, &x, &y)
                         : FindSurnameInPageText(text, coords, textLen, surnameW, entry->year, &x, &y);
        if (found) {
            entry->destPage = p;
            entry->destX = x;
            entry->destY = y;
            return {true, false};
        }
    }
    return {};
}

// Cache hits, misses and where a busy walk stopped; only successful lookups change the outputs.
static PageHit<bool> LookupOrSearch(RefHoverState* s, EngineBase* engine, int srcPage, Str surname, int year,
                                    CitationKind kind, EngineWait wait, int& destPageOut, float& destXOut,
                                    float& destYOut) {
    auto& entries = s->lookupCache->entries;
    CitationCacheEntry* hit = nullptr;
    for (auto& entry : entries) {
        if (entry.year == year && entry.srcPage == srcPage && str::Eq(entry.surname, surname)) {
            hit = &entry;
            break;
        }
    }
    if (!hit) {
        int pageCount = engine->PageCount();
        if (kind == CitationKind::Number && (pageCount <= 0 || srcPage < 1 || srcPage > pageCount)) {
            return {};
        }
        CitationCacheEntry entry{str::Dup(surname), year, srcPage, -1, 0.f, 0.f};
        VecAppend(entries, entry);
        hit = &VecLast(entries);
        hit->scanFrom = pageCount;
    }
    if (hit->scanFrom > 0) {
        PageHit<bool> found = FindReferenceLocation(engine, surname, kind, wait, hit);
        if (found.busy) {
            return found;
        }
    }
    if (hit->destPage <= 0) {
        return {};
    }
    destPageOut = hit->destPage;
    destXOut = hit->destX;
    destYOut = hit->destY;
    return {true, false};
}

// ng's hover: waits for the pages' text
bool RefHoverTryPlainText(RefHoverState* s, EngineBase* engine, int srcPage, Point pagePos, int& destPageOut,
                          float& destXOut, float& destYOut, RectF& srcRectOut) {
    return RefHoverPlainTextAt(s, engine, srcPage, pagePos, destPageOut, destXOut, destYOut, srcRectOut,
                               EngineWait::Wait)
        .value;
}

// Resolve numeric or author-year citations, caching hits and misses.
// Keep source bounds so separate occurrences get separate hover popups.
// NoWait: busy until the pages' text is extracted in the background.
PageHit<bool> RefHoverPlainTextAt(RefHoverState* s, EngineBase* engine, int srcPage, Point pagePos, int& destPageOut,
                                  float& destXOut, float& destYOut, RectF& srcRectOut, EngineWait wait) {
    if (!s || !engine || srcPage <= 0) {
        return {};
    }
    Rect srcRect{};

    if (!s->lookupCache) {
        s->lookupCache = new RefLookupCache();
    }

    int textLen = 0;
    Rect* coords = nullptr;
    PageHit<Str> srcText = PageTextAt(engine, srcPage, wait, &textLen, &coords);
    if (srcText.busy) {
        return {false, true};
    }
    TempWStr text = RefHoverPageTextToWStrTemp(srcText.value);

    // Try bracketed numbers before ambiguous author-year citations.
    int num = 0;
    if (DetectNumericCitationInPageText(text, coords, textLen, pagePos, &num, &srcRect)) {
        // Numeric keys cannot collide with surnames.
        PageHit<bool> found = LookupOrSearch(s, engine, srcPage, fmt("[%d]", num), num, CitationKind::Number, wait,
                                             destPageOut, destXOut, destYOut);
        if (found.value) {
            srcRectOut = ToRectF(srcRect);
        }
        if (found.value || found.busy) {
            return found;
        }
    }

    Str surname;
    int year = 0;
    if (!DetectCitationInPageText(text, coords, textLen, pagePos, &surname, &year, &srcRect)) {
        return {};
    }

    PageHit<bool> found = LookupOrSearch(s, engine, srcPage, surname, year, CitationKind::AuthorYear, wait, destPageOut,
                                         destXOut, destYOut);

    // Fallback: if surname has multiple space-separated parts and the full
    // form didn't match, try each part as a prefix in descending-length
    // order. Two patterns this covers:
    //   1. Bibliography lists the entry under just the last name
    //      ("Vrielink, Oude R. A." vs. detected "Oude Vrielink").
    //   2. PDF text extraction split a single-word surname by dropping a
    //      glyph ("Bash b" for "Bashab") — the longest fragment ("Bash")
    //      prefix-matches the real surname in the bibliography.
    if (!found.value && !found.busy && str::ContainsChar(surname, ' ')) {
        constexpr int kMaxParts = 8;
        Str parts[kMaxParts];
        int nParts = 0;
        Str rest = surname;
        while (len(rest) > 0 && nParts < kMaxParts) {
            Str part;
            str::CutChar(rest, ' ', &part, &rest);
            if (len(part) >= 2) {
                parts[nParts++] = part;
            }
        }
        // Sort parts by length descending (simple selection sort, n<=8).
        for (int i = 0; i < nParts - 1; i++) {
            for (int j = i + 1; j < nParts; j++) {
                if (len(parts[j]) > len(parts[i])) {
                    std::swap(parts[i], parts[j]);
                }
            }
        }
        for (int i = 0; i < nParts && !found.value && !found.busy; i++) {
            found = LookupOrSearch(s, engine, srcPage, parts[i], year, CitationKind::AuthorYear, wait, destPageOut,
                                   destXOut, destYOut);
        }
    }

    if (found.value) {
        srcRectOut = ToRectF(srcRect);
    }
    str::Free(surname);
    return found;
}

// Extract the source link text and find its matching anchor on destPage.
// Best only tries the highest-ranked candidate to avoid common-word matches.
float RefHoverResolveDestYFromSourceText(EngineBase* engine, int srcPage, RectF srcRect, int destPage,
                                         RefHoverTextMatch match) {
    if (srcPage <= 0 || destPage <= 0 || srcRect.dx <= 0.f || srcRect.dy <= 0.f) {
        return -1.f;
    }
    int srcLen = 0;
    Rect* srcCoords = nullptr;
    Str srcTextUtf8 = engine->GetTextForPage(srcPage, &srcLen, &srcCoords);
    TempWStr srcText = RefHoverPageTextToWStrTemp(srcTextUtf8);
    if (len(srcText) == 0 || srcLen <= 0 || !srcCoords) {
        return -1.f;
    }
    int srcL = (int)srcRect.x - 2;
    int srcT = (int)srcRect.y - 2;
    int srcR = (int)(srcRect.x + srcRect.dx) + 2;
    int srcB = (int)(srcRect.y + srcRect.dy) + 2;

    WCHAR rawText[512];
    int rawLen = 0;
    for (int i = 0; i < srcLen && rawLen < 511; i++) {
        Rect r = srcCoords[i];
        if (r.x + r.dx < srcL || r.x > srcR) {
            continue;
        }
        if (r.y + r.dy < srcT || r.y > srcB) {
            continue;
        }
        rawText[rawLen++] = srcText.s[i];
    }

    auto isAlnum = [](WCHAR c) {
        return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9');
    };
    auto lowerAscii = [](WCHAR c) { return c >= L'A' && c <= L'Z' ? (WCHAR)(c + L'a' - L'A') : c; };

    struct Cand {
        int start;
        int len;
        bool flanked;
    };
    constexpr int kMaxCands = 16;
    Cand cands[kMaxCands];
    int ncands = 0;
    for (int i = 0; i < rawLen && ncands < kMaxCands;) {
        if (!isAlnum(rawText[i])) {
            i++;
            continue;
        }
        int start = i;
        while (i < rawLen && isAlnum(rawText[i])) {
            i++;
        }
        int count = i - start;
        if (count < 2) {
            continue;
        }
        bool flanked = start > 0 && rawText[start - 1] == L'(' && i < rawLen && rawText[i] == L')';
        cands[ncands++] = {start, count, flanked};
    }
    if (ncands == 0) {
        return -1.f;
    }
    for (int i = 0; i < ncands - 1; i++) {
        for (int j = i + 1; j < ncands; j++) {
            bool swap = (cands[j].flanked && !cands[i].flanked) ||
                        (cands[j].flanked == cands[i].flanked && cands[j].len > cands[i].len);
            if (swap) {
                std::swap(cands[i], cands[j]);
            }
        }
    }

    int destLen = 0;
    Rect* destCoords = nullptr;
    Str destTextUtf8 = engine->GetTextForPage(destPage, &destLen, &destCoords);
    TempWStr destText = RefHoverPageTextToWStrTemp(destTextUtf8);
    if (len(destText) == 0 || destLen <= 0 || !destCoords) {
        return -1.f;
    }
    auto isLineStartMatch = [&](int idx) -> bool {
        int sy = destCoords[idx].y;
        int sx = destCoords[idx].x;
        for (int i = 0; i < destLen; i++) {
            if (i == idx || destCoords[i].y != sy) {
                continue;
            }
            if (IsGlyphSpace(destText.s[i])) {
                continue;
            }
            if (destCoords[i].x < sx) {
                return false;
            }
        }
        return true;
    };

    for (int ci = 0; ci < ncands; ci++) {
        int bestStart = cands[ci].start;
        int bestLen = cands[ci].len;
        auto matchAt = [&](int idx) -> bool {
            if (idx + bestLen > destLen) {
                return false;
            }
            for (int j = 0; j < bestLen; j++) {
                if (lowerAscii(destText.s[idx + j]) != lowerAscii(rawText[bestStart + j])) {
                    return false;
                }
            }
            if (idx > 0 && isAlnum(destText.s[idx - 1])) {
                return false;
            }
            if (idx + bestLen < destLen && isAlnum(destText.s[idx + bestLen])) {
                return false;
            }
            return true;
        };

        Point lineStart{INT_MAX, -1};
        Point other{INT_MAX, -1};
        for (int i = 0; i < destLen; i++) {
            if (!matchAt(i)) {
                continue;
            }
            Rect r = destCoords[i];
            Point& best = isLineStartMatch(i) ? lineStart : other;
            if (r.x < best.x) {
                best = Point(r.x, r.y);
            }
        }
        int bestY = lineStart.y >= 0 ? lineStart.y : other.y;
        if (bestY >= 0) {
            return (float)bestY;
        }
        if (match == RefHoverTextMatch::Best) {
            break;
        }
    }
    return -1.f;
}
