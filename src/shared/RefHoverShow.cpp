/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "gui/Dpi.h"

#include "gui/UIModels.h"

#include "DocController.h"
#include "EngineBase.h"
#include "Settings.h"
#include "DisplayModel.h"
#include "RefHover.h"

enum class MissingEntry {
    Empty,
    Landscape,
};

// the page's text with watermark glyphs dropped and glyphs snapped to lines
static PageHit<WStr> RegionTextTemp(EngineBase* engine, int pageNo, EngineWait wait, Rect** coordsOut) {
    Rect* coords = nullptr;
    int textLen = 0;
    PageHit<Str> textUtf8 = RefHoverTextAt(engine, pageNo, wait, &textLen, &coords);
    if (textUtf8.busy) {
        return {{}, true};
    }
    TempWStr text = RefHoverPageTextToWStrTemp(textUtf8.value);
    *coordsOut = coords;
    if (!coords || len(text) == 0) {
        return {text, false};
    }
    WCHAR* cleanText = AllocArrayTemp<WCHAR>(textLen);
    Rect* cleanCoords = AllocArrayTemp<Rect>(textLen);
    int cleanLen = StripWatermarkGlyphs(text, coords, cleanText, cleanCoords);
    Rect* normCoords = AllocArrayTemp<Rect>(cleanLen);
    NormalizeGlyphLines(cleanCoords, normCoords, cleanLen);
    *coordsOut = normCoords;
    return {WStr(cleanText, cleanLen), false};
}

static PageHit<RectF> DetectNoteRegion(EngineBase* engine, int pageNo, RectF mediabox, float destY, EngineWait wait) {
    AutoArenaSavepoint tempScope;
    Rect* coords = nullptr;
    auto text = RegionTextTemp(engine, pageNo, wait, &coords);
    if (text.busy) {
        return {{}, true};
    }
    return {NoteBox(mediabox, destY, text.value, coords), false};
}

static PageHit<RectF> DetectRegion(EngineBase* engine, int pageNo, RectF mediabox, float destX, float destY,
                                   RectF* continuation, MissingEntry missingEntry, EngineWait wait) {
    AutoArenaSavepoint tempScope;

    Rect* normCoords = nullptr;
    auto result = RegionTextTemp(engine, pageNo, wait, &normCoords);
    if (result.busy) {
        return {{}, true};
    }
    WStr text = result.value;

    RectF region = DetectEquationBox(text, normCoords, mediabox, destX, destY);
    if (region.dx <= 0.f || region.dy <= 0.f) {
        region = DetectEntryBox(text, normCoords, mediabox, destX, destY, continuation);
    }
    if ((region.dx <= 0.f || region.dy <= 0.f) && missingEntry == MissingEntry::Landscape) {
        region = LandscapeBox(mediabox, destX, destY, text, normCoords);
    }
    return {region, false};
}

// Returns false while a page's text is being extracted in the background.
bool RefHoverOnTimer(RefHoverState* s, EngineBase* engine, float pageZoom, DisplayModel* dm) {
    if (!s || !engine || s->pending.destPage <= 0) {
        return true;
    }
    EngineWait wait = dm ? EngineWait::NoWait : EngineWait::Wait;
    auto mediaBox = [&](int pageNo) {
        if (!dm) {
            return engine->PageMediabox(pageNo);
        }
        PageInfo* page = dm->GetPageInfo(pageNo);
        return page && !page->mediaBox.IsEmpty() ? page->mediaBox : dm->estimatedMediaBox;
    };
    int destPage = s->pending.destPage;
    float destX = s->pending.destX;
    float destY = s->pending.destY;

    RectF mediabox = mediaBox(destPage);
    if (mediabox.dx <= 0.f || mediabox.dy <= 0.f) {
        return true;
    }
    if (destY <= 0.f || destY >= mediabox.dy - 1.f) {
        destY = 0.f;
        auto resolved = RefHoverDestY(engine, s->pending.srcPage, s->pending.srcRect, destPage, wait);
        if (resolved.busy) {
            return false;
        }
        if (resolved.value >= 0.f) {
            destY = resolved.value;
            destX = std::max(destX, 0.f);
        }
    }

    float linkZoom = s->pending.destZoom;
    bool useLinkZoom = (linkZoom > 0.f);
    if (useLinkZoom && pageZoom > linkZoom) {
        linkZoom = pageZoom;
    }

    RectF region;
    // Set when a bracket-style entry wraps across a 2-column page break (e.g.
    // "[63]"): a second crop, stitched below `region` in the delivered
    // bitmap. Empty (dx/dy <= 0) otherwise.
    RectF continuation{};
    PageHit<RectF> note;
    if (s->pending.noteRef) {
        note = DetectNoteRegion(engine, destPage, mediabox, destY, wait);
        if (note.busy) {
            return false;
        }
    }
    if (!note.value.IsEmpty()) {
        region = note.value;
    } else if (useLinkZoom) {
        region = RectF{0.f, destY, mediabox.dx, mediabox.dy - destY};
    } else {
        auto entry = DetectRegion(engine, destPage, mediabox, destX, destY, &continuation, MissingEntry::Empty, wait);
        if (entry.busy) {
            return false;
        }
        region = entry.value;
        bool regionEmpty = region.dx <= 0.f || region.dy <= 0.f;
        bool searchNext = regionEmpty || ShouldSearchNextPage(mediabox, destY);
        if (searchNext && !regionEmpty) {
            auto current =
                RefHoverDestY(engine, s->pending.srcPage, s->pending.srcRect, destPage, wait, RefHoverTextMatch::Best);
            if (current.busy) {
                return false;
            }
            searchNext = current.value < 0.f;
        }

        float nextY = -1.f;
        if (searchNext) {
            int nextPage = destPage + 1;
            if (nextPage <= engine->PageCount()) {
                auto next = RefHoverDestY(engine, s->pending.srcPage, s->pending.srcRect, nextPage, wait,
                                          RefHoverTextMatch::Best);
                if (next.busy) {
                    return false;
                }
                nextY = next.value;
            }
            if (nextY >= 0.f) {
                destPage = nextPage;
                destY = nextY;
                destX = std::max(destX, 0.f);
                mediabox = mediaBox(destPage);
            }
        }
        if (regionEmpty || nextY >= 0.f) {
            auto fallback =
                DetectRegion(engine, destPage, mediabox, destX, destY, &continuation, MissingEntry::Landscape, wait);
            if (fallback.busy) {
                return false;
            }
            region = fallback.value;
        }
    }
    if (s->hitEngine != engine) {
        if (s->hitEngine) {
            s->hitEngine->Release();
        }
        s->hitEngine = engine;
        engine->AddRef();
    }
    bool hasContinuation = continuation.dx > 0.f && continuation.dy > 0.f;
    s->displayed.userZoom = 1.f;
    float baseZoom = kRefHoverRenderZoom;
    if (useLinkZoom) {
        baseZoom = linkZoom;
    } else if (pageZoom > 0.f) {
        baseZoom = pageZoom;
    }

    int popupWCap = RefHoverPopupWidthCap(s, DpiScale(kRefHoverMaxPopupWidth));
    // Combined content extent (region stacked above continuation, if any) used
    // for sizing below; req.region itself stays just the primary crop.
    float contentDy = region.dy + (hasContinuation ? continuation.dy : 0.f);
    float contentDx = hasContinuation && continuation.dx > region.dx ? continuation.dx : region.dx;

    int popupHCap;
    int cursorPad = DpiScale(kRefHoverCursorPad);
    if (contentDy > 250.f && s->pending.pageScreenRect.dy > 0) {
        Rect pr = s->pending.pageScreenRect;
        int curY = s->pending.screenPt.y;
        int spaceAbove = curY - pr.y - cursorPad;
        int spaceBelow = (pr.y + pr.dy) - curY - cursorPad;
        int maxSpace = (spaceAbove > spaceBelow) ? spaceAbove : spaceBelow;
        maxSpace = std::max(maxSpace, 0);
        int pageBased = pr.dy * 75 / 100;
        popupHCap = (pageBased > maxSpace) ? pageBased : maxSpace;
    } else {
        popupHCap = DpiScale(kRefHoverMaxPopupHeight);
        if (s->pending.pageScreenRect.dy > 0) {
            int pageBased = s->pending.pageScreenRect.dy * 45 / 100;
            popupHCap = std::min(pageBased, popupHCap);
        }
    }
    int border = DpiScale(kRefHoverBorder);
    float availH = (float)(popupHCap - (2 * border));
    float availW = (float)(popupWCap - (2 * border));
    if (useLinkZoom) {
        float wantW = availW / baseZoom;
        float wantH = availH / baseZoom;
        float maxW = mediabox.dx - region.x;
        float maxH = mediabox.dy - region.y;
        wantW = std::min(wantW, maxW);
        wantH = std::min(wantH, maxH);
        wantW = std::max(wantW, 1.f);
        wantH = std::max(wantH, 1.f);
        region.dx = wantW;
        region.dy = wantH;
    } else {
        if (contentDy > 0.f && contentDy * baseZoom > availH) {
            baseZoom = availH / contentDy;
        }
        if (contentDx > 0.f && contentDx * baseZoom > availW) {
            baseZoom = availW / contentDx;
        }
    }
    baseZoom = std::max(baseZoom, kRefHoverMinUserZoom);
    s->displayed.baseZoom = baseZoom;

    RefHoverState::RenderRequest req;
    req.pageNo = destPage;
    req.zoom = s->displayed.baseZoom * s->displayed.userZoom;
    req.region = region;
    if (hasContinuation) {
        req.continuationRegion = continuation;
    }
    req.showPopup = true;
    req.screenPt = s->pending.screenPt;
    req.destPageRaw = s->pending.destPage;
    req.destXRaw = s->pending.destX;
    req.destYRaw = s->pending.destY;
    req.srcPageRaw = s->pending.srcPage;
    req.srcRectRaw = s->pending.srcRect;
    RefHoverRequestRender(s, engine, req);
    return true;
}
