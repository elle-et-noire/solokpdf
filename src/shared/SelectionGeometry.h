/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

struct TextSel {
    int pageNo = 0;
    Rect rect;
    QuadF quad{};
};

// Dehyphenation removes both the trailing hyphen and the line-separator glyph,
// so adjacent coords can belong to different visual lines. Require at least
// half of the new glyph's height to overlap the current line box; this still
// keeps smaller subscript and superscript glyphs in the same run.
static bool IsGlyphOnVisualLine(Rect lineBox, Rect glyphBox) {
    int top = lineBox.y > glyphBox.y ? lineBox.y : glyphBox.y;
    int bottom = lineBox.y + lineBox.dy < glyphBox.y + glyphBox.dy ? lineBox.y + lineBox.dy : glyphBox.y + glyphBox.dy;
    return (bottom - top) * 2 >= glyphBox.dy;
}

inline void FillSelectionRects(Vec<TextSel>* result, int pageNo, Rect* coords, int textLen, int glyph, int length,
                               Rect mediabox, QuadF* glyphQuads = nullptr) {
    Rect *c = &coords[glyph], *end = c + length;
    while (c < end) {
        // skip line breaks (empty boxes: hard newlines and soft-join spaces)
        for (; c < end && !c->x && !c->dx; c++) {
            // no-op
        }
        if (c >= end) {
            break;
        }

        int runStart = (int)(c - coords);
        bool rotated = glyphQuads && glyphQuads[runStart].IsRotated();
        if (rotated) {
            for (; c < end && (c->x || c->dx); c++) {
                int ix = (int)(c - coords);
                if (ix > runStart && !IsGlyphOnVisualLine(coords[runStart], *c)) {
                    break;
                }
                Rect bbox = c->Intersect(mediabox);
                if (bbox.IsEmpty()) {
                    continue;
                }
                VecAppend(*result, TextSel{pageNo, bbox, glyphQuads[ix]});
            }
            continue;
        }

        Rect bbox;
        for (; c < end && (c->x || c->dx); c++) {
            if (!bbox.IsEmpty() && !IsGlyphOnVisualLine(bbox, *c)) {
                break;
            }
            bbox = bbox.Union(*c);
        }
        bbox = bbox.Intersect(mediabox);
        // skip text that's completely outside a page's mediabox
        if (bbox.IsEmpty()) {
            continue;
        }

        // Only clip against the next glyph when it is on this visual line.
        // At a dehyphenated break the next glyph belongs to the following line.
        bool overlapsVertically = c < coords + textLen && c->y < bbox.y + bbox.dy && c->y + c->dy > bbox.y;
        if (overlapsVertically && (c->x || c->dx) && bbox.x < c->x && bbox.x + bbox.dx > c->x) {
            bbox.dx = c->x - bbox.x;
        }

        VecAppend(*result, TextSel{pageNo, bbox, {}});
    }
}
