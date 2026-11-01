/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include "base/Base.h"
#include "base/Win.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "Theme.h"
#include "SumatraConfig.h"
#include "AppIconPaths.h"
#include "AppIconTheme.h"

/*
Windows' icons are drawn from src/solokpdf/AppIcon.svg in the theme's colors:
the badge in the title bar color (ThemeTabStripColor), so it melts into it, and the band
and "PDF" in the document text color. The exe's icon is the same drawing in
One Dark's colors (tools/solokpdf/make-icon.py).

Each size is drawn directly: scaling one bitmap down bleeds its edges.
*/

constexpr float kIconBox = 256;

static void AddLoops(Gdiplus::GraphicsPath& path, const float* pts, const int* loops, int nLoops, float scale) {
    for (int i = 0; i < nLoops; i++) {
        Vec<Gdiplus::PointF> v;
        for (int j = 0; j < loops[i]; j++) {
            VecAppend(v, Gdiplus::PointF(pts[j * 2] * scale, pts[j * 2 + 1] * scale));
        }
        path.StartFigure();
        path.AddBeziers(v.els, len(v));
        path.CloseFigure();
        pts += loops[i] * 2;
    }
}

static void FillLayer(Gdiplus::Graphics& g, const float* pts, const int* loops, int nLoops, float scale, Color col) {
    // text counters wind the other way: holes under the nonzero rule
    Gdiplus::GraphicsPath path(Gdiplus::FillModeWinding);
    AddLoops(path, pts, loops, nLoops, scale);
    Gdiplus::SolidBrush br(GdiRgbFromColor(col));
    g.FillPath(&br, &path);
}

// an icon from straight-alpha BGRA rows; Bitmap::GetHICON mishandles partial alpha
// (edges came out brighter than the background on dark themes)
static HICON IconFromBgra(int size, const u8* src, int stride) {
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(bmi.bmiHeader);
    bmi.bmiHeader.biWidth = size;
    bmi.bmiHeader.biHeight = -size;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP color = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    HBITMAP mask = CreateBitmap(size, size, 1, 1, nullptr);
    HICON icon = nullptr;
    if (color && mask) {
        for (int y = 0; y < size; y++) {
            memcpy((u8*)bits + (y * size * 4), src + (y * stride), size * 4);
        }
        ICONINFO ii{TRUE, 0, 0, mask, color};
        icon = CreateIconIndirect(&ii);
    }
    DeleteObject(color);
    DeleteObject(mask);
    return icon;
}

static HICON DrawAppIcon(int size, Color badge, Color ink) {
    Gdiplus::Bitmap bmp(size, size, PixelFormat32bppARGB);
    {
        Gdiplus::Graphics g(&bmp);
        g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
        g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
        g.Clear(Gdiplus::Color(0, 0, 0, 0));
        float scale = size / kIconBox;
        FillLayer(g, kIconBandPts, kIconBandLoops, dimofi(kIconBandLoops), scale, ink);
        FillLayer(g, kIconBadgePts, kIconBadgeLoops, dimofi(kIconBadgeLoops), scale, badge);
        FillLayer(g, kIconTextPts, kIconTextLoops, dimofi(kIconTextLoops), scale, ink);
    }
    Gdiplus::BitmapData data;
    Gdiplus::Rect rc(0, 0, size, size);
    if (bmp.LockBits(&rc, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &data) != Gdiplus::Ok) {
        return nullptr;
    }
    HICON icon = IconFromBgra(size, (const u8*)data.Scan0, data.Stride);
    bmp.UnlockBits(&data);
    return icon;
}

struct ThemedIcon {
    Color badge;
    Color ink;
    int size;
    HICON icon;
};

// never freed: a dialog opened before a theme change still shows its icon
static Vec<ThemedIcon> gThemedIcons;

static HICON ThemedAppIcon(int size) {
    Color badge = ThemeTabStripColor();
    Color ink = ThemeWindowTextColor();
    for (ThemedIcon& ti : gThemedIcons) {
        if (ti.badge == badge && ti.ink == ink && ti.size == size) {
            return ti.icon;
        }
    }
    HICON icon = DrawAppIcon(size, badge, ink);
    if (icon) {
        VecAppend(gThemedIcons, ThemedIcon{badge, ink, size, icon});
    }
    return icon;
}

void ApplyThemedAppIcon(HWND hwnd) {
    HICON bigIcon = ThemedAppIcon(GetSystemMetrics(SM_CXICON));
    HICON smallIcon = ThemedAppIcon(GetSystemMetrics(SM_CXSMICON));
    if (!hwnd || !bigIcon || !smallIcon) {
        return;
    }
    SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)bigIcon);
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)smallIcon);
}

// dialogs pass the exe's icon to WindowBase; give them the themed one
static void SetWindowBaseIcon(HWND hwnd, HICON icon) {
    HICON exeIcon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(GetAppIconID()));
    if (icon == exeIcon) {
        ApplyThemedAppIcon(hwnd);
        return;
    }
    HwndSetIcon(hwnd, icon);
}

struct WindowBaseIconHook {
    WindowBaseIconHook() { gWindowBaseSetIcon = SetWindowBaseIcon; }
};
static WindowBaseIconHook gWindowBaseIconHook;
