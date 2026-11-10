/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/GuessFileType.h"
#include "base/Pixmap.h"
#include "base/Timer.h"

#include "gui/UIModels.h"
#include "Settings.h"
#include "AppSettings.h"
#include "DocController.h"
#include "EngineBase.h"
#include "EngineAll.h"
#include "DisplayModel.h"
#include "RenderCache.h"

extern RenderCache* gRenderCache;

struct RequestLockProbe {
    RecursiveMutex* mutex = nullptr;
    bool available = false;
};

static void ProbeRequestLock(RequestLockProbe* probe) {
    probe->available = probe->mutex->TryLock();
    if (probe->available) {
        probe->mutex->Unlock();
    }
}

class LockProbeAbortCookie : public AbortCookie {
  public:
    RecursiveMutex* mutex = nullptr;
    bool* available = nullptr;

    LockProbeAbortCookie(RecursiveMutex* mutex, bool* available) : mutex(mutex), available(available) {}
    ~LockProbeAbortCookie() override {
        RequestLockProbe probe{mutex};
        ThreadHandle thread = StartThread(MkFunc0(ProbeRequestLock, &probe), StrL("request-lock-probe"));
        if (!thread) {
            return;
        }
        JoinThread(&thread, -1);
        *available = probe.available;
    }

    void Abort() override {}
    void* GetData() override { return nullptr; }
};

bool RenderCache_UnitTestCookieUnlocked() {
    RenderCache cache;
    PageRenderRequest req;
    bool available = false;
    req.abortCookie = new LockProbeAbortCookie(&cache.requestAccess, &available);
    cache.curReqs[0] = &req;

    cache.ClearCurrentRequest(0);
    return available;
}

enum class StopLock {
    Request,
    Wake,
    None
};

struct StopProbe {
    RenderCache* cache;
    StopLock lock;
    AtomicBool ready = false;
    AtomicBool release = false;
};

static void HoldStopLock(StopProbe* probe) {
    auto* cache = probe->cache;
    if (probe->lock == StopLock::Request) {
        cache->requestAccess.Lock();
    } else if (probe->lock == StopLock::Wake) {
        cache->startRendering.mutex.Lock();
    }
    AtomicBoolSet(&probe->ready, true);
    while (!AtomicBoolGet(&probe->release)) {
        SleepInMs(1);
    }
    if (probe->lock == StopLock::Request) {
        cache->requestAccess.Unlock();
    } else if (probe->lock == StopLock::Wake) {
        cache->startRendering.mutex.Unlock();
    }
}

bool RenderCache_UnitTestStop() {
    if (!kHasThreads) {
        return true;
    }
    bool ok = true;
    const StopLock locks[] = {StopLock::Request, StopLock::Wake, StopLock::None};
    for (StopLock lock : locks) {
        RenderCache cache;
        StopProbe probe{&cache, lock};
        ThreadHandle thread = StartThread(MkFunc0(HoldStopLock, &probe), StrL("stop-lock-test"));
        if (!thread) {
            return false;
        }
        cache.renderThreads[0] = thread;
        cache.nRenderThreads = 1;
        StopProbe finished{&cache, StopLock::None};
        if (lock == StopLock::None) {
            AtomicBoolSet(&finished.release, true);
            cache.renderThreads[1] = StartThread(MkFunc0(HoldStopLock, &finished), StrL("stop-finished-test"));
            if (cache.renderThreads[1]) {
                cache.nRenderThreads++;
                ok = ok && WaitThread(cache.renderThreads[1], 1000);
            } else {
                ok = false;
            }
        }
        while (!AtomicBoolGet(&probe.ready)) {
            SleepInMs(1);
        }

        auto start = TimeGet();
        bool stopped = cache.Stop(20);
        ok = ok && !stopped && TimeSinceInMs(start) < 1000;
        ok = ok && cache.renderThreads[0] == thread && !WaitThread(thread, 0);
        if (lock == StopLock::None) {
            ok = ok && cache.renderThreads[1] != nullptr;
        }
        AtomicBoolSet(&probe.release, true);
        bool retried = cache.Stop();
        ok = ok && retried && cache.renderThreads[0] == nullptr && cache.requestCount == 0;

        ok = ok && cache.Stop(0);
    }
    return ok;
}

namespace {

struct NoopDocCb : DocControllerCallback {
    void PageNoChanged(DocController*, int) override {}
    void ZoomChanged(DocController*, float) override {}
    void GotoLink(IPageDestination*) override {}
    void Repaint() override {}
    void UpdateScrollbars(DisplayModel*, Size) override {}
    void RequestRendering(DisplayModel*, int) override {}
    void RequestPredictiveRendering(DisplayModel*, int, const int*, int) override {}
    void CleanUp(DisplayModel*) override {}
    void RenderThumbnail(DisplayModel*, Size, const OnBitmapRendered*) override {}
    void FocusFrame(bool) override {}
    void SaveDownload(Str, Str) override {}
    void FindResultReceived(int, int, int) override {}
    void FindAllResultReceived(Str) override {}
    void TocChanged(DocController*) override {}
    void PagesRenumbered(DisplayModel*) override {}
};

// mupdf repairs the missing xref
const char* kOnePagePdf =
    "%PDF-1.4\n"
    "1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n"
    "2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n"
    "3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 600 600]>> endobj\n"
    "trailer <</Root 1 0 R>>\n"
    "%%EOF\n";

int TileDistance(TilePosition a, TilePosition b) {
    int dr = abs((int)a.row - (int)b.row);
    int dc = abs((int)a.col - (int)b.col);
    return std::max(dr, dc);
}

} // namespace

// A deeply zoomed single page fills the cache with its own tiles. Off-screen
// tiles of that visible page must be evicted to make room for visible ones.
bool RenderCache_UnitTestFullOfOneVisiblePage() {
    Settings* prevSettings = gSettings;
    if (!gSettings) {
        gSettings = NewSettings({});
    }
    EngineBase* engine = CreateEngineMupdfFromData(Str(kOnePagePdf), StrL("one-page.pdf"), nullptr);
    if (!engine) {
        return false;
    }

    NoopDocCb cb;
    auto* dm = new DisplayModel(engine, &cb);
    dm->SetInitialViewSettings(DisplayMode::Continuous, 1, {400, 300}, 96);
    dm->Relayout(1600, 0);

    bool ok = false;
    {
        RenderCache cache;
        cache.maxRenderThreads = 0;
        cache.maxTileSize = {200, 200};
        PageRenderRequest visible;
        visible.dm = dm;
        visible.pageNo = 1;
        visible.zoom = dm->GetRenderZoom(1);
        visible.darkModeEpoch = cache.darkModeEpoch;

        // the tile under the viewport's top-left corner; rows count from the page bottom
        u16 res = cache.GetTileRes(dm, 1);
        Rect page = dm->GetPageInfo(1)->pageOnScreen;
        int nTiles = 1 << res;
        int col = std::max(0, -page.x) * nTiles / page.dx;
        int rowFromTop = std::max(0, -page.y) * nTiles / page.dy;
        visible.tile = TilePosition(res, (u16)(nTiles - 1 - rowFromTop), (u16)col);

        if (res >= 5) {
            for (int r = 0; r < nTiles && cache.cacheCount < kMaxBitmapsCached; r++) {
                for (int c = 0; c < nTiles && cache.cacheCount < kMaxBitmapsCached; c++) {
                    PageRenderRequest req = visible;
                    req.tile = TilePosition(res, (u16)r, (u16)c);
                    if (TileDistance(req.tile, visible.tile) < 4) {
                        continue;
                    }
                    cache.Add(req, AllocPixmap(4, 4));
                }
            }
            bool full = cache.cacheCount == kMaxBitmapsCached;
            cache.Add(visible, AllocPixmap(4, 4));
            ok = full && cache.Exists(dm, 1, visible.rotation, visible.zoom, &visible.tile);
        }
        cache.AbortRendering(dm);
        cache.FreeForDisplayModel(dm);
    }

    delete dm;
    if (!prevSettings) {
        DeleteSettings(gSettings);
        gSettings = nullptr;
    }
    return ok;
}

// Tiles left from an earlier zoom must not crowd out tiles for the current
// zoom. Otherwise every finished render is dropped, the repaint re-requests it
// and rendering never stops (#6366).
bool RenderCache_UnitTestFullOfOldZoom() {
    Settings* prevSettings = gSettings;
    if (!gSettings) {
        gSettings = NewSettings({});
    }
    EngineBase* engine = CreateEngineMupdfFromData(Str(kOnePagePdf), StrL("one-page.pdf"), nullptr);
    if (!engine) {
        return false;
    }

    NoopDocCb cb;
    auto* dm = new DisplayModel(engine, &cb);
    dm->SetInitialViewSettings(DisplayMode::Continuous, 1, {400, 300}, 96);
    // the whole page is visible, so every tile of the old zoom is on screen
    dm->Relayout(25, 0);

    bool ok = false;
    {
        RenderCache cache;
        cache.maxRenderThreads = 0;
        PageRenderRequest visible;
        visible.dm = dm;
        visible.pageNo = 1;
        visible.zoom = dm->GetRenderZoom(1);
        visible.darkModeEpoch = cache.darkModeEpoch;
        visible.tile = TilePosition(cache.GetTileRes(dm, 1), 0, 0);

        constexpr u16 kOldRes = 5;
        int nTiles = 1 << kOldRes;
        for (int r = 0; r < nTiles && cache.cacheCount < kMaxBitmapsCached; r++) {
            for (int c = 0; c < nTiles && cache.cacheCount < kMaxBitmapsCached; c++) {
                PageRenderRequest req = visible;
                req.zoom = visible.zoom * 8;
                req.tile = TilePosition(kOldRes, (u16)r, (u16)c);
                cache.Add(req, AllocPixmap(4, 4));
            }
        }
        bool full = cache.cacheCount == kMaxBitmapsCached;
        cache.Add(visible, AllocPixmap(4, 4));
        ok = full && cache.Exists(dm, 1, visible.rotation, visible.zoom, &visible.tile);
        cache.AbortRendering(dm);
        cache.FreeForDisplayModel(dm);
    }

    delete dm;
    if (!prevSettings) {
        DeleteSettings(gSettings);
        gSettings = nullptr;
    }
    return ok;
}

// A late result must not evict the same tile from the current color generation.
bool RenderCache_UnitTestStale() {
    Settings* prevSettings = gSettings;
    if (!gSettings) {
        gSettings = NewSettings({});
    }
    EngineBase* engine = CreateEngineMupdfFromData(Str(kOnePagePdf), StrL("one-page.pdf"), nullptr);
    if (!engine) {
        return false;
    }
    NoopDocCb cb;
    auto* dm = new DisplayModel(engine, &cb);
    dm->SetInitialViewSettings(DisplayMode::Continuous, 1, {400, 300}, 96);

    bool ok;
    {
        RenderCache cache;
        PageRenderRequest req;
        req.dm = dm;
        req.pageNo = 1;
        req.zoom = 1;
        req.tile = TilePosition(0, 0, 0);
        cache.darkModeEpoch++;
        req.darkModeEpoch = cache.darkModeEpoch;
        Pixmap* current = AllocPixmap(4, 4);
        cache.Add(req, current);

        req.darkModeEpoch--;
        cache.Add(req, AllocPixmap(4, 4));
        ok = cache.cacheCount == 1 && cache.cache[0]->bitmap == current;

        req.darkModeEpoch = cache.darkModeEpoch;
        req.abort = true;
        cache.Add(req, AllocPixmap(4, 4));
        ok = ok && cache.cacheCount == 1 && cache.cache[0]->bitmap == current;

        RenderCache* prevCache = gRenderCache;
        gRenderCache = &cache;
        req.abort = false;
        req.darkModeEpoch--;
        req.errorCode = 1;
        dm->RenderFinished(&req);
        ok = ok && !dm->GetPageInfo(1)->failedToRender;
        gRenderCache = prevCache;
        cache.FreeForDisplayModel(dm);
    }
    delete dm;
    if (!prevSettings) {
        DeleteSettings(gSettings);
        gSettings = nullptr;
    }
    return ok;
}

// The renderer must use the request's colors even after the active theme changes.
bool RenderCache_UnitTestColors() {
    Settings* prevSettings = gSettings;
    if (!gSettings) {
        gSettings = NewSettings({});
    }
    EngineBase* engine = CreateEngineMupdfFromData(Str(kOnePagePdf), StrL("one-page.pdf"), nullptr);
    if (!engine) {
        return false;
    }
    NoopDocCb cb;
    auto* dm = new DisplayModel(engine, &cb);
    bool ok = false;
    {
        RenderCache cache;
        ViewPageOptions options;
        options.colors.mode = DocumentColorsFollowTheme::Smart;
        options.colors.foreground = MkRgb(200, 210, 220);
        options.colors.pageBackground = MkRgb(17, 34, 51);
        cache.SetViewColors(options);
        cache.requests[0].dm = dm;
        cache.requestCount = 1;
        PageRenderRequest req;
        if (cache.GetNextRequest(&req, 0)) {
            cache.SetViewColors({});
            RenderPageArgs args(1, 0.1f, 0);
            Pixmap* bmp = RenderViewPage(engine, args, req.options);
            bool bgr = bmp && (bmp->format == PixmapFormat::BGRA8 || bmp->format == PixmapFormat::BGR8);
            ok = bgr && bmp->data[0] == 51 && bmp->data[1] == 34 && bmp->data[2] == 17;
            FreePixmap(bmp);
            cache.ClearCurrentRequest(0);
        }
    }
    delete dm;
    if (!prevSettings) {
        DeleteSettings(gSettings);
        gSettings = nullptr;
    }
    return ok;
}

static DocController* gDestroyedCtrl = nullptr;

static void NoteCtrlDestroyed(DocController* ctrl) {
    gDestroyedCtrl = ctrl;
}

// deleting a controller on any path tells the app, so it can drop raw
// pointers to it (orig's gMostRecentlyOpenedDoc for DDE)
bool DocController_UnitTestDestroyHook() {
    Settings* prevSettings = gSettings;
    if (!gSettings) {
        gSettings = NewSettings({});
    }
    EngineBase* engine = CreateEngineMupdfFromData(Str(kOnePagePdf), StrL("one-page.pdf"), nullptr);
    if (!engine) {
        return false;
    }
    NoopDocCb cb;
    DocController* ctrl = new DisplayModel(engine, &cb);
    Func1<DocController*> prev = gOnDocControllerDestroyed;
    gOnDocControllerDestroyed = MkFunc1Void(NoteCtrlDestroyed);
    gDestroyedCtrl = nullptr;
    delete ctrl;
    bool ok = gDestroyedCtrl == ctrl;
    gOnDocControllerDestroyed = prev;
    if (!prevSettings) {
        DeleteSettings(gSettings);
        gSettings = nullptr;
    }
    return ok;
}
