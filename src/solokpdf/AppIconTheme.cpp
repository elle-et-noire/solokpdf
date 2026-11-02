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
Windows' icons are drawn from src/solokpdf/AppIcon.svg in the theme's document
text color, the big one (taskbar, Alt+Tab) in a theme color that shows on the
taskbar: band and badge as one shape, cut by the gap between them and by
"PDF", which show the title bar through. The exe's icon is the same drawing in
One Dark's text color (tools/solokpdf/make-icon.py).

Each size is drawn directly: scaling one bitmap down bleeds its edges.
*/

constexpr float kIconBox = 256;
// the gap stays visible at small sizes
constexpr float kMinSeamPx = 1.0f;

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

static void FillLayer(Gdiplus::Graphics& g, const float* pts, const int* loops, int nLoops, float scale) {
    // text counters wind the other way: holes under the nonzero rule
    Gdiplus::GraphicsPath path(Gdiplus::FillModeWinding);
    AddLoops(path, pts, loops, nLoops, scale);
    Gdiplus::SolidBrush br(Gdiplus::Color(255, 255, 255, 255));
    g.FillPath(&br, &path);
}

// the gap: run from outside the outline to outside it, so it cuts it cleanly
static void StrokeSeam(Gdiplus::Graphics& g, float scale) {
    Gdiplus::PointF p[dimofi(kIconSeamPts) / 2];
    for (int i = 0; i < dimofi(p); i++) {
        p[i] = Gdiplus::PointF(kIconSeamPts[i * 2] * scale, kIconSeamPts[i * 2 + 1] * scale);
    }
    Gdiplus::GraphicsPath path;
    path.AddLine(p[0], p[1]);
    path.AddBeziers(&p[1], 7);
    path.AddLine(p[7], p[8]);
    Gdiplus::Pen pen(Gdiplus::Color(255, 255, 255, 255), std::max(kIconSeamWidth * scale, kMinSeamPx));
    pen.SetLineJoin(Gdiplus::LineJoinRound);
    g.DrawPath(&pen, &path);
}

// white coverage of what draw() paints, antialiased, at size x size
template <typename Fn>
static bool DrawCoverage(Gdiplus::Bitmap& bmp, Fn draw) {
    Gdiplus::Graphics g(&bmp);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
    g.Clear(Gdiplus::Color(0, 0, 0, 0));
    draw(g);
    return g.GetLastStatus() == Gdiplus::Ok;
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

// The shape's coverage times what the cuts leave of it, in the ink color: the
// cuts' antialiased edges stay soft. Painting the cuts over the shape in a
// background color instead left hairlines where their edges met.
static HICON DrawAppIcon(int size, Color ink) {
    float scale = size / kIconBox;
    Gdiplus::Bitmap shape(size, size, PixelFormat32bppARGB);
    Gdiplus::Bitmap cuts(size, size, PixelFormat32bppARGB);
    bool ok = DrawCoverage(shape, [&](Gdiplus::Graphics& g) {
        FillLayer(g, kIconBandPts, kIconBandLoops, dimofi(kIconBandLoops), scale);
        FillLayer(g, kIconBadgePts, kIconBadgeLoops, dimofi(kIconBadgeLoops), scale);
    });
    ok = ok && DrawCoverage(cuts, [&](Gdiplus::Graphics& g) {
             FillLayer(g, kIconTextPts, kIconTextLoops, dimofi(kIconTextLoops), scale);
             StrokeSeam(g, scale);
         });
    if (!ok) {
        return nullptr;
    }

    Gdiplus::Rect rc(0, 0, size, size);
    Gdiplus::BitmapData sd, cd;
    if (shape.LockBits(&rc, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &sd) != Gdiplus::Ok) {
        return nullptr;
    }
    if (cuts.LockBits(&rc, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &cd) != Gdiplus::Ok) {
        shape.UnlockBits(&sd);
        return nullptr;
    }
    u8* bgra = AllocArray<u8>(size * size * 4);
    for (int y = 0; y < size; y++) {
        const u8* srow = (const u8*)sd.Scan0 + (y * sd.Stride);
        const u8* crow = (const u8*)cd.Scan0 + (y * cd.Stride);
        u8* out = bgra + (y * size * 4);
        for (int x = 0; x < size; x++) {
            int a = srow[x * 4 + 3] * (255 - crow[x * 4 + 3]) / 255;
            out[x * 4 + 0] = GetBlue(ink);
            out[x * 4 + 1] = GetGreen(ink);
            out[x * 4 + 2] = GetRed(ink);
            out[x * 4 + 3] = (u8)a;
        }
    }
    shape.UnlockBits(&sd);
    cuts.UnlockBits(&cd);
    HICON icon = IconFromBgra(size, bgra, size * 4);
    free(bgra);
    return icon;
}

struct ThemedIcon {
    Color ink;
    int size;
    HICON icon;
};

// never freed: a dialog opened before a theme change still shows its icon
static Vec<ThemedIcon> gThemedIcons;

static HICON ThemedAppIcon(int size, Color ink) {
    for (ThemedIcon& ti : gThemedIcons) {
        if (ti.ink == ink && ti.size == size) {
            return ti.icon;
        }
    }
    HICON icon = DrawAppIcon(size, ink);
    if (icon) {
        VecAppend(gThemedIcons, ThemedIcon{ink, size, icon});
    }
    return icon;
}

// Windows 11's taskbar in light and dark mode
constexpr Color kTaskbarLight = MkRgb(0xee, 0xee, 0xee);
constexpr Color kTaskbarDark = MkRgb(0x1c, 0x1c, 0x1c);
// AccentPalette holds 8 RGBA shades, lightest first; an accent taskbar shows the 6th
constexpr int kAccentShades = 8;
constexpr int kTaskbarAccentShade = 5;

// the taskbar's color, from the personalization settings: light, dark, or the
// accent color ("Show accent color on Start and taskbar", dark mode only)
static Color TaskbarColor() {
    Str personalize = StrL("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    DWORD light = 1;
    DWORD accent = 0;
    ReadRegDWORD(HKEY_CURRENT_USER, personalize, StrL("SystemUsesLightTheme"), light);
    ReadRegDWORD(HKEY_CURRENT_USER, personalize, StrL("ColorPrevalence"), accent);
    if (light) {
        return kTaskbarLight;
    }
    if (accent) {
        u8 pal[kAccentShades * 4];
        DWORD cb = sizeof(pal);
        LSTATUS res = RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent",
                                   L"AccentPalette", RRF_RT_REG_BINARY, nullptr, pal, &cb);
        if (res == ERROR_SUCCESS && cb == sizeof(pal)) {
            const u8* c = pal + (kTaskbarAccentShade * 4);
            return MkRgb(c[0], c[1], c[2]);
        }
    }
    return kTaskbarDark;
}

// the small icon sits in our title bar, the big one on the taskbar
void ApplyThemedAppIcon(HWND hwnd) {
    HICON bigIcon = ThemedAppIcon(GetSystemMetrics(SM_CXICON), ThemeInkOn(TaskbarColor()));
    HICON smallIcon = ThemedAppIcon(GetSystemMetrics(SM_CXSMICON), ThemeWindowTextColor());
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
