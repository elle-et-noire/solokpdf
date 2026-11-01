# Writes src/solokpdf/SolokPDF.ico: SumatraPDF's icon with its badge in the
# Light theme's link-color hue (OKLCH), so the exe
# differs from SumatraPDF's.
# AppIconTheme.cpp tints windows' icons the same way at run time.
# Run from the repo root: python tools/solokpdf/make-icon.py
import colorsys
import io
import math
import struct

from PIL import IcoImagePlugin

SRC = "src/shared/gfx/SumatraPDF-smaller.ico"
DST = "src/solokpdf/SolokPDF.ico"
LINK_COLOR = (0x00, 0x20, 0xA0)  # Light theme LinkColor
BADGE_COLOR = (0xFF, 0xF0, 0x00)  # the source badge
MIN_SAT = 0.25  # kMinSat in AppIconTheme.cpp


def to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def from_lin(c):
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def oklch(r, g, b):
    r, g, b = to_lin(r), to_lin(g), to_lin(b)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(A, B), math.atan2(B, A)


def rgb(L, C, h):
    A, B = C * math.cos(h), C * math.sin(h)
    l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return r, g, b


def in_gamut(c):
    return all(-1e-4 <= x <= 1 + 1e-4 for x in c)


def max_chroma(L, hue, C=0.4):
    lo, hi = 0.0, C
    if in_gamut(rgb(L, C, hue)):
        return C
    for _ in range(20):
        mid = (lo + hi) / 2
        if in_gamut(rgb(L, mid, hue)):
            lo = mid
        else:
            hi = mid
    return lo


# lightness where a hue reaches its highest chroma: yellow ~0.97, blue ~0.45
def cusp_lightness(hue):
    return max((i / 100 for i in range(1, 100)), key=lambda L: max_chroma(L, hue))


# the badge is yellow, lighter than most hues can be at full chroma; scale
# lightness halfway to the target hue's cusp so it stays colored
def lightness_scale(src_hue, hue):
    return (1 + cusp_lightness(hue) / cusp_lightness(src_hue)) / 2


# takes the target hue at scaled lightness, keeps chroma where sRGB allows
def rehue(r, g, b, hue, k):
    L, C, _ = oklch(r, g, b)
    L *= k
    lo, hi = 0.0, C
    if in_gamut(rgb(L, C, hue)):
        lo = C
    for _ in range(20):
        if hi - lo < 1e-4:
            break
        mid = (lo + hi) / 2
        if in_gamut(rgb(L, mid, hue)):
            lo = mid
        else:
            hi = mid
    return [min(1, max(0, from_lin(min(1, max(0, x))))) for x in rgb(L, lo, hue)]


def tint(img, hue, k):
    img = img.convert("RGBA")
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[1] < MIN_SAT:
                continue
            r, g, b = rehue(r / 255, g / 255, b / 255, hue, k)
            px[x, y] = (round(r * 255), round(g * 255), round(b * 255), a)
    return img


def main():
    hue = oklch(*(c / 255 for c in LINK_COLOR))[2]
    k = lightness_scale(oklch(*(c / 255 for c in BADGE_COLOR))[2], hue)
    with open(SRC, "rb") as f:
        ico = IcoImagePlugin.IcoFile(f)
        sizes = sorted({e.width for e in ico.entry}, reverse=True)
        images = [tint(ico.getimage((s, s), 32), hue, k) for s in sizes]

    # one 32-bit PNG entry per size
    pngs = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, "PNG")
        pngs.append(buf.getvalue())
    out = struct.pack("<HHH", 0, 1, len(images))
    off = 6 + 16 * len(images)
    for img, data in zip(images, pngs):
        dim = img.width if img.width < 256 else 0
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), off)
        off += len(data)
    with open(DST, "wb") as f:
        f.write(out + b"".join(pngs))


main()
