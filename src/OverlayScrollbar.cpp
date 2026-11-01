/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include <vssym32.h>
#include "gui/Dpi.h"
#include "base/Win.h"

#include "Theme.h"
#include "DarkMode.h"
#include "OverlayScrollbar.h"
#include "OverlayScrollbarCommon.h"

constexpr const WCHAR* kOverlayScrollbarClass = L"SUMATRA_OVERLAY_SCROLLBAR";

static bool gScrollbarClassRegistered = false;

// if true, draw small filled triangles instead of chevrons
static bool gThickArrows = true;

// repaint interval of the hover cross-fade, about the display's refresh
static constexpr UINT kHoverAnimFrameMs = 16;
// how long an auto-hiding smart bar takes to fade out
static constexpr int kAutoHideFadeMs = 500;

// all live overlay scrollbars, for global mouse tracking
static Vec<OverlayScrollbar*> gAllScrollbars;
static UINT_PTR gMouseTrackTimer = 0;
static Point gLastMousePos = {-1, -1};
static constexpr UINT_PTR kMouseTrackTimerID = 100;
static constexpr int kMouseTrackIntervalMs = 50;

// the names ng uses for these, so the code below is the same in both
bool IsAlwaysThickMode(OverlayScrollbar* sb) {
    return sb->mode == OverlayScrollbar::Mode::Thick;
}

// the bar itself, without the corner square a themed vertical bar also covers
Rect ClientRect(OverlayScrollbar* sb) {
    Rect rc = HwndClientRect(sb->hwnd);
    rc.dy -= sb->cornerDy;
    return rc;
}

static Rect CornerRect(OverlayScrollbar* sb) {
    Rect rc = HwndClientRect(sb->hwnd);
    return {0, rc.dy - sb->cornerDy, rc.dx, sb->cornerDy};
}

// Native scrollbars put a size grip in their corner when it is the bottom-right
// corner of a resizable, not maximized frame
static bool CornerHasGrip(OverlayScrollbar* sb) {
    HWND root = GetAncestor(sb->hwndOwner, GA_ROOT);
    if (sb->cornerDy <= 0 || !root || IsZoomed(root) || !(GetWindowLongW(root, GWL_STYLE) & WS_THICKFRAME)) {
        return false;
    }
    RECT rc;
    GetClientRect(root, &rc);
    POINT br{rc.right, rc.bottom};
    ClientToScreen(root, &br);
    // the frame draws a thin border of its own inside its client area
    int slack = DpiScale(2);
    Rect ownerRc = HwndWindowRect(sb->hwndOwner);
    return br.x - (ownerRc.x + ownerRc.dx) <= slack && br.y - (ownerRc.y + ownerRc.dy) <= slack;
}

static bool OverCornerGrip(OverlayScrollbar* sb, Point pt) {
    return CornerHasGrip(sb) && CornerRect(sb).Contains(pt);
}

// Calculate thumb rect within the track
static Rect GetThumbRect(OverlayScrollbar* sb) {
    Rect track = GetTrackRect(sb);
    int range = sb->nMax - sb->nMin + 1;
    if (range <= 0 || (int)sb->nPage >= range) {
        return track;
    }

    int trackLen = IsVert(sb) ? track.dy : track.dx;
    int thumbLen = MulDiv(trackLen, (int)sb->nPage, range);
    thumbLen = std::max(thumbLen, DpiScale(kMinThumbSize));

    int scrollableTrack = trackLen - thumbLen;
    int scrollableRange = range - (int)sb->nPage;
    int pos = sb->isDragging ? sb->nTrackPos : sb->nPos;
    int thumbOffset = 0;
    if (scrollableRange > 0) {
        thumbOffset = MulDiv(pos - sb->nMin, scrollableTrack, scrollableRange);
    }
    thumbOffset = setMinMax(thumbOffset, 0, scrollableTrack);

    if (IsVert(sb)) {
        return {track.x, track.y + thumbOffset, track.dx, thumbLen};
    }
    return {track.x + thumbOffset, track.y, thumbLen, track.dy};
}

static void SendScrollMsg(OverlayScrollbar* sb, UINT scrollMsg, WPARAM wp) {
    SendMessageW(sb->hwndOwner, scrollMsg, wp, 0);
}

static UINT ScrollMsgForType(OverlayScrollbar* sb) {
    return IsVert(sb) ? WM_VSCROLL : WM_HSCROLL;
}

// The band the scrollbar occupies when thick, in screen coordinates. The mouse
// being in it is what turns a smart scrollbar thick, so it is always the thick
// width, whatever width the scrollbar is drawn at right now
static Rect GetScrollbarScreenRect(OverlayScrollbar* sb) {
    Rect ownerRc = HwndWindowRect(sb->hwndOwner);
    int scrollW = ScaledWidth(sb, true);
    if (IsVert(sb)) {
        return {ownerRc.x + ownerRc.dx - scrollW, ownerRc.y, scrollW, ownerRc.dy - sb->cornerDy};
    }
    return {ownerRc.x, ownerRc.y + ownerRc.dy - scrollW, ownerRc.dx, scrollW};
}

// Check if hwnd is the same as or an ancestor of child
static bool IsOrIsParentOf(HWND hwnd, HWND child) {
    while (child) {
        if (child == hwnd) {
            return true;
        }
        child = GetParent(child);
    }
    return false;
}

// Sit just above the owner frame, so the bar is seen but doesn't cover the
// windows floating over the canvas (the annotation property row, the command
// palette). SetWindowPos inserts *after* the window it is given, so that is
// the one directly above the frame, not the frame itself (issue #6093).
static HWND ScrollbarZOrderAfter(OverlayScrollbar* sb) {
    HWND root = sb->hwndOwner ? GetAncestor(sb->hwndOwner, GA_ROOT) : nullptr;
    if (!root) {
        return HWND_TOP;
    }
    HWND above = GetWindow(root, GW_HWNDPREV);
    // skip ourselves: we are what is directly above the frame once shown
    while (above == sb->hwnd) {
        above = GetWindow(above, GW_HWNDPREV);
    }
    return above ? above : HWND_TOP;
}

static void ShowScrollbarHwnd(OverlayScrollbar* sb) {
    SetWindowPos(sb->hwnd, ScrollbarZOrderAfter(sb), 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
}

// Cursor is over the owner canvas, not over another top-level window covering it
static bool MouseOverOwnerSurface(OverlayScrollbar* sb, Point pt) {
    Rect ownerRc = HwndWindowRect(sb->hwndOwner);
    if (!ownerRc.Contains(pt)) {
        return false;
    }
    POINT p{pt.x, pt.y};
    HWND hit = WindowFromPoint(p);
    if (!hit) {
        return false;
    }
    if (hit == sb->hwnd) {
        return true;
    }
    HWND ownerRoot = GetAncestor(sb->hwndOwner, GA_ROOT);
    HWND hitRoot = GetAncestor(hit, GA_ROOT);
    if (ownerRoot && hitRoot && hitRoot != ownerRoot) {
        return false;
    }
    return true;
}

static void DrawThemePart(HTHEME theme, HDC hdc, int part, int state, Rect r) {
    if (r.dx <= 0 || r.dy <= 0) {
        return;
    }
    RECT rc = ToRECT(r);
    DrawThemeBackground(theme, hdc, part, state, &rc, nullptr);
}

static HTHEME OpenScrollBarTheme(OverlayScrollbar* sb) {
    // the same window theme the canvas gets for its native scrollbars
    bool dark = DarkModeScrollBarsAreDark();
    if (dark != sb->themeDark || !sb->themeSet) {
        SetWindowTheme(sb->hwnd, dark ? L"DarkMode_Explorer" : nullptr, nullptr);
        sb->themeDark = dark;
        sb->themeSet = true;
    }
    return OpenThemeData(sb->hwnd, L"ScrollBar");
}

static HDC CreateDibDC(HDC hdcRef, int w, int h, DWORD** pixelsOut, HBITMAP* bmpOut) {
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    HDC hdc = CreateCompatibleDC(hdcRef);
    void* bits = nullptr;
    HBITMAP bmp = hdc ? CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0) : nullptr;
    if (!bmp || !bits) {
        if (bmp) {
            DeleteObject(bmp);
        }
        if (hdc) {
            DeleteDC(hdc);
        }
        return nullptr;
    }
    SelectObject(hdc, bmp);
    *pixelsOut = (DWORD*)bits;
    *bmpOut = bmp;
    return hdc;
}

static void FreeDibDC(HDC hdc, HBITMAP bmp) {
    DeleteDC(hdc);
    DeleteObject(bmp);
}

// Theme colors for a themed bar: Windows' track and thin-thumb colors, the two
// ends of the scale a drawn pixel sits on, and the theme's pair it maps onto
struct ScrollbarTint {
    bool on = false;
    DWORD nativeTrack = 0; // DIB pixels, 0xRRGGBB
    DWORD nativeThumb = 0;
    DWORD track = 0;
    DWORD thumb = 0;
};

static DWORD ColorToPixel(Color c) {
    return ((DWORD)GetRed(c) << 16) | ((DWORD)GetGreen(c) << 8) | (DWORD)GetBlue(c);
}

static ScrollbarTint GetScrollbarTint(OverlayScrollbar* sb, HTHEME theme, HDC hdcRef, int w) {
    ScrollbarTint tint;
    if (!ThemeTintsScrollbars()) {
        return tint;
    }
    // draw the plain track, then a thumb on it, and read both colors back
    bool vert = IsVert(sb);
    int barDx = std::max(w, 8);
    Rect rc = vert ? Rect{0, 0, barDx, barDx * 3} : Rect{0, 0, barDx * 3, barDx};
    DWORD* px = nullptr;
    HBITMAP bmp = nullptr;
    HDC hdc = CreateDibDC(hdcRef, rc.dx, rc.dy, &px, &bmp);
    if (!hdc) {
        return tint;
    }
    int midX = rc.dx / 2;
    int midY = rc.dy / 2;
    DrawThemePart(theme, hdc, vert ? SBP_UPPERTRACKVERT : SBP_UPPERTRACKHORZ, SCRBS_NORMAL, rc);
    GdiFlush();
    int trackX = vert ? rc.dx * 3 / 4 : midX;
    int trackY = vert ? midY : rc.dy * 3 / 4;
    tint.nativeTrack = px[trackY * rc.dx + trackX] & 0xffffff;
    DrawThemePart(theme, hdc, vert ? SBP_THUMBBTNVERT : SBP_THUMBBTNHORZ, SCRBS_NORMAL, rc);
    GdiFlush();
    tint.nativeThumb = px[midY * rc.dx + midX] & 0xffffff;
    FreeDibDC(hdc, bmp);

    tint.track = ColorToPixel(ThemeScrollbarColor());
    tint.thumb = ColorToPixel(ThemeScrollbarThumbColor());
    tint.on = tint.nativeTrack != tint.nativeThumb;
    return tint;
}

// Repaint an opaque look in the theme's colors. A pixel keeps how far it sits
// from Windows' track color toward its thumb color; past the thumb (hot,
// pressed) it goes on past the theme's thumb color, so those stay darker.
static void RecolorLook(const ScrollbarTint& tint, DWORD* pixels, int n) {
    int trackG = (int)((tint.nativeTrack >> 8) & 0xff);
    int span = (int)((tint.nativeThumb >> 8) & 0xff) - trackG;
    for (int i = 0; i < n; i++) {
        float a = (float)((int)((pixels[i] >> 8) & 0xff) - trackG) / (float)span;
        a = std::clamp(a, 0.0f, 2.0f);
        DWORD res = 0xff000000;
        for (int shift = 0; shift < 24; shift += 8) {
            float from = (float)((tint.track >> shift) & 0xff);
            float to = (float)((tint.thumb >> shift) & 0xff);
            int c = (int)(from + (a * (to - from)) + 0.5f);
            res |= (DWORD)std::clamp(c, 0, 255) << shift;
        }
        pixels[i] = res;
    }
}

// A smart bar at rest is only the theme's thin thumb line, over the page. The
// theme draws that line on a box of the track's color, so recover the line's
// coverage from how far each pixel moved from the box color toward the line's.
static void DrawThumbOverPage(OverlayScrollbar* sb, HTHEME theme, const ScrollbarTint& tint, HDC hdc, DWORD* pixels,
                              int w, int h) {
    for (int i = 0; i < w * h; i++) {
        pixels[i] = 0;
    }
    Rect thumb = GetThumbRect(sb);
    if (thumb.dx <= 0 || thumb.dy <= 0) {
        return;
    }
    int part = IsVert(sb) ? SBP_THUMBBTNVERT : SBP_THUMBBTNHORZ;
    int state = sb->isDragging ? SCRBS_PRESSED : SCRBS_NORMAL;
    DrawThemePart(theme, hdc, part, state, thumb);
    GdiFlush();

    // the box's edge can be lighter: take its color between the line and the
    // edge, across the line
    int midX = thumb.x + thumb.dx / 2;
    int midY = thumb.y + thumb.dy / 2;
    DWORD line = pixels[midY * w + midX] & 0xffffff;
    int boxX = IsVert(sb) ? thumb.x + (thumb.dx * 3 / 4) : midX;
    int boxY = IsVert(sb) ? midY : thumb.y + (thumb.dy * 3 / 4);
    DWORD box = pixels[boxY * w + boxX] & 0xffffff;
    DWORD color = tint.on ? tint.thumb : line;
    // green is as good as any channel for the coverage
    int boxG = (int)((box >> 8) & 0xff);
    int span = boxG - (int)((line >> 8) & 0xff);
    for (int y = thumb.y; y < thumb.y + thumb.dy; y++) {
        for (int x = thumb.x; x < thumb.x + thumb.dx; x++) {
            DWORD& px = pixels[y * w + x];
            int moved = boxG - (int)((px >> 8) & 0xff);
            int alpha = span == 0 ? 255 : std::clamp(moved * 255 / span, 0, 255);
            DWORD res = (DWORD)alpha << 24;
            for (int shift = 0; shift < 24; shift += 8) {
                res |= ((((color >> shift) & 0xff) * (DWORD)alpha) / 255) << shift;
            }
            px = res;
        }
    }
}

// one look of the bar: hovered (on Windows 11 wide, with arrows) or not
static void DrawThemedLook(OverlayScrollbar* sb, HTHEME theme, const ScrollbarTint& tint, HDC hdc, DWORD* pixels, int w,
                           int h, bool hover) {
    if (!hover && !IsAlwaysThickMode(sb)) {
        DrawThumbOverPage(sb, theme, tint, hdc, pixels, w, h);
        return;
    }
    DWORD bg = PremultiplyPixel(ThemeTrackColor(), 255);
    for (int i = 0; i < w * h; i++) {
        pixels[i] = bg;
    }
    bool vert = IsVert(sb);
    int barState = hover ? SCRBS_HOVER : SCRBS_NORMAL;
    int thumbState = barState;
    if (sb->isDragging) {
        thumbState = SCRBS_PRESSED;
    } else if (hover && sb->mouseOverThumb) {
        thumbState = SCRBS_HOT;
    }
    int arrowStart = vert ? (hover ? ABS_UPHOVER : ABS_UPNORMAL) : (hover ? ABS_LEFTHOVER : ABS_LEFTNORMAL);
    int arrowEnd = vert ? (hover ? ABS_DOWNHOVER : ABS_DOWNNORMAL) : (hover ? ABS_RIGHTHOVER : ABS_RIGHTNORMAL);

    DrawThemePart(theme, hdc, vert ? SBP_UPPERTRACKVERT : SBP_UPPERTRACKHORZ, barState, GetTrackRect(sb));
    DrawThemePart(theme, hdc, SBP_ARROWBTN, arrowStart, GetArrowTopRect(sb));
    DrawThemePart(theme, hdc, SBP_ARROWBTN, arrowEnd, GetArrowBottomRect(sb));
    DrawThemePart(theme, hdc, vert ? SBP_THUMBBTNVERT : SBP_THUMBBTNHORZ, thumbState, GetThumbRect(sb));
    if (sb->cornerDy > 0) {
        // the theme's corner background has a 1px frame a native corner doesn't
        // show: spread its inner color over the whole square
        Rect corner = CornerRect(sb);
        DrawThemePart(theme, hdc, SBP_SIZEBOXBKGND, barState, corner);
        GdiFlush();
        DWORD cornerBg = pixels[(corner.y + corner.dy / 2) * w + corner.x + corner.dx / 2];
        if (tint.on) {
            // a theme's bars get one background: the corner takes the track's
            cornerBg = tint.nativeTrack | 0xff000000;
        }
        for (int y = corner.y; y < corner.y + corner.dy; y++) {
            for (int x = corner.x; x < corner.x + corner.dx; x++) {
                pixels[y * w + x] = cornerBg;
            }
        }
        if (CornerHasGrip(sb)) {
            DrawThemePart(theme, hdc, SBP_SIZEBOX, SZB_RIGHTALIGN, corner);
        }
    }

    // this look is opaque, like a native bar
    GdiFlush();
    if (tint.on) {
        RecolorLook(tint, pixels, w * h);
        return;
    }
    for (int i = 0; i < w * h; i++) {
        pixels[i] |= 0xff000000;
    }
}

// 0..255 progress of the hover transition, 255 when none is running
static int HoverAnimProgress(OverlayScrollbar* sb) {
    if (sb->hoverAnimMs <= 0) {
        return 255;
    }
    u64 elapsed = GetTickCount64() - sb->hoverAnimStart;
    if (elapsed >= (u64)sb->hoverAnimMs) {
        return 255;
    }
    // ease-out, like native bars: measured on Windows 11, leaving one is ~65%
    // faded a third of the way into the theme's 1275 ms
    double t = (double)elapsed / (double)sb->hoverAnimMs;
    double rest = 1.0 - t;
    return (int)((1.0 - (rest * rest * rest)) * 255.0);
}

// Native bars cross-fade between their looks over the theme's transition time.
// Start that when the mouse enters or leaves the bar.
static void StartHoverAnim(OverlayScrollbar* sb, bool hover) {
    sb->hoverAnimMs = 0;
    HTHEME theme = OpenScrollBarTheme(sb);
    if (theme) {
        int part = IsVert(sb) ? SBP_THUMBBTNVERT : SBP_THUMBBTNHORZ;
        int from = hover ? SCRBS_NORMAL : SCRBS_HOVER;
        int to = hover ? SCRBS_HOVER : SCRBS_NORMAL;
        DWORD ms = 0;
        if (SUCCEEDED(GetThemeTransitionDuration(theme, part, from, to, TMT_TRANSITIONDURATIONS, &ms))) {
            sb->hoverAnimMs = (int)ms;
        }
        CloseThemeData(theme);
    }
    sb->hoverAnimStart = GetTickCount64();
    if (sb->hoverAnimMs > 0) {
        SetTimer(sb->hwnd, OverlayScrollbar::kTimerHoverAnim, kHoverAnimFrameMs, nullptr);
    }
}

// Draw the bar with the theme native scrollbars use, so it looks the same (on
// Windows 11 a thin line that widens and shows its arrows while the mouse is
// over it); a smart bar at rest is the line alone, over the page. Returns false
// without a theme; the caller then draws its own.
static bool PaintThemedScrollbar(OverlayScrollbar* sb, HDC hdc, DWORD* pixels, int w, int h) {
    HTHEME theme = OpenScrollBarTheme(sb);
    if (!theme) {
        return false;
    }
    bool hover = sb->mouseOverBand || sb->isDragging;
    ScrollbarTint tint = GetScrollbarTint(sb, theme, hdc, IsVert(sb) ? w : h);
    DrawThemedLook(sb, theme, tint, hdc, pixels, w, h, hover);

    // mid-transition: blend in the look we are leaving (premultiplied, so all
    // four channels blend alike)
    int t = HoverAnimProgress(sb);
    DWORD* from = nullptr;
    HBITMAP bmpFrom = nullptr;
    HDC hdcFrom = t < 255 ? CreateDibDC(hdc, w, h, &from, &bmpFrom) : nullptr;
    if (hdcFrom) {
        DrawThemedLook(sb, theme, tint, hdcFrom, from, w, h, !hover);
        for (int i = 0; i < w * h; i++) {
            DWORD res = 0;
            for (int shift = 0; shift < 32; shift += 8) {
                DWORD ca = (from[i] >> shift) & 0xff;
                DWORD cb = (pixels[i] >> shift) & 0xff;
                res |= ((ca * (255 - t) + cb * t) / 255) << shift;
            }
            pixels[i] = res;
        }
        FreeDibDC(hdcFrom, bmpFrom);
    }
    CloseThemeData(theme);
    return true;
}

// Our own look: a thin bar, thick with arrows while the mouse is over it
static void PaintCustomScrollbar(OverlayScrollbar* sb, HDC hdcMem, void* bits, int w, int h) {
    bool thick = IsThick(sb);
    u8 alpha = kAlphaThin;
    if (thick) {
        // non-default themes define exact colors, so draw thick scrollbar fully opaque
        alpha = IsCurrentThemeDefault() ? kAlphaThick : 255;
    }

    auto fillRect = [&](Rect r, Color color) {
        DWORD pixel = PremultiplyPixel(color, alpha);
        DWORD* pixels = (DWORD*)bits;
        int x0 = std::max(r.x, 0);
        int y0 = std::max(r.y, 0);
        int x1 = std::min(r.x + r.dx, w);
        int y1 = std::min(r.y + r.dy, h);
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                pixels[(y * w) + x] = pixel;
            }
        }
    };

    if (IsThick(sb)) {
        fillRect(Rect(0, 0, w, h), ThemeTrackColor());
    }

    Rect thumbRc = GetThumbRect(sb);
    Color thumbCol = sb->mouseOverThumb ? ThemeThumbHoverColor() : ThemeThumbColor();

    if (!IsThick(sb)) {
        int thinW = ScaledWidth(sb, false);
        if (IsVert(sb)) {
            thumbRc.x = (w - thinW) / 2;
            thumbRc.dx = thinW;
        } else {
            thumbRc.y = (h - thinW) / 2;
            thumbRc.dy = thinW;
        }
    }
    fillRect(thumbRc, thumbCol);

    if (IsThick(sb)) {
        Gdiplus::Graphics gfx(hdcMem);
        gfx.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);

        Color arrowCol = ThemeThumbHoverColor();
        u8 ar = (u8)MulDiv(GetRValue(arrowCol), alpha, 255);
        u8 ag = (u8)MulDiv(GetGValue(arrowCol), alpha, 255);
        u8 ab = (u8)MulDiv(GetBValue(arrowCol), alpha, 255);
        Gdiplus::Color gdipArrowCol(alpha, ar, ag, ab);

        Rect arrowTop = GetArrowTopRect(sb);
        Rect arrowBot = GetArrowBottomRect(sb);

        if (gThickArrows) {
            // filled triangles (like Windows Terminal)
            Gdiplus::SolidBrush br(gdipArrowCol);
            if (IsVert(sb)) {
                float sz = (float)arrowTop.dx / 3.0f;
                // up triangle
                float cx = (float)(arrowTop.x + (arrowTop.dx / 2));
                float cy = (float)(arrowTop.y + (arrowTop.dy / 2));
                Gdiplus::PointF upPts[3] = {
                    {cx, cy - (sz * 0.7f)},
                    {cx - sz, cy + (sz * 0.7f)},
                    {cx + sz, cy + (sz * 0.7f)},
                };
                gfx.FillPolygon(&br, upPts, 3);
                // down triangle
                cx = (float)(arrowBot.x + (arrowBot.dx / 2));
                cy = (float)(arrowBot.y + (arrowBot.dy / 2));
                Gdiplus::PointF downPts[3] = {
                    {cx - sz, cy - (sz * 0.7f)},
                    {cx + sz, cy - (sz * 0.7f)},
                    {cx, cy + (sz * 0.7f)},
                };
                gfx.FillPolygon(&br, downPts, 3);
            } else {
                float sz = (float)arrowTop.dy / 3.0f;
                // left triangle
                float cx = (float)(arrowTop.x + (arrowTop.dx / 2));
                float cy = (float)(arrowTop.y + (arrowTop.dy / 2));
                Gdiplus::PointF leftPts[3] = {
                    {cx - (sz * 0.7f), cy},
                    {cx + (sz * 0.7f), cy - sz},
                    {cx + (sz * 0.7f), cy + sz},
                };
                gfx.FillPolygon(&br, leftPts, 3);
                // right triangle
                cx = (float)(arrowBot.x + (arrowBot.dx / 2));
                cy = (float)(arrowBot.y + (arrowBot.dy / 2));
                Gdiplus::PointF rightPts[3] = {
                    {cx - (sz * 0.7f), cy - sz},
                    {cx - (sz * 0.7f), cy + sz},
                    {cx + (sz * 0.7f), cy},
                };
                gfx.FillPolygon(&br, rightPts, 3);
            }
        } else {
            // chevron lines
            Gdiplus::Pen pen(gdipArrowCol, 1.5f);
            pen.SetStartCap(Gdiplus::LineCapRound);
            pen.SetEndCap(Gdiplus::LineCapRound);
            pen.SetLineJoin(Gdiplus::LineJoinRound);
            int inset = IsVert(sb) ? arrowTop.dx / 5 : arrowTop.dy / 5;

            if (IsVert(sb)) {
                int sz = arrowTop.dx / 5;
                float cx = (float)(arrowTop.x + (arrowTop.dx / 2));
                float cy = (float)(arrowTop.y + (arrowTop.dy / 2)) + ((float)inset / 2);
                Gdiplus::PointF upPts[3] = {
                    {cx - (float)sz, cy + ((float)sz / 2.0f)},
                    {cx, cy - ((float)sz / 2.0f)},
                    {cx + (float)sz, cy + ((float)sz / 2.0f)},
                };
                gfx.DrawLines(&pen, upPts, 3);

                cx = (float)(arrowBot.x + (arrowBot.dx / 2));
                cy = (float)(arrowBot.y + (arrowBot.dy / 2)) - ((float)inset / 2);
                Gdiplus::PointF downPts[3] = {
                    {cx - (float)sz, cy - ((float)sz / 2.0f)},
                    {cx, cy + ((float)sz / 2.0f)},
                    {cx + (float)sz, cy - ((float)sz / 2.0f)},
                };
                gfx.DrawLines(&pen, downPts, 3);
            } else {
                int sz = arrowTop.dy / 5;
                float cx = (float)(arrowTop.x + (arrowTop.dx / 2)) + ((float)inset / 2);
                float cy = (float)(arrowTop.y + (arrowTop.dy / 2));
                Gdiplus::PointF leftPts[3] = {
                    {cx + ((float)sz / 2.0f), cy - (float)sz},
                    {cx - ((float)sz / 2.0f), cy},
                    {cx + ((float)sz / 2.0f), cy + (float)sz},
                };
                gfx.DrawLines(&pen, leftPts, 3);

                cx = (float)(arrowBot.x + (arrowBot.dx / 2)) - ((float)inset / 2);
                cy = (float)(arrowBot.y + (arrowBot.dy / 2));
                Gdiplus::PointF rightPts[3] = {
                    {cx - ((float)sz / 2.0f), cy - (float)sz},
                    {cx + ((float)sz / 2.0f), cy},
                    {cx - ((float)sz / 2.0f), cy + (float)sz},
                };
                gfx.DrawLines(&pen, rightPts, 3);
            }
        }
    }
}

// Update the layered window with the current appearance
static void PaintScrollbar(OverlayScrollbar* sb) {
    // an auto-hidden bar keeps its window, made transparent: painting it would
    // bring it back with no timer left to hide it
    if (!sb->hwnd || !HwndIsVisible(sb->hwnd) || !IsVisible(sb)) {
        return;
    }

    Rect wrc = HwndWindowRect(sb->hwnd);
    int w = wrc.dx;
    int h = wrc.dy;
    if (w <= 0 || h <= 0) {
        return;
    }

    HDC hdcScreen = GetDC(nullptr);
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    if (!hdcMem) {
        ReleaseDC(nullptr, hdcScreen);
        return;
    }

    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    void* bits = nullptr;
    HBITMAP hbmp = CreateDIBSection(hdcMem, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!hbmp || !bits) {
        if (hbmp) {
            DeleteObject(hbmp);
        }
        DeleteDC(hdcMem);
        ReleaseDC(nullptr, hdcScreen);
        return;
    }
    HBITMAP hbmpOld = (HBITMAP)SelectObject(hdcMem, hbmp);

    memset(bits, 0, (size_t)w * h * 4);

    bool themedDone = sb->themed && PaintThemedScrollbar(sb, hdcMem, (DWORD*)bits, w, h);
    if (!themedDone) {
        PaintCustomScrollbar(sb, hdcMem, bits, w, h);
    }

    POINT ptSrc = {0, 0};
    SIZE szWnd = {w, h};
    POINT ptDst = {wrc.x, wrc.y};
    BLENDFUNCTION blend{};
    blend.BlendOp = AC_SRC_OVER;
    blend.SourceConstantAlpha = 255;
    blend.AlphaFormat = AC_SRC_ALPHA;
    UpdateLayeredWindow(sb->hwnd, hdcScreen, &ptDst, &szWnd, hdcMem, &ptSrc, 0, &blend, ULW_ALPHA);

    SelectObject(hdcMem, hbmpOld);
    DeleteObject(hbmp);
    DeleteDC(hdcMem);
    ReleaseDC(nullptr, hdcScreen);
}

// Make the layered window fully transparent without hiding it.
// ShowWindow(SW_HIDE) can steal activation from other windows (e.g. command palette).
static void MakeLayeredWindowTransparent(HWND hwnd) {
    BLENDFUNCTION blend{};
    blend.BlendOp = AC_SRC_OVER;
    blend.SourceConstantAlpha = 0;
    blend.AlphaFormat = AC_SRC_ALPHA;
    UpdateLayeredWindow(hwnd, nullptr, nullptr, nullptr, nullptr, nullptr, 0, &blend, ULW_ALPHA);
}

// One frame of the auto-hide fade: only the window's overall opacity changes,
// the bar drawn last stays. Ease-out, like the hover fade.
static void FadeOutStep(OverlayScrollbar* sb) {
    u64 elapsed = GetTickCount64() - sb->fadeOutStart;
    if (IsVisible(sb) || elapsed >= (u64)kAutoHideFadeMs) {
        KillTimer(sb->hwnd, OverlayScrollbar::kTimerFadeOut);
        if (!IsVisible(sb)) {
            MakeLayeredWindowTransparent(sb->hwnd);
        }
        return;
    }
    double rest = 1.0 - ((double)elapsed / (double)kAutoHideFadeMs);
    BLENDFUNCTION blend{};
    blend.BlendOp = AC_SRC_OVER;
    blend.SourceConstantAlpha = (BYTE)(rest * rest * rest * 255.0);
    blend.AlphaFormat = AC_SRC_ALPHA;
    UpdateLayeredWindow(sb->hwnd, nullptr, nullptr, nullptr, nullptr, nullptr, 0, &blend, ULW_ALPHA);
}

void SetState(OverlayScrollbar* sb, State newState) {
    if (sb->state == newState) {
        return;
    }
    bool wasVisible = IsVisible(sb);
    sb->state = newState;
    bool nowVisible = IsVisible(sb);

    OverlayScrollbarUpdatePos(sb);
    if (nowVisible) {
        // needed again mid-fade: PaintScrollbar() restores full opacity
        KillTimer(sb->hwnd, OverlayScrollbar::kTimerFadeOut);
        if (!wasVisible) {
            ShowScrollbarHwnd(sb);
        }
        PaintScrollbar(sb);
    } else {
        // Make fully transparent instead of ShowWindow(SW_HIDE) because
        // SW_HIDE can trigger Z-order changes that hide other popups
        sb->mouseOverThumb = false;
        if (wasVisible && newState == State::SmartInvisible) {
            // auto-hide fades out; the bar is already hidden as far as the
            // rest of the code is concerned (clicks pass through it)
            sb->fadeOutStart = GetTickCount64();
            SetTimer(sb->hwnd, OverlayScrollbar::kTimerFadeOut, kHoverAnimFrameMs, nullptr);
        } else {
            KillTimer(sb->hwnd, OverlayScrollbar::kTimerFadeOut);
            MakeLayeredWindowTransparent(sb->hwnd);
        }
    }

    KillTimer(sb->hwnd, OverlayScrollbar::kTimerAutoHide);
    if (newState == State::SmartThin) {
        SetTimer(sb->hwnd, OverlayScrollbar::kTimerAutoHide, sb->showAfterScrollMs, nullptr);
    }

    // themed bars share the corner square, which depends on both being shown
    if (sb->themed && wasVisible != nowVisible) {
        for (auto* other : gAllScrollbars) {
            if (other != sb && other->hwndOwner == sb->hwndOwner) {
                OverlayScrollbarUpdatePos(other);
                PaintScrollbar(other);
            }
        }
    }
}

// Restart the thin-bar auto-hide countdown (showAfterScrollMs). SetState only
// arms the timer on a state transition, so continuous scroll while already
// SmartThin would otherwise let the earlier mouse-stop / first-reveal timer
// fire and hide the bar mid-scroll.
void RestartSmartThinAutoHide(OverlayScrollbar* sb) {
    if (!sb->hwnd || sb->state != State::SmartThin) {
        return;
    }
    KillTimer(sb->hwnd, OverlayScrollbar::kTimerAutoHide);
    SetTimer(sb->hwnd, OverlayScrollbar::kTimerAutoHide, sb->showAfterScrollMs, nullptr);
}

// ---- Global mouse tracking ----

static void CALLBACK MouseTrackTimerProc(HWND /*hwnd*/, UINT /*msg*/, UINT_PTR /*idEvent*/, DWORD /*time*/) {
    // e.g. splitter drag uses SetCapture(); don't react to cursor proximity then
    if (GetCapture()) {
        return;
    }

    Point pt = GetCursorPosition();

    bool mouseMoved = (pt.x != gLastMousePos.x || pt.y != gLastMousePos.y);
    gLastMousePos = pt;

    HWND hwndForeground = GetForegroundWindow();

    for (auto* sb : gAllScrollbars) {
        if (!sb->hwnd || !sb->hwndOwner) {
            continue;
        }

        if (!IsActive(sb)) {
            continue;
        }

        // Check if mouse is over the owner window's client area, and not over a
        // different top-level window covering it (edit annotations, etc.)
        bool overOwner = MouseOverOwnerSurface(sb, pt);

        // Is the mouse over the band the thick scrollbar occupies? Being merely
        // near it isn't enough: the thick bar used to pop out while the mouse
        // was still over the page, which is distracting while reading
        Rect sbRect = GetScrollbarScreenRect(sb);
        bool overScrollbar = sbRect.Contains(pt) && overOwner;

        // the native theme draws the whole bar differently while hovered, also
        // in an inactive window
        if (sb->themed && !sb->isDragging && sb->mouseOverBand != overScrollbar) {
            sb->mouseOverBand = overScrollbar;
            StartHoverAnim(sb, overScrollbar);
            PaintScrollbar(sb);
        }

        // Only process scrollbars whose owner is in the active window hierarchy
        bool ownerActive = IsOrIsParentOf(hwndForeground, sb->hwndOwner);
        if (!ownerActive) {
            // If we were showing, hide
            if (IsVisible(sb)) {
                if (!sb->isDragging) {
                    HideScrollbarWindow(sb);
                }
            }
            continue;
        }

        if (sb->isDragging) {
            // Don't change state while dragging
            continue;
        }

        if (gOverlayScrollbarSuppressThick) {
            continue;
        }

        if (overScrollbar) {
            // Mouse is over the scrollbar area - show thick
            if (!IsThick(sb)) {
                ShowScrollbarWindow(sb, true);
            }
            // Update thumb hover state
            Point clientPt = HwndScreenToClient(sb->hwnd, pt);
            Rect thumbRc = GetThumbRect(sb);
            bool wasOver = sb->mouseOverThumb;
            sb->mouseOverThumb = thumbRc.Contains(clientPt);
            if (wasOver != sb->mouseOverThumb) {
                PaintScrollbar(sb);
            }
        } else if (overOwner && mouseMoved) {
            // Mouse is over owner and moving, but not over the scrollbar - show thin
            // IsThick() means transitioning from thick to thin
            if (IsThick(sb) || sb->state != State::SmartThin) {
                ShowScrollbarWindow(sb, false);
            }
            // Reset the auto-hide timer since mouse is moving
            KillTimer(sb->hwnd, OverlayScrollbar::kTimerAutoHide);
            SetTimer(sb->hwnd, OverlayScrollbar::kTimerAutoHide, sb->hideAfterMouseStopMs, nullptr);
        } else if (IsThick(sb) && !overOwner) {
            // Mouse left the owner area while thick - transition to hidden
            HideScrollbarWindow(sb);
        }
        // If mouse is over owner but not moving, the existing auto-hide timer handles it
    }
}

static void StartMouseTracking() {
    if (gMouseTrackTimer) {
        return;
    }
    gLastMousePos = {-1, -1};
    gMouseTrackTimer = SetTimer(nullptr, kMouseTrackTimerID, kMouseTrackIntervalMs, MouseTrackTimerProc);
}

static void StopMouseTracking() {
    if (gMouseTrackTimer) {
        KillTimer(nullptr, gMouseTrackTimer);
        gMouseTrackTimer = 0;
    }
}

// ---- WndProc for scrollbar window (handles clicks, drag, wheel) ----

static LRESULT CALLBACK WndProcOverlayScrollbar(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    OverlayScrollbar* sb = (OverlayScrollbar*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if (!sb) {
        return DefWindowProcW(hwnd, msg, wp, lp);
    }

    switch (msg) {
        case WM_TIMER:
            if (wp == OverlayScrollbar::kTimerAutoHide) {
                if (!sb->isDragging) {
                    HideScrollbarWindow(sb);
                }
                return 0;
            }
            if (wp == OverlayScrollbar::kTimerFadeOut) {
                FadeOutStep(sb);
                return 0;
            }
            if (wp == OverlayScrollbar::kTimerHoverAnim) {
                if (HoverAnimProgress(sb) >= 255) {
                    KillTimer(hwnd, OverlayScrollbar::kTimerHoverAnim);
                    sb->hoverAnimMs = 0;
                }
                PaintScrollbar(sb);
                return 0;
            }
            if (wp == OverlayScrollbar::kTimerRepeatScroll) {
                if (sb->repeatScrollCode == 0) {
                    KillTimer(hwnd, OverlayScrollbar::kTimerRepeatScroll);
                    return 0;
                }
                SendScrollMsg(sb, ScrollMsgForType(sb), MAKEWPARAM(sb->repeatScrollCode, 0));
                if (sb->repeatIsInitial) {
                    // switch from initial delay to repeat rate
                    sb->repeatIsInitial = false;
                    UINT repeatMs = 0;
                    SystemParametersInfoW(SPI_GETKEYBOARDSPEED, 0, &repeatMs, 0);
                    // SPI_GETKEYBOARDSPEED returns 0-31, map to ~33-500ms (same as OS key repeat)
                    repeatMs = 400 - (repeatMs * 12);
                    SetTimer(hwnd, OverlayScrollbar::kTimerRepeatScroll, repeatMs, nullptr);
                }
                return 0;
            }
            break;

        case WM_MOUSEMOVE: {
            int mx = GET_X_LPARAM(lp);
            int my = GET_Y_LPARAM(lp);

            if (sb->isDragging) {
                int ptInTrack = IsVert(sb) ? my : mx;
                Rect track = GetTrackRect(sb);
                int range = sb->nMax - sb->nMin + 1;
                int thumbLen = MulDiv(IsVert(sb) ? track.dy : track.dx, (int)sb->nPage, range);
                int minThumb = DpiScale(kMinThumbSize);
                thumbLen = std::max(thumbLen, minThumb);
                int trackLen = IsVert(sb) ? track.dy : track.dx;
                int scrollableTrack = trackLen - thumbLen;
                int scrollableRange = range - (int)sb->nPage;

                int dragDelta = ptInTrack - sb->dragStartY;
                int newPos = sb->dragStartPos;
                if (scrollableTrack > 0 && scrollableRange > 0) {
                    newPos = sb->dragStartPos + MulDiv(dragDelta, scrollableRange, scrollableTrack);
                }
                newPos = setMinMax(newPos, sb->nMin, sb->nMax - (int)sb->nPage + 1);
                sb->nTrackPos = newPos;
                PaintScrollbar(sb);
                SendScrollMsg(sb, ScrollMsgForType(sb), MAKEWPARAM(SB_THUMBTRACK, newPos));
                return 0;
            }

            // Thumb hover is handled by the global tracker, but also handle here
            // for responsiveness when already thick
            if (IsThick(sb)) {
                Rect thumbRc = GetThumbRect(sb);
                bool wasOver = sb->mouseOverThumb;
                sb->mouseOverThumb = thumbRc.Contains(Point(mx, my));
                if (wasOver != sb->mouseOverThumb) {
                    PaintScrollbar(sb);
                }
            }
            return 0;
        }

        case WM_LBUTTONDOWN: {
            int mx = GET_X_LPARAM(lp);
            int my = GET_Y_LPARAM(lp);
            if (OverCornerGrip(sb, Point(mx, my))) {
                // the size grip resizes the frame, as a native one does
                HWND root = GetAncestor(sb->hwndOwner, GA_ROOT);
                PostMessageW(root, WM_SYSCOMMAND, SC_SIZE | WMSZ_BOTTOMRIGHT, 0);
                return 0;
            }
            SetCapture(hwnd);

            if (IsThick(sb)) {
                Rect arrowTop = GetArrowTopRect(sb);
                Rect arrowBot = GetArrowBottomRect(sb);
                Point pt(mx, my);

                if (arrowTop.Contains(pt)) {
                    // SB_LINEUP == SB_LINELEFT, but spell out which axis we mean
                    UINT code = IsVert(sb) ? SB_LINEUP : SB_LINELEFT; // NOLINT(bugprone-branch-clone)
                    SendScrollMsg(sb, ScrollMsgForType(sb), MAKEWPARAM(code, 0));
                    sb->repeatScrollCode = code;
                    sb->repeatIsInitial = true;
                    UINT delayMs = 0;
                    SystemParametersInfoW(SPI_GETKEYBOARDDELAY, 0, &delayMs, 0);
                    delayMs = 250 + (delayMs * 250); // 0-3 maps to 250-1000ms
                    SetTimer(hwnd, OverlayScrollbar::kTimerRepeatScroll, delayMs, nullptr);
                    return 0;
                }
                if (arrowBot.Contains(pt)) {
                    // SB_LINEDOWN == SB_LINERIGHT, but spell out which axis we mean
                    UINT code = IsVert(sb) ? SB_LINEDOWN : SB_LINERIGHT; // NOLINT(bugprone-branch-clone)
                    SendScrollMsg(sb, ScrollMsgForType(sb), MAKEWPARAM(code, 0));
                    sb->repeatScrollCode = code;
                    sb->repeatIsInitial = true;
                    UINT delayMs = 0;
                    SystemParametersInfoW(SPI_GETKEYBOARDDELAY, 0, &delayMs, 0);
                    delayMs = 250 + (delayMs * 250);
                    SetTimer(hwnd, OverlayScrollbar::kTimerRepeatScroll, delayMs, nullptr);
                    return 0;
                }
            }

            // Shift+click: jump thumb center to click position
            if (GetKeyState(VK_SHIFT) & 0x8000) {
                Rect track = GetTrackRect(sb);
                int range = sb->nMax - sb->nMin + 1;
                int trackLen = IsVert(sb) ? track.dy : track.dx;
                int thumbLen = MulDiv(trackLen, (int)sb->nPage, range);
                int minThumb = DpiScale(kMinThumbSize);
                thumbLen = std::max(thumbLen, minThumb);
                int scrollableTrack = trackLen - thumbLen;
                int scrollableRange = range - (int)sb->nPage;
                int clickInTrack = (IsVert(sb) ? my : mx) - (IsVert(sb) ? track.y : track.x);
                int thumbOffset = clickInTrack - (thumbLen / 2);
                thumbOffset = setMinMax(thumbOffset, 0, scrollableTrack);
                int newPos = sb->nMin;
                if (scrollableTrack > 0 && scrollableRange > 0) {
                    newPos = sb->nMin + MulDiv(thumbOffset, scrollableRange, scrollableTrack);
                }
                sb->nTrackPos = newPos;
                PaintScrollbar(sb);
                SendScrollMsg(sb, ScrollMsgForType(sb), MAKEWPARAM(SB_THUMBTRACK, newPos));
                ReleaseCapture();
                return 0;
            }

            Rect thumbRc = GetThumbRect(sb);
            Point pt(mx, my);
            if (thumbRc.Contains(pt)) {
                sb->isDragging = true;
                sb->dragStartY = IsVert(sb) ? my : mx;
                sb->dragStartPos = sb->nPos;
                sb->nTrackPos = sb->nPos;
                return 0;
            }

            Rect track = GetTrackRect(sb);
            if (track.Contains(pt)) {
                int clickPos = IsVert(sb) ? my : mx;
                int thumbMid = IsVert(sb) ? (thumbRc.y + (thumbRc.dy / 2)) : (thumbRc.x + (thumbRc.dx / 2));
                UINT code;
                if (clickPos < thumbMid) {
                    // SB_PAGEUP == SB_PAGELEFT (same for DOWN/RIGHT); spell out the axis
                    code = IsVert(sb) ? SB_PAGEUP : SB_PAGELEFT; // NOLINT(bugprone-branch-clone)
                } else {
                    code = IsVert(sb) ? SB_PAGEDOWN : SB_PAGERIGHT; // NOLINT(bugprone-branch-clone)
                }
                SendScrollMsg(sb, ScrollMsgForType(sb), MAKEWPARAM(code, 0));
                sb->repeatScrollCode = code;
                sb->repeatIsInitial = true;
                UINT delayMs = 0;
                SystemParametersInfoW(SPI_GETKEYBOARDDELAY, 0, &delayMs, 0);
                delayMs = 250 + (delayMs * 250);
                SetTimer(hwnd, OverlayScrollbar::kTimerRepeatScroll, delayMs, nullptr);
                return 0;
            }
            ReleaseCapture();
            return 0;
        }

        case WM_LBUTTONUP:
            if (sb->repeatScrollCode != 0) {
                sb->repeatScrollCode = 0;
                KillTimer(hwnd, OverlayScrollbar::kTimerRepeatScroll);
            }
            if (sb->isDragging) {
                sb->isDragging = false;
                sb->nPos = sb->nTrackPos;
                PaintScrollbar(sb);
                SendScrollMsg(sb, ScrollMsgForType(sb), MAKEWPARAM(SB_THUMBPOSITION, sb->nPos));
            }
            ReleaseCapture();
            return 0;

        case WM_MOUSEWHEEL:
        case WM_MOUSEHWHEEL:
            SendMessageW(sb->hwndOwner, msg, wp, lp);
            return 0;

        case WM_MOUSEACTIVATE:
            return MA_NOACTIVATE;

        case WM_SETCURSOR: {
            Point pt = HwndScreenToClient(hwnd, GetCursorPosition());
            if (OverCornerGrip(sb, pt)) {
                SetCursor(GetCachedCursor(IDC_SIZENWSE));
                return TRUE;
            }
            break;
        }

        case WM_NCHITTEST: {
            // pass through rightmost 2px of vertical scrollbar for frame resize
            if (IsVert(sb)) {
                int x = GET_X_LPARAM(lp);
                Rect rc = HwndWindowRect(hwnd);
                if ((rc.x + rc.dx - x) <= 2) {
                    return HTTRANSPARENT;
                }
            }
            LRESULT def = DefWindowProcW(hwnd, msg, wp, lp);
            if (def == HTNOWHERE) {
                return HTCLIENT;
            }
            return def;
        }
    }

    return DefWindowProcW(hwnd, msg, wp, lp);
}

static void RegisterScrollbarClass() {
    if (gScrollbarClassRegistered) {
        return;
    }
    WNDCLASSEXW wcex{};
    wcex.cbSize = sizeof(wcex);
    wcex.style = CS_HREDRAW | CS_VREDRAW;
    wcex.lpfnWndProc = WndProcOverlayScrollbar;
    wcex.hInstance = GetModuleHandleW(nullptr);
    wcex.hCursor = GetCachedCursor(IDC_ARROW);
    wcex.lpszClassName = kOverlayScrollbarClass;
    RegisterClassExW(&wcex);
    gScrollbarClassRegistered = true;
}

OverlayScrollbar* OverlayScrollbarCreate(HWND hwndOwner, OverlayScrollbar::Type type, OverlayScrollbar::Mode mode) {
    RegisterScrollbarClass();

    auto* sb = new OverlayScrollbar();
    sb->hwndOwner = hwndOwner;
    sb->type = type;
    sb->mode = mode;
    sb->thinWidth = DpiScale(4);
    sb->thickWidth = DpiScale(16);
    int sysWidth = DpiGetSystemMetrics(IsVert(sb) ? SM_CXVSCROLL : SM_CYHSCROLL);
    if (sysWidth > 0) {
        sb->thickWidth = sysWidth;
    }
    // with visual styles, look like a native scrollbar: its width in every state
    sb->themed = IsAppThemed() && sysWidth > 0;
    if (sb->themed) {
        sb->thinWidth = sysWidth;
    }
    DWORD exStyle = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
    DWORD style = WS_POPUP;

    // use the top-level ancestor as owner so the scrollbar stays above its
    // own window but doesn't cover other application windows
    HWND hwndTopLevel = GetAncestor(hwndOwner, GA_ROOT);
    sb->hwnd = CreateWindowExW(exStyle, kOverlayScrollbarClass, nullptr, style, 0, 0, 1, 1, hwndTopLevel, nullptr,
                               GetModuleHandleW(nullptr), nullptr);
    SetWindowLongPtrW(sb->hwnd, GWLP_USERDATA, (LONG_PTR)sb);

    // Register for global mouse tracking
    VecAppend(gAllScrollbars, sb);
    StartMouseTracking();

    return sb;
}

void OverlayScrollbarDestroy(OverlayScrollbar* sb) {
    if (!sb) {
        return;
    }

    // Unregister from global mouse tracking
    VecRemove(gAllScrollbars, sb);
    if (len(gAllScrollbars) == 0) {
        StopMouseTracking();
    }

    if (sb->hwnd) {
        KillTimer(sb->hwnd, OverlayScrollbar::kTimerAutoHide);
        DestroyWindow(sb->hwnd);
    }
    delete sb;
}

// Same API as SetScrollInfo / GetScrollInfo
void OverlayScrollbarSetInfo(OverlayScrollbar* sb, const SCROLLINFO* si, bool redraw) {
    if (!sb) {
        return;
    }
    bool changed = false;
    if (si->fMask & SIF_RANGE) {
        if (sb->nMin != si->nMin || sb->nMax != si->nMax) {
            changed = true;
        }
        sb->nMin = si->nMin;
        sb->nMax = si->nMax;
    }
    if (si->fMask & SIF_PAGE) {
        if (sb->nPage != si->nPage) {
            changed = true;
        }
        sb->nPage = si->nPage;
    }
    if (si->fMask & SIF_POS) {
        if (sb->nPos != si->nPos) {
            changed = true;
        }
        sb->nPos = si->nPos;
    }

    if (redraw && changed) {
        // Scroll moved: re-reveal the thin smart bar if auto-hidden, repaint the
        // thumb, and keep the auto-hide timer alive while scrolling continues
        // (wheel / keyboard / smooth-scroll ticks — not only mouse motion).
        if (IsVisible(sb)) {
            PaintScrollbar(sb);
            if (sb->state == State::SmartThin) {
                RestartSmartThinAutoHide(sb);
            }
        } else {
            ShowScrollbarWindow(sb, false);
        }
    }
}

void OverlayScrollbarGetInfo(OverlayScrollbar* sb, SCROLLINFO* si) {
    if (!sb) {
        return;
    }
    if (si->fMask & SIF_RANGE) {
        si->nMin = sb->nMin;
        si->nMax = sb->nMax;
    }
    if (si->fMask & SIF_PAGE) {
        si->nPage = sb->nPage;
    }
    if (si->fMask & SIF_POS) {
        si->nPos = sb->nPos;
    }
    if (si->fMask & SIF_TRACKPOS) {
        si->nTrackPos = sb->nTrackPos;
    }
}

// Call when owner window moves/resizes
void OverlayScrollbarUpdatePos(OverlayScrollbar* sb) {
    if (!sb || !sb->hwnd || !sb->hwndOwner) {
        return;
    }

    Rect ownerRc = HwndWindowRect(sb->hwndOwner);

    int scrollW = ScaledWidth(sb, IsThick(sb));
    int x, y, w, h;

    // Check if the sibling scrollbar (other orientation, same owner) is thick
    bool siblingThick = false;
    for (auto* other : gAllScrollbars) {
        if (other != sb && other->hwndOwner == sb->hwndOwner && IsThick(other)) {
            siblingThick = true;
            break;
        }
    }
    int siblingInset = 0;
    if (IsThick(sb) && siblingThick) {
        siblingInset = scrollW;
    }
    if (sb->themed) {
        // like native scrollbars: when both show, the horizontal bar stops
        // short and the vertical one runs on to draw the corner square
        bool siblingVisible = false;
        for (auto* other : gAllScrollbars) {
            if (other != sb && other->hwndOwner == sb->hwndOwner && IsVisible(other)) {
                siblingVisible = true;
            }
        }
        bool both = IsVisible(sb) && siblingVisible;
        sb->cornerDy = (IsVert(sb) && both) ? scrollW : 0;
        siblingInset = (!IsVert(sb) && both) ? scrollW : 0;
    }

    if (IsVert(sb)) {
        x = ownerRc.x + ownerRc.dx - scrollW;
        y = ownerRc.y;
        w = scrollW;
        h = ownerRc.dy - siblingInset;
    } else {
        x = ownerRc.x;
        y = ownerRc.y + ownerRc.dy - scrollW;
        w = ownerRc.dx - siblingInset;
        h = scrollW;
    }

    LONG_PTR exStyle = GetWindowLongPtrW(sb->hwnd, GWL_EXSTYLE);
    if (IsVisible(sb)) {
        exStyle &= ~WS_EX_TRANSPARENT;
    } else {
        exStyle |= WS_EX_TRANSPARENT;
    }
    SetWindowLongPtrW(sb->hwnd, GWL_EXSTYLE, exStyle);

    // SWP_NOOWNERZORDER: raising an owned popup otherwise raises the owner
    // frame over other top-level windows (command palette, annotations).
    UINT swpFlags = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    HWND insertAfter = nullptr;
    // re-show the window if the state says it should be visible
    // (RelayoutFrame hides overlay scrollbar windows with SW_HIDE
    // to prevent them from appearing at stale positions)
    if (IsVisible(sb) && !HwndIsVisible(sb->hwnd)) {
        swpFlags |= SWP_SHOWWINDOW;
        insertAfter = ScrollbarZOrderAfter(sb);
    } else {
        swpFlags |= SWP_NOZORDER;
    }
    SetWindowPos(sb->hwnd, insertAfter, x, y, w, h, swpFlags);
}

// Hide the scrollbar window without stealing activation from other windows.
// Uses SWP_HIDEWINDOW | SWP_NOACTIVATE instead of ShowWindow(SW_HIDE).
void OverlayScrollbarHide(OverlayScrollbar* sb) {
    if (!sb || !sb->hwnd) {
        return;
    }
    SetWindowPos(sb->hwnd, nullptr, 0, 0, 0, 0,
                 SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
}

// Show/hide
void OverlayScrollbarShow(OverlayScrollbar* sb, bool show) {
    if (!sb) {
        return;
    }
    if (!show) {
        if (!IsActive(sb)) {
            return;
        }
        SetState(sb, State::Hidden);
        return;
    }

    // Already painted thin/thick — nothing to do. SmartInvisible still has an
    // IsWindowVisible layered HWND (fully transparent), so do not treat that as
    // shown: keyboard scroll / UpdateScrollbars must re-reveal it (#5850).
    if (IsVisible(sb) && HwndIsVisible(sb->hwnd)) {
        return;
    }
    if (!IsActive(sb) || sb->state == State::SmartInvisible) {
        ShowScrollbarWindow(sb, false);
        return;
    }
    // re-show if window was temporarily hidden (e.g. during relayout)
    OverlayScrollbarUpdatePos(sb);
    ShowScrollbarHwnd(sb);
    PaintScrollbar(sb);
}
