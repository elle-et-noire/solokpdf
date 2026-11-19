/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/Pixmap.h"
#include "base/UITask.h"
#if !defined(SUMATRA_NG)
#include "base/Win.h"
#endif

#include "gui/UIModels.h"

#include "DocController.h"
#include "EngineBase.h"
#if defined(SUMATRA_NG)
#include "MainWindow.h"
#include "gui/AppShell.h"
#endif
#include "RefHover.h"

struct RefHoverRenderJob {
    RefHoverState* s = nullptr;
    RefHoverState::RenderRequest req;
    Pixmap* bmp = nullptr;
    bool canceled = false;

    ~RefHoverRenderJob() {
        SafeEngineRelease(&req.engine);
        FreePixmap(bmp);
    }
};

static void RefHoverStartRenderJob(RefHoverRenderJob* job);

#if defined(SUMATRA_NG)
// ng: orig stacks the two crops with GDI BitBlt because EngineBase::RenderPage
// may hand back a DIB at a bit depth other than 32bpp BGRA8 (an 8bpp palette
// DIB for text-only content) that only the HBITMAP knows how to read. There is
// no GDI off Windows, so the odd format is normalized to 32bpp first and the
// stacking itself is a row copy.
static Pixmap* PixmapAsReadable32(Pixmap* px) {
    if (!px) {
        return nullptr;
    }
    if (px->format == PixmapFormat::BGRA8 || px->format == PixmapFormat::BGR8) {
        return nullptr;
    }
#if OS_WIN
    return PixmapCopyAs32bppDIB(px);
#else
    return nullptr;
#endif
}

static void BlitPixmapRows(Pixmap* dst, Pixmap* src, int atY) {
    int bpp = PixmapBytesPerPixel(src->format);
    int rowBytes = src->width * bpp;
    for (int y = 0; y < src->height; y++) {
        u8* s = src->data + ((size_t)y * src->stride);
        u8* d = dst->data + ((size_t)(y + atY) * dst->stride);
        if (bpp == 4) {
            memcpy(d, s, (size_t)rowBytes);
            continue;
        }
        for (int x = 0; x < src->width; x++) {
            d[(x * 4) + 0] = s[(x * 3) + 0];
            d[(x * 4) + 1] = s[(x * 3) + 1];
            d[(x * 4) + 2] = s[(x * 3) + 2];
            d[(x * 4) + 3] = 0xff;
        }
    }
}

// Stack `top` above `bottom` into one new Pixmap. Left-aligned — the two crops
// come from different columns with unrelated absolute page-x ranges (a
// right-column continuation sits ~200+pt right of a left-column entry), so
// aligning by page coordinates would insert a large, arbitrary gap rather than
// a small nudge. The narrower crop is padded on the right with opaque white so
// it isn't stretched. Consumes neither input; caller frees both. Returns
// nullptr on OOM.
static Pixmap* StackPixmapsVertically(Pixmap* top, Pixmap* bottom) {
    Pixmap* topConv = PixmapAsReadable32(top);
    Pixmap* bottomConv = PixmapAsReadable32(bottom);
    Pixmap* t = topConv ? topConv : top;
    Pixmap* b = bottomConv ? bottomConv : bottom;
    Pixmap* out = nullptr;
    bool ok = t->format != PixmapFormat::Native && b->format != PixmapFormat::Native && t->data && b->data;
    if (ok) {
        int w = t->width > b->width ? t->width : b->width;
        int h = t->height + b->height;
        out = AllocPixmap(w, h);
    }
    if (out) {
        memset(out->data, 0xff, (size_t)out->stride * (size_t)out->height);
        BlitPixmapRows(out, t, 0);
        BlitPixmapRows(out, b, t->height);
    }
    FreePixmap(topConv);
    FreePixmap(bottomConv);
    return out;
}

#else
// Stack `top` above `bottom` into one new DIB-backed Pixmap. Left-aligned —
// the two crops come from different columns with unrelated absolute page-x
// ranges (a right-column continuation sits ~200+pt right of a left-column
// entry), so aligning by page coordinates would insert a large, arbitrary gap
// rather than a small nudge. The narrower crop is padded on the right with
// opaque white so it isn't stretched. Consumes neither input; caller frees
// both. Returns nullptr on OOM.
//
// Uses GDI BitBlt rather than a raw pixel memcpy: EngineBase::RenderPage can
// return a DIB at a bit depth other than 32bpp BGRA8 for near-monochrome
// content (e.g. an 8bpp palette DIB for a text-only crop) — a straight
// memcpy assuming 4 bytes/pixel then reads past each row's actual data and
// produces colorful noise. BitBlt handles the source/dest bit-depth
// conversion regardless of what RenderPage chose.
static Pixmap* StackPixmapsVertically(Pixmap* top, Pixmap* bottom) {
    int w = top->width > bottom->width ? top->width : bottom->width;
    int h = top->height + bottom->height;
    Pixmap* out = AllocPixmapDIB(w, h);
    if (!out) {
        return nullptr;
    }
    HDC screenDC = GetDC(nullptr);
    HDC outDC = CreateCompatibleDC(screenDC);
    HGDIOBJ oldOut = outDC ? SelectObject(outDC, out->hbmp) : nullptr;
    if (outDC && oldOut) {
        RECT full{0, 0, w, h};
        HBRUSH white = CreateSolidBrush(kColWhite);
        HdcFillRect(outDC, ToRect(full), white);
        DeleteObject(white);

        if (top->hbmp) {
            HDC topDC = CreateCompatibleDC(screenDC);
            if (topDC) {
                HGDIOBJ oldTop = SelectObject(topDC, top->hbmp);
                BitBlt(outDC, 0, 0, top->width, top->height, topDC, 0, 0, SRCCOPY);
                SelectObject(topDC, oldTop);
                DeleteDC(topDC);
            }
        }
        if (bottom->hbmp) {
            HDC bottomDC = CreateCompatibleDC(screenDC);
            if (bottomDC) {
                HGDIOBJ oldBottom = SelectObject(bottomDC, bottom->hbmp);
                BitBlt(outDC, 0, top->height, bottom->width, bottom->height, bottomDC, 0, 0, SRCCOPY);
                SelectObject(bottomDC, oldBottom);
                DeleteDC(bottomDC);
            }
        }
        SelectObject(outDC, oldOut);
    }
    if (outDC) {
        DeleteDC(outDC);
    }
    ReleaseDC(nullptr, screenDC);
    return out;
}

#endif

static void RefHoverRenderDone(RefHoverRenderJob* job) {
    RefHoverState* s = job->s;
    if (!RefHoverIsLiveState(s)) {
        delete job;
        return;
    }
    if (job->canceled && job->req.gen == s->renderGen) {
        RefHoverStartRenderJob(job);
        return;
    }
    s->renderInFlight = false;
    if (job->bmp && job->req.gen == s->renderGen) {
#if defined(SUMATRA_NG)
        RefHoverFreeRenderImage(s);
#endif
        FreePixmap(s->bmp);
        s->bmp = job->bmp;
        job->bmp = nullptr;
        if (job->req.showPopup) {
            s->displayed.destPageRaw = job->req.destPageRaw;
            s->displayed.destPage = job->req.pageNo;
            s->displayed.destX = job->req.destXRaw;
            s->displayed.destY = job->req.destYRaw;
            s->displayed.srcPage = job->req.srcPageRaw;
            s->displayed.srcRect = job->req.srcRectRaw;
            s->displayed.region = job->req.region;
            RefHoverShowPopup(s, job->req.screenPt);
        } else {
#if defined(SUMATRA_NG)
            AppShellInvalidate(s->win);
#else
            HwndInvalidate(s->hwndPopup, true);
#endif
        }
    }
    delete job;
    if (s->queuedRender.valid) {
        if (s->queuedRender.gen == s->renderGen) {
            auto* next = new RefHoverRenderJob();
            next->s = s;
            next->req = s->queuedRender;
            s->queuedRender.valid = false;
            s->queuedRender.engine = nullptr;
            RefHoverStartRenderJob(next);
        } else {
            RefHoverDropQueuedRender(s);
        }
    }
}

static Pixmap* RenderRegion(RefHoverRenderJob* job, RectF region, BackgroundPageRender* background) {
    RenderPageArgs args(job->req.pageNo, job->req.zoom, 0, &region);
    args.background = background;
    Pixmap* bmp = job->req.engine->RenderPage(args);
    if (background && background->FinishPage()) {
        job->canceled = true;
        FreePixmap(bmp);
        return nullptr;
    }
    return bmp;
}

static void RenderPreview(RefHoverRenderJob* job, BackgroundPageRender* background) {
    job->bmp = RenderRegion(job, job->req.region, background);
    RectF cont = job->req.continuationRegion;
    if (!job->bmp || cont.dx <= 0.f || cont.dy <= 0.f) {
        return;
    }
    Pixmap* contBmp = RenderRegion(job, cont, background);
    if (!contBmp) {
        return;
    }
    Pixmap* stacked = StackPixmapsVertically(job->bmp, contBmp);
    FreePixmap(contBmp);
    if (stacked) {
        FreePixmap(job->bmp);
        job->bmp = stacked;
    }
}

static void RefHoverRenderThread(RefHoverRenderJob* job) {
    job->canceled = false;
#if defined(SUMATRA_NG)
    RenderPreview(job, nullptr);
#else
    {
        BackgroundPageRender background(job->req.engine);
        RenderPreview(job, &background);
    }
#endif
    if (job->canceled) {
        FreePixmap(job->bmp);
        job->bmp = nullptr;
    } else {
        SafeEngineRelease(&job->req.engine);
    }
    auto fn = MkFunc0<RefHoverRenderJob>(RefHoverRenderDone, job);
    uitask::Post(fn, "RefHoverRenderDone");
}

static void RefHoverStartRenderJob(RefHoverRenderJob* job) {
    job->s->renderInFlight = true;
    auto fn = MkFunc0<RefHoverRenderJob>(RefHoverRenderThread, job);
    RunAsync(fn, StrL("RefHoverRender"));
}

void RefHoverRequestRender(RefHoverState* s, EngineBase* engine, RefHoverState::RenderRequest req) {
    s->renderGen++;
    req.valid = true;
    req.gen = s->renderGen;
    engine->AddRef();
    req.engine = engine;
    if (s->renderInFlight) {
        RefHoverDropQueuedRender(s);
        s->queuedRender = req;
        return;
    }
    auto* job = new RefHoverRenderJob();
    job->s = s;
    job->req = req;
    RefHoverStartRenderJob(job);
}
