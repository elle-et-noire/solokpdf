/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

#include "base/Base.h"

#include "base/GdiPlusUtil.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/PlatformFont.h"
#include "gui/Gfx.h"
#include "gui/VirtCtrl.h"
#include "gui/win/VirtTreeState.h"

// must be last due to assert() over-write
#include "base/tests/UtAssert.h"

// Unit tests for Table (ILayout grid). VirtSpacer is the leaf: a fixed
// ideal size and no HWND, so a whole table can be laid out and its geometry
// asserted. CollectVirtCtrls finds the cell VirtCtrls as tops.

static bool VirtCtrlRectEq(const Rect& r, int x, int y, int dx, int dy) {
    return r.x == x && r.y == y && r.dx == dx && r.dy == dy;
}

static void Table_TestGrid() {
    auto* t = new Table();
    t->SetSize(2, 2);
    t->colGap = 10;
    t->rowGap = 4;
    auto* a = new VirtSpacer(20, 10);
    auto* b = new VirtSpacer(40, 30);
    auto* c = new VirtSpacer(30, 20);
    t->SetCell(0, 0, a);
    t->SetCell(0, 1, b);
    t->SetCell(1, 0, c);
    Size sz = t->Layout(ExpandInf());
    // a column is as wide as its widest cell, a row as tall as its tallest
    utassert(t->ColWidth(0) == 30 && t->ColWidth(1) == 40);
    utassert(t->RowHeight(0) == 30 && t->RowHeight(1) == 20);
    utassert(sz.dx == 30 + 10 + 40 && sz.dy == 30 + 4 + 20);
    t->SetBounds(Rect{0, 0, sz.dx, sz.dy});
    utassert(VirtCtrlRectEq(a->lastBounds, 0, 0, 20, 10));
    utassert(VirtCtrlRectEq(b->lastBounds, 40, 0, 40, 30));
    utassert(VirtCtrlRectEq(c->lastBounds, 0, 34, 30, 20));
    // an empty cell doesn't disturb the tracks
    utassert(t->GetCell(1, 1) == nullptr);
    delete t;
}

static void Table_TestAlign() {
    auto* t = new Table();
    t->SetSize(3, 2);
    // sets col 0 to 100 wide and row 0 to 40 tall, so the other cells have
    // room to be aligned in
    auto* big = new VirtSpacer(100, 40);
    auto* bottom = new VirtSpacer(20, 10);
    auto* center = new VirtSpacer(20, 10);
    auto* stretch = new VirtSpacer(20, 10);
    t->SetCell(0, 0, big);
    t->SetCell(0, 1, bottom).alignV = CrossAxisAlign::CrossEnd;
    t->SetCell(1, 0, center).alignH = CrossAxisAlign::CrossCenter;
    t->SetCell(2, 0, stretch).alignH = CrossAxisAlign::Stretch;
    Size sz = t->Layout(ExpandInf());
    t->SetBounds(Rect{0, 0, sz.dx, sz.dy});
    // 20 wide centered in the 100-wide column -> x = 40
    utassert(VirtCtrlRectEq(center->lastBounds, 40, 40, 20, 10));
    // 10 tall pushed to the bottom of the 40-tall row
    utassert(VirtCtrlRectEq(bottom->lastBounds, 100, 30, 20, 10));
    // stretched to the full column width
    utassert(VirtCtrlRectEq(stretch->lastBounds, 0, 50, 100, 10));
    delete t;
}

static void Table_TestSpan() {
    auto* t = new Table();
    t->SetSize(2, 2);
    t->colGap = 10;
    auto* wide = new VirtSpacer(100, 10);
    auto* a = new VirtSpacer(20, 10);
    auto* b = new VirtSpacer(30, 10);
    t->SetCell(0, 0, wide, 1, 2);
    t->SetCell(1, 0, a);
    t->SetCell(1, 1, b);
    utassert(t->CellAt(0, 1)->covered);
    Size sz = t->Layout(ExpandInf());
    // the columns give the spanning cell only 20 + 10 + 30, so both grow by 20
    utassert(t->ColWidth(0) == 40 && t->ColWidth(1) == 50);
    utassert(sz.dx == 100);
    t->SetBounds(Rect{0, 0, sz.dx, sz.dy});
    utassert(VirtCtrlRectEq(wide->lastBounds, 0, 0, 100, 10));
    utassert(b->lastBounds.x == 50);
    delete t;

    // the same for rows
    auto* t2 = new Table();
    t2->SetSize(2, 2);
    t2->rowGap = 6;
    auto* tall = new VirtSpacer(10, 100);
    t2->SetCell(0, 0, tall, 2, 1);
    t2->SetCell(0, 1, new VirtSpacer(10, 20));
    t2->SetCell(1, 1, new VirtSpacer(10, 30));
    Size sz2 = t2->Layout(ExpandInf());
    // rows of 20 and 30 (+ the 6 gap) leave 44 missing, split evenly
    utassert(t2->RowHeight(0) == 42 && t2->RowHeight(1) == 52);
    utassert(sz2.dy == 100);
    t2->SetBounds(Rect{0, 0, sz2.dx, sz2.dy});
    utassert(VirtCtrlRectEq(tall->lastBounds, 0, 0, 10, 100));
    delete t2;
}

// the cells' children must be reachable as tops through CollectVirtCtrls, or
// the links of a table-laid-out screen (About) stop being clickable
static void Table_TestHitTest() {
    auto* t = new Table();
    t->SetSize(1, 2);
    t->colGap = 10;
    auto* a = new VirtSpacer(20, 10);
    auto* b = new VirtSpacer(30, 10);
    // a spacer is decorative by default; make these hit targets
    a->SetFlag(vwfNoHitTest, false);
    b->SetFlag(vwfNoHitTest, false);
    t->SetCell(0, 0, a);
    t->SetCell(0, 1, b);
    Size sz = t->Layout(ExpandInf());
    t->SetBounds(Rect{5, 7, sz.dx, sz.dy});

    VirtRoot root((HWND)1);
    root.bounds = {0, 0, 200, 100};
    Vec<VirtCtrl*> tops;
    CollectVirtCtrls(t, tops);
    root.SetTops(tops);

    Point local{0, 0};
    utassert(ElementFromPoint(&root, {6, 8}, &local) == a);
    utassert(ElementFromPoint(&root, {40, 8}, &local) == b);
    // the gap between the columns is a miss
    utassert(ElementFromPoint(&root, {30, 8}, &local) == nullptr);
    delete t;
}

// a layout tree mixing plain layouts and virtual controls yields the virtual
// ones, in layout order, without descending into their own children
static void CollectVirtCtrls_Test() {
    Vec<VirtCtrl*> out;
    CollectVirtCtrls(nullptr, out);
    utassert(len(out) == 0);

    // a tree of no virtual controls yields none
    auto* plain = new VBox();
    plain->AddChild(new Spacer(10, 10));
    CollectVirtCtrls(plain, out);
    utassert(len(out) == 0);
    delete plain;

    auto* box = new VBox();
    auto* first = new VirtSpacer(10, 10);
    auto* nested = new VirtSpacer(10, 10);
    auto* inner = new VirtSpacer(10, 10);
    // a child of a virtual control is not top-level: `nested` paints it
    nested->AddChild(inner);
    box->AddChild(new Spacer(5, 5));
    box->AddChild(first);
    box->AddChild(new Padding(nested, DefaultInsets()));
    CollectVirtCtrls(box, out);
    utassert(len(out) == 2);
    utassert(out[0] == first);
    utassert(out[1] == nested);
    delete box;
}

static void CollectTabStops_Test() {
    Vec<TabStop> out;
    CollectTabStops(nullptr, out);
    utassert(len(out) == 0);

    // only what can take focus is a stop, in layout order
    auto* box = new VBox();
    auto* b1 = new VirtButton(StrL("one"));
    auto* b2 = new VirtButton(StrL("two"));
    box->AddChild(new Spacer(5, 5));
    box->AddChild(new VirtSpacer(10, 10));
    box->AddChild(b1);
    box->AddChild(new Padding(b2, DefaultInsets()));
    CollectTabStops(box, out);
    utassert(len(out) == 2);
    utassert(out[0].vwnd == b1 && !out[0].ctrl);
    utassert(out[1].vwnd == b2);

    // a collapsed subtree is out of the ring
    VecReset(out);
    b1->SetVisibility(Visibility::Collapse);
    CollectTabStops(box, out);
    utassert(len(out) == 1);
    utassert(out[0].vwnd == b2);
    delete box;
}

static void ScrollBox_Test() {
    auto* inner = new VBox();
    inner->AddChild(new Spacer(40, 200));
    auto* sb = new ScrollBox(inner);
    Size full = sb->Layout(ExpandInf());
    utassert(full.dy == 200);
    Size view = sb->Layout(Tight({40, 80}));
    utassert(view.dy == 80);
    utassert(sb->contentSize.dy == 200);
    sb->SetBounds({0, 0, 40, 80});
    utassert(sb->MaxScrollY() == 120);
    utassert(sb->ScrollTo(50));
    utassert(sb->scrollY == 50);
    utassert(!sb->ScrollTo(50));
    utassert(sb->ScrollTo(999));
    utassert(sb->scrollY == 120);
    delete sb;
}

// #6203: a Horiz splitter between stacked panes must not pin the column to the
// width it was last laid out at, or the sidebar can grow but never shrink
static void Splitter_ShrinkTest() {
    auto* top = new Spacer(300, 50);
    auto* bottom = new Spacer(300, 50);
    auto* split = new VirtSplitter();
    split->type = SplitterType::Horiz;
    split->thickness = 4;
    auto* col = new VBox();
    col->alignCross = CrossAxisAlign::Stretch;
    col->AddChild(top);
    col->AddChild(split);
    col->AddChild(bottom, 1);
    utassert(col->MinIntrinsicWidth(Inf) == 300);
    col->Layout(Loose({Inf, 200}));
    col->SetBounds({0, 0, 300, 200});
    utassert(split->bounds.dx == 300);

    top->dx = 200;
    bottom->dx = 200;
    utassert(col->MinIntrinsicWidth(Inf) == 200);
    delete col;
}

// a link wrapped onto a second line gets one underline per line (issue #6367)
static void TipLinkUnderlines_Test() {
    VirtRichText* tip = ParseTip(StrL("You can [have documents read aloud](CmdFoo)."));
    // lay out by hand: "You can have" / "documents read" / "aloud."
    int pos[][2] = {{0, 0}, {30, 0}, {60, 0}, {0, 20}, {60, 20}, {0, 40}, {30, 40}};
    int i = 0;
    for (TipWord* w = tip->words.next; w; w = w->next, i++) {
        utassert(i < dimofi(pos));
        w->x = pos[i][0];
        w->y = pos[i][1];
        w->dx = 25;
        w->dy = 16;
    }
    utassert(i == 7);
    TipLink* link = tip->links.next;
    utassert(link && !link->next);

    Vec<Rect> lines;
    TipLinkUnderlines(link, lines);
    utassert(len(lines) == 3);
    // underline sits 3px above the word's bottom
    utassert(VirtCtrlRectEq(lines[0], 60, 13, 25, 0));
    utassert(VirtCtrlRectEq(lines[1], 0, 33, 85, 0));
    utassert(VirtCtrlRectEq(lines[2], 0, 53, 25, 0));
    delete tip;
}

// #6386: the focus halo must not be clipped at either end of the track
static void Slider_HaloFitsTest() {
    auto* s = new VirtSlider();
    s->minVal = 0;
    s->maxVal = 12;
    Size sz = s->GetIdealSize();
    s->bounds = {0, 0, sz.dx, sz.dy};
    Rect local = {0, 0, sz.dx, sz.dy};
    int vals[] = {s->minVal, 5, s->maxVal};
    for (int v : vals) {
        s->value = v;
        Rect halo = s->ThumbHaloRectLocal();
        utassert(local.Intersect(halo) == halo);
    }
    delete s;
}

static void GdiFontDpiTest() {
    Gdiplus::Bitmap bmp96(32, 32, PixelFormat32bppARGB);
    Gdiplus::Bitmap bmp120(32, 32, PixelFormat32bppARGB);
    Gdiplus::Bitmap bmp144(32, 32, PixelFormat32bppARGB);
    bmp96.SetResolution(96, 96);
    bmp120.SetResolution(120, 120);
    bmp144.SetResolution(144, 144);
    Gdiplus::Graphics graphics96(&bmp96);
    Gdiplus::Graphics graphics120(&bmp120);
    Gdiplus::Graphics graphics144(&bmp144);
    InitGraphicsMode(&graphics96);
    InitGraphicsMode(&graphics120);
    InitGraphicsMode(&graphics144);
    GfxGdiplus gfx96(&graphics96);
    GfxGdiplus gfx120(&graphics120);
    GfxGdiplus gfx144(&graphics144);

    PlatformFont* fonts[] = {GetUserGuiFont(StrL("Segoe UI"), 20),
                             GetPlatformFont(StrL("Segoe UI"), 15.f, PlatformFontStyle::Regular)};
    for (PlatformFont* font : fonts) {
        utassert(font != nullptr);
        if (!font) {
            continue;
        }
        LOGFONTW lf{};
        utassert(GetObjectW(font->GetHFont(), sizeof(lf), &lf) != 0);
        bool owned = false;
        Gdiplus::Font* gdiFont = gfx96.GetGdiplusFont(font, &owned);
        utassert(gdiFont && gdiFont->GetUnit() == Gdiplus::UnitPixel);
        utassert(gdiFont && gdiFont->GetSize() == (float)abs(lf.lfHeight));
        if (owned) {
            delete gdiFont;
        }
        Str texts[] = {StrL("SolokPDF"), StrL("設定と文字")};
        for (Str text : texts) {
            Size a = gfx96.MeasureText(text, font);
            Size b = gfx120.MeasureText(text, font);
            Size c = gfx144.MeasureText(text, font);
            utassert(a.dx > 0 && a.dy > 0);
            utassert(abs(a.dx - b.dx) <= 1 && abs(a.dy - b.dy) <= 1);
            utassert(abs(a.dx - c.dx) <= 1 && abs(a.dy - c.dy) <= 1);
        }
    }
}

struct TreeStateTestModel : TreeModel {
    TreeItem Root() override { return 1; }
    Str Text(TreeItem) override { return StrL("item"); }
    TreeItem Parent(TreeItem item) override { return item == 2 || item == 5 ? 1 : item == 3 ? 2 : item == 4 ? 3 : 0; }
    int ChildCount(TreeItem item) override { return item == 1 ? 2 : item == 2 || item == 3 ? 1 : 0; }
    TreeItem ChildAt(TreeItem item, int idx) override { return item == 1 ? (idx == 0 ? 5 : 2) : item + 1; }
    bool IsExpanded(TreeItem item) override { return item == 3; }
    void SetUserData(TreeItem, uintptr_t) override { utassert(false); }
    uintptr_t GetUserData(TreeItem) override {
        utassert(false);
        return 0;
    }
};

struct DeepTreeTestModel : TreeModel {
    static constexpr int kDepth = 20000;
    TreeItem Root() override { return 1; }
    Str Text(TreeItem) override { return StrL("item"); }
    TreeItem Parent(TreeItem item) override { return item > 1 ? item - 1 : 0; }
    int ChildCount(TreeItem item) override { return item <= kDepth ? 1 : 0; }
    TreeItem ChildAt(TreeItem item, int) override { return item + 1; }
    bool IsExpanded(TreeItem) override { return true; }
    void SetUserData(TreeItem, uintptr_t) override { utassert(false); }
    uintptr_t GetUserData(TreeItem) override {
        utassert(false);
        return 0;
    }
};

struct BranchTreeTestModel : TreeModel {
    TreeItem Root() override { return 1; }
    Str Text(TreeItem) override { return StrL("item"); }
    TreeItem Parent(TreeItem item) override { return item % 2 ? item - 1 : 1; }
    int ChildCount(TreeItem item) override { return item == 1 ? 3 : item % 2 == 0 ? 1 : 0; }
    TreeItem ChildAt(TreeItem item, int idx) override { return item == 1 ? 2 + idx * 2 : item + 1; }
    bool IsExpanded(TreeItem) override { return false; }
    void SetUserData(TreeItem, uintptr_t) override { utassert(false); }
    uintptr_t GetUserData(TreeItem) override {
        utassert(false);
        return 0;
    }
};

static void VirtTreeStateTest() {
    TreeStateTestModel model;
    VirtTreeState tree;
    tree.SetModel(&model);
    utassert(len(tree.nodes) == 4 && len(tree.rows) == 2);
    utassert(tree.nodes[1].parent == -1 && tree.nodes[1].depth == 0 && tree.nodes[1].end == 4);
    utassert(tree.nodes[2].parent == 1 && tree.nodes[2].depth == 1 && tree.nodes[2].end == 4);
    utassert(tree.FindRow(2) == 1 && tree.FindRow(5) == 0 && tree.FindRow(3) == -1);
    utassert(tree.SetExpanded(2, VirtTreeExpansion::Expand));
    utassert(!tree.SetExpanded(2, VirtTreeExpansion::Expand));
    utassert(len(tree.rows) == 4 && tree.FindRow(4) == 3);
    tree.selected = 4;
    utassert(tree.SetExpanded(2, VirtTreeExpansion::Collapse));
    utassert(tree.selected == 2);
    utassert(tree.SetExpanded(2, VirtTreeExpansion::Expand));
    utassert(tree.FindRow(4) == 3);
    tree.selected = 4;
    utassert(tree.SetSubtree(2, VirtTreeExpansion::Collapse));
    utassert(tree.selected == 2);
    utassert(!tree.SetSubtree(2, VirtTreeExpansion::Collapse));
    utassert(len(tree.rows) == 2);
    utassert(tree.SetSubtree(2, VirtTreeExpansion::Expand));
    utassert(tree.FindRow(4) == 3);
    utassert(tree.SetRange(2, 4, VirtTreeExpansion::Collapse));
    utassert(tree.nodes[1].expanded && !tree.nodes[2].expanded);
    utassert(tree.SetRange(0, 4, VirtTreeExpansion::Expand));
    utassert(tree.nodes[1].expanded && tree.nodes[2].expanded);
    utassert(tree.SetRange(1, 4, VirtTreeExpansion::Collapse));
    utassert(!tree.nodes[1].expanded && !tree.nodes[2].expanded);
    utassert(tree.SetRange(0, 4, VirtTreeExpansion::Expand));
    utassert(!tree.SetExpanded(4, VirtTreeExpansion::Expand));
    utassert(tree.FindNode(99) == -1 && tree.FindRow(99) == -1);
    VirtTreeRef ref = tree.MakeRef(4);
    utassert(tree.FindRef(ref) == tree.FindNode(4));
    tree.selected = 4;
    u64 generation = tree.generation;
    tree.SetModel(&model);
    utassert(tree.generation != generation && tree.selected == TreeModel::kNullItem);
    utassert(tree.FindNode(4) >= 0 && tree.FindRef(ref) == -1);
    utassert(len(tree.rows) == 2);
    tree.SetModel(nullptr);
    utassert(len(tree.nodes) == 0 && len(tree.rows) == 0 && tree.FindNode(2) == -1);

    BranchTreeTestModel branches;
    tree.SetModel(&branches);
    utassert(tree.SetRange(2, len(tree.nodes), VirtTreeExpansion::Expand));
    utassert(!tree.nodes[0].expanded && tree.nodes[2].expanded && tree.nodes[4].expanded);
    utassert(tree.SetRange(0, len(tree.nodes), VirtTreeExpansion::Expand));
    utassert(len(tree.rows) == 6);
    utassert(tree.SetRange(2, len(tree.nodes), VirtTreeExpansion::Collapse));
    utassert(tree.nodes[0].expanded && !tree.nodes[2].expanded && !tree.nodes[4].expanded);
    utassert(len(tree.rows) == 4);

    DeepTreeTestModel deep;
    tree.SetModel(&deep);
    utassert(len(tree.rows) == DeepTreeTestModel::kDepth);
    utassert(tree.FindRow(DeepTreeTestModel::kDepth + 1) == DeepTreeTestModel::kDepth - 1);
    utassert(tree.SetSubtree(2, VirtTreeExpansion::Collapse));
    utassert(len(tree.rows) == 1);

    VirtTreeScroll scroll;
    utassert(VirtTreeRowEnd(0, 3, 20, 5, 100) == 20);
    utassert(VirtTreeRowEnd(2, 3, 20, 5, 100) == 65);
    utassert(VirtTreeRowEnd(0, 0, 20, 5, 100) == 0);
    utassert(VirtTreeRowEnd(INT_MAX - 1, INT_MAX, 20, 5, 100) == INT_MAX);
    VirtTreeScroll narrow;
    narrow.SetMetrics(24, 22);
    utassert(!narrow.EnsureVisible(0, VirtTreeRowEnd(0, 1, 20, 4, narrow.viewport)));
    scroll.SetMetrics(300000, 100);
    utassert(scroll.EnsureVisible(200000, 200020));
    utassert(scroll.pos == 199920);
    utassert(!scroll.EnsureVisible(200000, 200020));
    utassert(scroll.MoveBy(INT_MAX) && scroll.pos == 299900);
    utassert(scroll.MoveBy(INT_MIN) && scroll.pos == 0);
    scroll.SetPos(200000);
    scroll.SetMetrics(500, 100);
    utassert(scroll.pos == 400 && scroll.MaxPos() == 400);
    scroll.SetMetrics(10, 100);
    utassert(scroll.pos == 0 && scroll.MaxPos() == 0);
}

void VirtCtrl_UnitTests() {
    VirtTreeStateTest();
    GdiFontDpiTest();
    Slider_HaloFitsTest();
    TipLinkUnderlines_Test();
    Table_TestGrid();
    Table_TestAlign();
    Table_TestSpan();
    Table_TestHitTest();
    CollectVirtCtrls_Test();
    CollectTabStops_Test();
    ScrollBox_Test();
    Splitter_ShrinkTest();
}
