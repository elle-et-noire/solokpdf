/* Copyright 2026 SolokPDF contributors. License: GPLv3 */

#include "base/Base.h"
#include "base/Win.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "Theme.h"
#include "SumatraConfig.h"
#include "resource.h"
#include "AppIconTheme.h"

/*
Windows' icons take the hue of the theme's link color: the app icon's yellow
badge, IDI_SOLOK_BADGE, is tinted in OKLCH. tools/solokpdf/make-icon.py does
the same for the exe's icon with the Light theme's link color; keep them in step.

  pixel ─► OKLCH (L, C, h) ─► (L * k, C, link hue) ─► lower C into sRGB ─► pixel

k moves lightness halfway from yellow's most-saturated lightness (~0.93) to the
link hue's, so a blue badge isn't washed out. Black text and gray edges
(saturation < kMinSat) are left alone. A gray link color still has a faint hue
(Dark's #6B7280 is bluish); a pure gray one takes the exe's hue, never yellow.
*/

constexpr float kMinSat = 0.25f;
constexpr Color kBadgeColor = MkRgb(0xff, 0xf0, 0x00);
// the Light theme's link color, which make-icon.py gives the exe's icon
constexpr Color kExeLinkColor = MkRgb(0x00, 0x20, 0xa0);
constexpr float kMinHueChroma = 0.005f;

struct Oklch {
    float l, c, h;
};

static float ToLinear(float c) {
    return c <= 0.04045f ? c / 12.92f : powf((c + 0.055f) / 1.055f, 2.4f);
}

static float FromLinear(float c) {
    c = std::clamp(c, 0.0f, 1.0f);
    return c <= 0.0031308f ? c * 12.92f : (1.055f * powf(c, 1.0f / 2.4f)) - 0.055f;
}

static Oklch ToOklch(float r, float g, float b) {
    r = ToLinear(r);
    g = ToLinear(g);
    b = ToLinear(b);
    float l = cbrtf((0.4122214708f * r) + (0.5363325363f * g) + (0.0514459929f * b));
    float m = cbrtf((0.2119034982f * r) + (0.6806995451f * g) + (0.1073969566f * b));
    float s = cbrtf((0.0883024619f * r) + (0.2817188376f * g) + (0.6299787005f * b));
    float L = (0.2104542553f * l) + (0.7936177850f * m) - (0.0040720468f * s);
    float A = (1.9779984951f * l) - (2.4285922050f * m) + (0.4505937099f * s);
    float B = (0.0259040371f * l) + (0.7827717662f * m) - (0.8086757660f * s);
    return {L, hypotf(A, B), atan2f(B, A)};
}

static Oklch ToOklch(Color col) {
    u8 r, g, b;
    UnpackColor(col, r, g, b);
    return ToOklch(r / 255.0f, g / 255.0f, b / 255.0f);
}

// linear sRGB, may be out of [0, 1]
static void ToLinearRgb(Oklch v, float* rgb) {
    float A = v.c * cosf(v.h);
    float B = v.c * sinf(v.h);
    float l = powf(v.l + (0.3963377774f * A) + (0.2158037573f * B), 3);
    float m = powf(v.l - (0.1055613458f * A) - (0.0638541728f * B), 3);
    float s = powf(v.l - (0.0894841775f * A) - (1.2914855480f * B), 3);
    rgb[0] = (4.0767416621f * l) - (3.3077115913f * m) + (0.2309699292f * s);
    rgb[1] = (-1.2684380046f * l) + (2.6097574011f * m) - (0.3413193965f * s);
    rgb[2] = (-0.0041960863f * l) - (0.7034186147f * m) + (1.7076147010f * s);
}

static bool InGamut(Oklch v) {
    float rgb[3];
    ToLinearRgb(v, rgb);
    for (float x : rgb) {
        if (x < -1e-4f || x > 1 + 1e-4f) {
            return false;
        }
    }
    return true;
}

// the highest chroma up to maxC that sRGB can show at lightness l and hue h
static float FitChroma(float l, float maxC, float h) {
    if (InGamut({l, maxC, h})) {
        return maxC;
    }
    float lo = 0;
    float hi = maxC;
    for (int i = 0; i < 20; i++) {
        float mid = (lo + hi) / 2;
        if (InGamut({l, mid, h})) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// the lightness where hue h reaches its highest chroma: yellow ~0.93, blue ~0.45
static float CuspLightness(float h) {
    float best = 0.5f;
    float bestC = 0;
    for (int i = 1; i < 100; i++) {
        float l = i / 100.0f;
        float c = FitChroma(l, 0.4f, h);
        if (c > bestC) {
            bestC = c;
            best = l;
        }
    }
    return best;
}

static void Rehue(u8* bgra, float h, float k) {
    float b = bgra[0] / 255.0f;
    float g = bgra[1] / 255.0f;
    float r = bgra[2] / 255.0f;
    float mx = std::max({r, g, b});
    float mn = std::min({r, g, b});
    if (mx <= 0 || (mx - mn) / mx < kMinSat) {
        return;
    }
    Oklch v = ToOklch(r, g, b);
    v.l *= k;
    v.c = FitChroma(v.l, v.c, h);
    v.h = h;
    float rgb[3];
    ToLinearRgb(v, rgb);
    bgra[0] = (u8)lroundf(FromLinear(rgb[2]) * 255);
    bgra[1] = (u8)lroundf(FromLinear(rgb[1]) * 255);
    bgra[2] = (u8)lroundf(FromLinear(rgb[0]) * 255);
}

// the badge icon at size x size, recolored to hue h with lightness scale k
static HICON TintBadge(int size, float h, float k) {
    HMODULE mod = GetModuleHandleW(nullptr);
    auto src = (HICON)LoadImageW(mod, MAKEINTRESOURCEW(IDI_SOLOK_BADGE), IMAGE_ICON, size, size, LR_DEFAULTCOLOR);
    if (!src) {
        return nullptr;
    }
    ICONINFO ii{};
    if (!GetIconInfo(src, &ii)) {
        DestroyIcon(src);
        return nullptr;
    }

    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(bmi.bmiHeader);
    bmi.bmiHeader.biWidth = size;
    bmi.bmiHeader.biHeight = -size;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    HDC dc = GetDC(nullptr);
    void* bits = nullptr;
    HBITMAP color = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    HICON res = nullptr;
    if (color && GetDIBits(dc, ii.hbmColor, 0, size, bits, &bmi, DIB_RGB_COLORS) == size) {
        u8* px = (u8*)bits;
        for (int i = 0; i < size * size; i++) {
            Rehue(px + (i * 4), h, k);
        }
        ICONINFO out = ii;
        out.hbmColor = color;
        res = CreateIconIndirect(&out);
    }
    ReleaseDC(nullptr, dc);
    DeleteObject(color);
    DeleteObject(ii.hbmColor);
    DeleteObject(ii.hbmMask);
    DestroyIcon(src);
    return res;
}

struct ThemedIcon {
    Color link;
    int size;
    HICON icon;
};

// never freed: a dialog opened before a theme change still shows its icon
static Vec<ThemedIcon> gThemedIcons;

static HICON ThemedAppIcon(int size) {
    Color link = ThemeWindowLinkColor();
    for (ThemedIcon& ti : gThemedIcons) {
        if (ti.link == link && ti.size == size) {
            return ti.icon;
        }
    }

    Oklch target = ToOklch(link);
    if (target.c < kMinHueChroma) {
        target = ToOklch(kExeLinkColor);
    }
    float h = target.h;
    float k = (1 + (CuspLightness(h) / CuspLightness(ToOklch(kBadgeColor).h))) / 2;
    HICON icon = TintBadge(size, h, k);
    if (icon) {
        VecAppend(gThemedIcons, ThemedIcon{link, size, icon});
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
