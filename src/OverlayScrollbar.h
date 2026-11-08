/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

// Overlay scrollbar - a semi-transparent top-level window that acts like
// a standard Windows scrollbar but floats over the owner window.

extern bool gOverlayScrollbarSuppressThick;

struct OverlayScrollbar {
    enum class Type {
        Vert,
        Horz,
    };

    // Smart: thin/thick transitions based on mouse proximity
    // Thick: always shown thick, no transitions
    enum class Mode {
        Smart,
        Thick,
    };

    enum class State {
        Hidden,         // not active, not shown
        SmartInvisible, // active but auto-hidden (Smart mode)
        SmartThin,      // shown thin (Smart mode)
        SmartThick,     // shown thick (Smart mode)
        AlwaysThick,    // always shown thick (Thick mode)
    };

    HWND hwnd = nullptr;      // the scrollbar top-level window
    HWND hwndOwner = nullptr; // positioned relative to this window; receives scroll messages
    Type type = Type::Vert;
    Mode mode = Mode::Smart;

    // scroll state (mirrors SCROLLINFO)
    int nMin = 0;
    int nMax = 0;
    uint nPage = 0;
    int nPos = 0;
    int nTrackPos = 0;

    int thinWidth = 0;
    int thickWidth = 0;
    // drawn with the native scrollbar theme: arrows always take their room
    bool themed = false;
    bool themeSet = false;  // SetWindowTheme() was called for themeDark
    bool themeDark = false; // window theme is DarkMode_Explorer
    bool mouseOverBand = false;
    int cornerDy = 0; // themed vertical bar: height of the corner square below it
    // themed hover cross-fade: when it started and how long it runs (0: none)
    u64 hoverAnimStart = 0;
    int hoverAnimMs = 0;
    u64 fadeOutStart = 0; // auto-hide fade-out

    // auto-hide timing (milliseconds)
    int showAfterScrollMs = 1500;    // how long to show thin bar after scroll info update
    int hideAfterMouseStopMs = 1500; // hide after mouse stops moving

    // internal state
    State state = State::Hidden;
    bool isDragging = false; // user is dragging the thumb
    int dragStartY = 0;      // mouse Y (or X for horz) when drag started
    int dragStartPos = 0;    // nPos when drag started
    bool mouseOverThumb = false;

    // repeat-scroll state (for held arrow/track clicks)
    UINT repeatScrollCode = 0;    // SB_LINEUP, SB_PAGEDOWN, etc.; 0 = not repeating
    bool repeatIsInitial = false; // true = waiting for initial delay, false = repeating

    // timer IDs
    static constexpr UINT_PTR kTimerAutoHide = 1;
    static constexpr UINT_PTR kTimerRepeatScroll = 2;
    static constexpr UINT_PTR kTimerHoverAnim = 3;
    static constexpr UINT_PTR kTimerFadeOut = 4;
};

// A vertical bar a list lays out itself (the thumbnails'), drawn like an
// always-shown overlay bar. Rects are relative to the bar.
struct ThemedBarLook {
    Rect track;
    Rect arrowStart;
    Rect arrowEnd;
    Rect thumb;
    bool hover = false;
    bool thumbHot = false;
    bool pressed = false;
};

struct Pixmap;
Pixmap* PaintThemedBar(Size, const ThemedBarLook&, int progress);
void PaintNativeScrollbars(HWND);
int ThemedBarHoverMs(bool hover);
int EaseOutProgress(u64 start, int ms);

OverlayScrollbar* OverlayScrollbarCreate(HWND hwndOwner, OverlayScrollbar::Type type,
                                         OverlayScrollbar::Mode mode = OverlayScrollbar::Mode::Smart);
void OverlayScrollbarDestroy(OverlayScrollbar* sb);

void OverlayScrollbarSetInfo(OverlayScrollbar* sb, const SCROLLINFO* si, bool redraw);
void OverlayScrollbarGetInfo(OverlayScrollbar* sb, SCROLLINFO* si);

void OverlayScrollbarUpdatePos(OverlayScrollbar* sb);

void OverlayScrollbarShow(OverlayScrollbar* sb, bool show);
void OverlayScrollbarRepaint(OverlayScrollbar* sb);
void OverlayScrollbarHide(OverlayScrollbar* sb);

void OverlayScrollbarNotifyScroll(OverlayScrollbar* sb);

void OverlayScrollbarSetMode(OverlayScrollbar* sb, OverlayScrollbar::Mode mode);

bool IsOverlayScrollbarVisible(OverlayScrollbar* sb);
