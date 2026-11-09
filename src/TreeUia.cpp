/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

#include "base/Base.h"
#include <uiautomation.h>
#include "base/Win.h"
#include "gui/UIModels.h"
#include "gui/win/VirtTreeState.h"
#include "uia/Common.h"
#include "TreeUia.h"

struct VirtTreeUiaItem;

BSTR VirtTreeName(HWND hwnd) {
    int length = GetWindowTextLengthW(hwnd);
    if (length <= 0) return SysAllocString(L"Tree");
    BSTR name = SysAllocStringLen(nullptr, length);
    if (!name) return nullptr;
    GetWindowTextW(hwnd, name, length + 1);
    return name;
}

struct VirtTreeUia : IRawElementProviderSimple,
                     IRawElementProviderFragment,
                     IRawElementProviderFragmentRoot,
                     ISelectionProvider,
                     IScrollProvider {
    AtomicInt refs;
    VirtTreeUiaData* data;

    explicit VirtTreeUia(VirtTreeUiaData* data) : refs(1), data(data) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID, IUnknown**) override;
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID, VARIANT*) override;
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple**) override;
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions*) override;
    HRESULT STDMETHODCALLTYPE Navigate(NavigateDirection, IRawElementProviderFragment**) override;
    HRESULT STDMETHODCALLTYPE GetRuntimeId(SAFEARRAY**) override;
    HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY**) override;
    HRESULT STDMETHODCALLTYPE SetFocus() override;
    HRESULT STDMETHODCALLTYPE get_BoundingRectangle(UiaRect*) override;
    HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot**) override;
    HRESULT STDMETHODCALLTYPE ElementProviderFromPoint(double, double, IRawElementProviderFragment**) override;
    HRESULT STDMETHODCALLTYPE GetFocus(IRawElementProviderFragment**) override;
    HRESULT STDMETHODCALLTYPE GetSelection(SAFEARRAY**) override;
    HRESULT STDMETHODCALLTYPE get_CanSelectMultiple(BOOL*) override;
    HRESULT STDMETHODCALLTYPE get_IsSelectionRequired(BOOL*) override;
    HRESULT STDMETHODCALLTYPE Scroll(ScrollAmount, ScrollAmount) override;
    HRESULT STDMETHODCALLTYPE SetScrollPercent(double, double) override;
    HRESULT STDMETHODCALLTYPE get_HorizontalScrollPercent(double*) override;
    HRESULT STDMETHODCALLTYPE get_VerticalScrollPercent(double*) override;
    HRESULT STDMETHODCALLTYPE get_HorizontalViewSize(double*) override;
    HRESULT STDMETHODCALLTYPE get_VerticalViewSize(double*) override;
    HRESULT STDMETHODCALLTYPE get_HorizontallyScrollable(BOOL*) override;
    HRESULT STDMETHODCALLTYPE get_VerticallyScrollable(BOOL*) override;
    HRESULT Item(int node, IRawElementProviderFragment** out);
};

struct VirtTreeUiaItem : IRawElementProviderSimple,
                         IRawElementProviderFragment,
                         IScrollItemProvider,
                         IExpandCollapseProvider,
                         ISelectionItemProvider {
    AtomicInt refs;
    VirtTreeUia* root;
    VirtTreeRef ref;

    VirtTreeUiaItem(VirtTreeUia* root, VirtTreeRef ref) : refs(1), root(root), ref(ref) { root->AddRef(); }
    ~VirtTreeUiaItem() { root->Release(); }
    int Node() const;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID, IUnknown**) override;
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID, VARIANT*) override;
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple**) override;
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions*) override;
    HRESULT STDMETHODCALLTYPE Navigate(NavigateDirection, IRawElementProviderFragment**) override;
    HRESULT STDMETHODCALLTYPE GetRuntimeId(SAFEARRAY**) override;
    HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY**) override;
    HRESULT STDMETHODCALLTYPE SetFocus() override;
    HRESULT STDMETHODCALLTYPE get_BoundingRectangle(UiaRect*) override;
    HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot**) override;
    HRESULT STDMETHODCALLTYPE ScrollIntoView() override;
    HRESULT STDMETHODCALLTYPE Expand() override;
    HRESULT STDMETHODCALLTYPE Collapse() override;
    HRESULT STDMETHODCALLTYPE get_ExpandCollapseState(ExpandCollapseState*) override;
    HRESULT STDMETHODCALLTYPE Select() override;
    HRESULT STDMETHODCALLTYPE AddToSelection() override;
    HRESULT STDMETHODCALLTYPE RemoveFromSelection() override;
    HRESULT STDMETHODCALLTYPE get_IsSelected(BOOL*) override;
    HRESULT STDMETHODCALLTYPE get_SelectionContainer(IRawElementProviderSimple**) override;
};

HRESULT STDMETHODCALLTYPE VirtTreeUia::QueryInterface(REFIID id, void** out) {
    static const QITAB qit[] = {QITABENT(VirtTreeUia, IRawElementProviderSimple),
                                QITABENT(VirtTreeUia, IRawElementProviderFragment),
                                QITABENT(VirtTreeUia, IRawElementProviderFragmentRoot),
                                QITABENT(VirtTreeUia, ISelectionProvider),
                                QITABENT(VirtTreeUia, IScrollProvider),
                                {nullptr}};
    return QISearch(this, qit, id, out);
}

ULONG STDMETHODCALLTYPE VirtTreeUia::AddRef() {
    return AtomicIntInc(&refs);
}
ULONG STDMETHODCALLTYPE VirtTreeUia::Release() {
    return ComRelease(&refs, [this] { delete this; });
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::GetPatternProvider(PATTERNID id, IUnknown** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    if (id == UIA_SelectionPatternId) *out = static_cast<ISelectionProvider*>(this);
    if (id == UIA_ScrollPatternId) *out = static_cast<IScrollProvider*>(this);
    if (*out) AddRef();
    return S_OK;
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::GetPropertyValue(PROPERTYID id, VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    if (id == UIA_ControlTypePropertyId) {
        out->vt = VT_I4;
        out->lVal = UIA_TreeControlTypeId;
    } else if (id == UIA_NamePropertyId) {
        out->vt = VT_BSTR;
        out->bstrVal = VirtTreeName(data->hwnd);
        if (!out->bstrVal) return E_OUTOFMEMORY;
    } else if (id == UIA_IsKeyboardFocusablePropertyId) {
        out->vt = VT_BOOL;
        out->boolVal = VARIANT_TRUE;
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::get_HostRawElementProvider(IRawElementProviderSimple** out) {
    return data ? UiaHostProviderFromHwnd(data->hwnd, out) : UIA_E_ELEMENTNOTAVAILABLE;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_ProviderOptions(ProviderOptions* out) {
    return UiaProviderOptions(out);
}

HRESULT VirtTreeUia::Item(int node, IRawElementProviderFragment** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    if (node < 0 || node >= len(data->state->nodes)) return S_OK;
    VirtTreeRef ref = data->state->MakeRef(data->state->nodes[node].item);
    *out = new VirtTreeUiaItem(this, ref);
    return S_OK;
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::Navigate(NavigateDirection dir, IRawElementProviderFragment** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    int n = len(data->state->nodes);
    if (!n) return S_OK;
    if (dir == NavigateDirection_FirstChild) return Item(0, out);
    if (dir == NavigateDirection_LastChild) {
        int node = 0;
        while (data->state->nodes[node].end < n) node = data->state->nodes[node].end;
        return Item(node, out);
    }
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::GetRuntimeId(SAFEARRAY** out) {
    return UiaReturnNull(out);
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::GetEmbeddedFragmentRoots(SAFEARRAY** out) {
    return UiaReturnNull(out);
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::SetFocus() {
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    ::SetFocus(data->hwnd);
    return ::GetFocus() == data->hwnd ? S_OK : E_FAIL;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_BoundingRectangle(UiaRect* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    Rect rc = HwndWindowRect(data->hwnd);
    *out = {(double)rc.x, (double)rc.y, (double)rc.dx, (double)rc.dy};
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_FragmentRoot(IRawElementProviderFragmentRoot** out) {
    return UiaRootFragmentRoot(data ? this : nullptr, out);
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::ElementProviderFromPoint(double x, double y, IRawElementProviderFragment** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    Point pt = HwndScreenToClient(data->hwnd, {(int)x, (int)y});
    Rect rc = HwndClientRect(data->hwnd);
    if (!rc.Contains(pt) || *data->rowDy <= 0) return S_OK;
    int row = (pt.y + data->scrollY->pos) / *data->rowDy;
    return row >= 0 && row < len(data->state->rows) ? Item(data->state->rows[row], out) : S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::GetFocus(IRawElementProviderFragment** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    if (::GetFocus() != data->hwnd) return S_OK;
    int node = data->state->FindNode(data->state->selected);
    if (node >= 0) return Item(node, out);
    *out = this;
    AddRef();
    return S_OK;
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::GetSelection(SAFEARRAY** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    int node = data->state->FindNode(data->state->selected);
    SAFEARRAY* items = SafeArrayCreateVector(VT_UNKNOWN, 0, node < 0 ? 0 : 1);
    if (!items) return E_OUTOFMEMORY;
    if (node >= 0) {
        IRawElementProviderFragment* fragment = nullptr;
        Item(node, &fragment);
        IRawElementProviderSimple* item = nullptr;
        HRESULT hr = fragment->QueryInterface(IID_PPV_ARGS(&item));
        fragment->Release();
        if (FAILED(hr)) {
            SafeArrayDestroy(items);
            return hr;
        }
        LONG idx = 0;
        hr = SafeArrayPutElement(items, &idx, item);
        item->Release();
        if (FAILED(hr)) {
            SafeArrayDestroy(items);
            return hr;
        }
    }
    *out = items;
    return S_OK;
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::get_CanSelectMultiple(BOOL* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = FALSE;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_IsSelectionRequired(BOOL* out) {
    return get_CanSelectMultiple(out);
}

static bool ValidAmount(ScrollAmount amount) {
    return amount >= ScrollAmount_LargeDecrement && amount <= ScrollAmount_SmallIncrement;
}

static bool ScrollAmountBy(VirtTreeScroll& scroll, ScrollAmount amount, int line) {
    switch (amount) {
        case ScrollAmount_LargeDecrement:
            return scroll.MoveBy(-scroll.viewport);
        case ScrollAmount_SmallDecrement:
            return scroll.MoveBy(-line);
        case ScrollAmount_LargeIncrement:
            return scroll.MoveBy(scroll.viewport);
        case ScrollAmount_SmallIncrement:
            return scroll.MoveBy(line);
        default:
            return false;
    }
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::Scroll(ScrollAmount horizontal, ScrollAmount vertical) {
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    if (!ValidAmount(horizontal) || !ValidAmount(vertical)) return E_INVALIDARG;
    if ((horizontal != ScrollAmount_NoAmount && data->scrollX->MaxPos() == 0) ||
        (vertical != ScrollAmount_NoAmount && data->scrollY->MaxPos() == 0))
        return UIA_E_INVALIDOPERATION;
    bool changed = ScrollAmountBy(*data->scrollX, horizontal, *data->rowDy);
    changed |= ScrollAmountBy(*data->scrollY, vertical, *data->rowDy);
    if (changed) data->onScroll.Call();
    return S_OK;
}

static bool ValidPercent(double percent) {
    return percent == UIA_ScrollPatternNoScroll || (percent >= 0 && percent <= 100);
}

HRESULT STDMETHODCALLTYPE VirtTreeUia::SetScrollPercent(double horizontal, double vertical) {
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    if (!ValidPercent(horizontal) || !ValidPercent(vertical)) return E_INVALIDARG;
    if ((horizontal != UIA_ScrollPatternNoScroll && data->scrollX->MaxPos() == 0) ||
        (vertical != UIA_ScrollPatternNoScroll && data->scrollY->MaxPos() == 0))
        return UIA_E_INVALIDOPERATION;
    bool changed = false;
    if (horizontal != UIA_ScrollPatternNoScroll)
        changed |= data->scrollX->SetPos((int)(horizontal * data->scrollX->MaxPos() / 100));
    if (vertical != UIA_ScrollPatternNoScroll)
        changed |= data->scrollY->SetPos((int)(vertical * data->scrollY->MaxPos() / 100));
    if (changed) data->onScroll.Call();
    return S_OK;
}

static double ScrollPercent(const VirtTreeScroll& scroll) {
    return scroll.MaxPos() ? (100.0 * scroll.pos / scroll.MaxPos()) : UIA_ScrollPatternNoScroll;
}
static double ViewPercent(const VirtTreeScroll& scroll) {
    return scroll.extent ? std::min(100.0, 100.0 * scroll.viewport / scroll.extent) : 100.0;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_HorizontalScrollPercent(double* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = ScrollPercent(*data->scrollX);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_VerticalScrollPercent(double* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = ScrollPercent(*data->scrollY);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_HorizontalViewSize(double* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = ViewPercent(*data->scrollX);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_VerticalViewSize(double* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = ViewPercent(*data->scrollY);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_HorizontallyScrollable(BOOL* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = data->scrollX->MaxPos() > 0;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUia::get_VerticallyScrollable(BOOL* out) {
    if (!out) return E_POINTER;
    if (!data) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = data->scrollY->MaxPos() > 0;
    return S_OK;
}

int VirtTreeUiaItem::Node() const {
    return root->data ? root->data->state->FindRef(ref) : -1;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::QueryInterface(REFIID id, void** out) {
    static const QITAB qit[] = {
        QITABENT(VirtTreeUiaItem, IRawElementProviderSimple), QITABENT(VirtTreeUiaItem, IRawElementProviderFragment),
        QITABENT(VirtTreeUiaItem, IScrollItemProvider),       QITABENT(VirtTreeUiaItem, IExpandCollapseProvider),
        QITABENT(VirtTreeUiaItem, ISelectionItemProvider),    {nullptr}};
    return QISearch(this, qit, id, out);
}
ULONG STDMETHODCALLTYPE VirtTreeUiaItem::AddRef() {
    return AtomicIntInc(&refs);
}
ULONG STDMETHODCALLTYPE VirtTreeUiaItem::Release() {
    return ComRelease(&refs, [this] { delete this; });
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::GetPatternProvider(PATTERNID id, IUnknown** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    if (id == UIA_ScrollItemPatternId) {
        *out = static_cast<IScrollItemProvider*>(this);
    } else if (id == UIA_SelectionItemPatternId) {
        *out = static_cast<ISelectionItemProvider*>(this);
    } else if (id == UIA_ExpandCollapsePatternId && root->data->state->nodes[Node()].childCount) {
        *out = static_cast<IExpandCollapseProvider*>(this);
    }
    if (*out) AddRef();
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::GetPropertyValue(PROPERTYID id, VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    int node = Node();
    if (node < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    auto* data = root->data;
    if (id == UIA_ControlTypePropertyId) {
        out->vt = VT_I4;
        out->lVal = UIA_TreeItemControlTypeId;
    } else if (id == UIA_NamePropertyId) {
        WStr name = ToWStrTemp(data->state->model->Text(ref.item));
        out->vt = VT_BSTR;
        out->bstrVal = SysAllocStringLen(name.s, len(name));
        if (!out->bstrVal) return E_OUTOFMEMORY;
    } else if (id == UIA_IsKeyboardFocusablePropertyId || id == UIA_HasKeyboardFocusPropertyId) {
        out->vt = VT_BOOL;
        bool focused = ::GetFocus() == data->hwnd && data->state->selected == ref.item;
        out->boolVal = id == UIA_IsKeyboardFocusablePropertyId || focused ? VARIANT_TRUE : VARIANT_FALSE;
    } else if (id == UIA_IsOffscreenPropertyId) {
        int row = data->state->FindRow(ref.item);
        i64 y = (i64)row * *data->rowDy - data->scrollY->pos;
        out->vt = VT_BOOL;
        out->boolVal = row < 0 || y + *data->rowDy <= 0 || y >= data->scrollY->viewport ? VARIANT_TRUE : VARIANT_FALSE;
    }
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::get_HostRawElementProvider(IRawElementProviderSimple** out) {
    return UiaReturnNull(out);
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::get_ProviderOptions(ProviderOptions* out) {
    return UiaProviderOptions(out);
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::Navigate(NavigateDirection dir, IRawElementProviderFragment** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    int node = Node();
    if (node < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    auto& nodes = root->data->state->nodes;
    int parent = nodes[node].parent;
    if (dir == NavigateDirection_Parent) {
        if (parent >= 0) return root->Item(parent, out);
        *out = root;
        root->AddRef();
    } else if (dir == NavigateDirection_FirstChild && nodes[node].childCount) {
        return root->Item(node + 1, out);
    } else if (dir == NavigateDirection_LastChild && nodes[node].childCount) {
        int child = node + 1;
        while (nodes[child].end < nodes[node].end) child = nodes[child].end;
        return root->Item(child, out);
    } else if (dir == NavigateDirection_NextSibling) {
        int next = nodes[node].end;
        if (next < len(nodes) && nodes[next].parent == parent) return root->Item(next, out);
    } else if (dir == NavigateDirection_PreviousSibling) {
        return root->Item(nodes[node].previous, out);
    }
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::GetRuntimeId(SAFEARRAY** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    int node = Node();
    if (node < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    SAFEARRAY* id = SafeArrayCreateVector(VT_I4, 0, 3);
    if (!id) return E_OUTOFMEMORY;
    LONG values[] = {UiaAppendRuntimeId, (LONG)ref.generation, node + 1};
    for (LONG i = 0; i < 3; i++) SafeArrayPutElement(id, &i, &values[i]);
    *out = id;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::GetEmbeddedFragmentRoots(SAFEARRAY** out) {
    return UiaReturnNull(out);
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::SetFocus() {
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    HRESULT hr = ScrollIntoView();
    if (FAILED(hr)) return hr;
    VirtTreeSelectEvent ev{ref.item, true, VirtTreeSelectReason::Accessibility};
    auto select = root->data->onSelect;
    select.Call(&ev);
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    return ::GetFocus() == root->data->hwnd ? S_OK : E_FAIL;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::get_BoundingRectangle(UiaRect* out) {
    if (!out) return E_POINTER;
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    auto* data = root->data;
    int row = data->state->FindRow(ref.item);
    if (row < 0) {
        *out = {};
        return S_OK;
    }
    Rect client = HwndClientRect(data->hwnd);
    Point pt = HwndClientToScreen(data->hwnd, {0, 0});
    *out = {(double)pt.x, (double)(pt.y + (i64)row * *data->rowDy - data->scrollY->pos), (double)client.dx,
            (double)*data->rowDy};
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::get_FragmentRoot(IRawElementProviderFragmentRoot** out) {
    return UiaRootFragmentRoot(Node() >= 0 ? root : nullptr, out);
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::ScrollIntoView() {
    int node = Node();
    if (node < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    auto* data = root->data;
    int row = data->state->FindRow(ref.item);
    bool changed = false;
    if (row < 0) {
        Vec<TreeItem> parents;
        for (int parent = data->state->nodes[node].parent; parent >= 0; parent = data->state->nodes[parent].parent) {
            VecAppend(parents, data->state->nodes[parent].item);
        }
        VecReverse(parents);
        for (TreeItem parent : parents) {
            VirtTreeExpandEvent ev{parent, VirtTreeExpansion::Expand, VirtTreeSelectReason::Accessibility};
            auto expand = data->onExpand;
            expand.Call(&ev);
            if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
            data = root->data;
        }
        row = data->state->FindRow(ref.item);
    }
    if (row < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    i64 top = (i64)row * *data->rowDy;
    int start = (int)std::min(top, (i64)INT_MAX);
    int end = VirtTreeRowEnd(row, len(data->state->rows), *data->rowDy, *data->bottomPad, data->scrollY->viewport);
    changed |= data->scrollY->EnsureVisible(start, end);
    if (changed) {
        auto scroll = data->onScroll;
        scroll.Call();
        if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::get_ExpandCollapseState(ExpandCollapseState* out) {
    if (!out) return E_POINTER;
    int node = Node();
    if (node < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    const VirtTreeNode& item = root->data->state->nodes[node];
    *out = !item.childCount ? ExpandCollapseState_LeafNode
           : item.expanded  ? ExpandCollapseState_Expanded
                            : ExpandCollapseState_Collapsed;
    return S_OK;
}

static HRESULT SetTreeExpansion(VirtTreeUiaItem* item, VirtTreeExpansion expansion) {
    int node = item->Node();
    if (node < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    auto* data = item->root->data;
    if (!data->state->nodes[node].childCount) return UIA_E_INVALIDOPERATION;
    VirtTreeExpandEvent ev{item->ref.item, expansion, VirtTreeSelectReason::Accessibility};
    data->onExpand.Call(&ev);
    return S_OK;
}

HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::Expand() {
    return SetTreeExpansion(this, VirtTreeExpansion::Expand);
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::Collapse() {
    return SetTreeExpansion(this, VirtTreeExpansion::Collapse);
}

HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::Select() {
    int node = Node();
    if (node < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    HRESULT hr = ScrollIntoView();
    if (FAILED(hr)) return hr;
    VirtTreeSelectEvent ev{ref.item, false, VirtTreeSelectReason::Accessibility};
    auto select = root->data->onSelect;
    select.Call(&ev);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::AddToSelection() {
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    TreeItem selected = root->data->state->selected;
    if (selected && selected != ref.item) return UIA_E_INVALIDOPERATION;
    return Select();
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::RemoveFromSelection() {
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    if (root->data->state->selected == ref.item) {
        VirtTreeSelectEvent ev{};
        ev.reason = VirtTreeSelectReason::Accessibility;
        root->data->onSelect.Call(&ev);
    }
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::get_IsSelected(BOOL* out) {
    if (!out) return E_POINTER;
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = root->data->state->selected == ref.item;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeUiaItem::get_SelectionContainer(IRawElementProviderSimple** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (Node() < 0) return UIA_E_ELEMENTNOTAVAILABLE;
    *out = root;
    root->AddRef();
    return S_OK;
}

static VirtTreeUiaItem* EventItem(VirtTreeUia* uia, TreeItem item) {
    if (!uia || !uia->data || uia->data->state->FindNode(item) < 0) return nullptr;
    return new VirtTreeUiaItem(uia, uia->data->state->MakeRef(item));
}

static void RaiseItemEvent(VirtTreeUia* uia, TreeItem item, EVENTID event) {
    VirtTreeUiaItem* provider = EventItem(uia, item);
    if (!provider) return;
    UiaRaiseAutomationEvent(provider, event);
    provider->Release();
}

void VirtTreeUiaSelected(VirtTreeUia* uia, TreeItem item) {
    RaiseItemEvent(uia, item, UIA_SelectionItem_ElementSelectedEventId);
}
void VirtTreeUiaRemoved(VirtTreeUia* uia, TreeItem item) {
    RaiseItemEvent(uia, item, UIA_SelectionItem_ElementRemovedFromSelectionEventId);
}
void VirtTreeUiaFocused(VirtTreeUia* uia, TreeItem item) {
    RaiseItemEvent(uia, item, UIA_AutomationFocusChangedEventId);
}
void VirtTreeUiaFocusRoot(VirtTreeUia* uia) {
    if (uia && uia->data) UiaRaiseAutomationEvent(uia, UIA_AutomationFocusChangedEventId);
}
void VirtTreeUiaReset(VirtTreeUia* uia) {
    if (uia && uia->data) UiaRaiseStructureChangedEvent(uia, StructureChangeType_ChildrenInvalidated, nullptr, 0);
}
void VirtTreeUiaNameChanged(VirtTreeUia* uia, BSTR before, BSTR after) {
    if (!uia || !uia->data || !before || !after || !UiaClientsAreListening()) return;
    VARIANT oldValue{}, newValue{};
    oldValue.vt = newValue.vt = VT_BSTR;
    oldValue.bstrVal = before;
    newValue.bstrVal = after;
    uia->AddRef();
    UiaRaiseAutomationPropertyChangedEvent(uia, UIA_NamePropertyId, oldValue, newValue);
    uia->Release();
}
void VirtTreeUiaExpanded(VirtTreeUia* uia, TreeItem item, VirtTreeExpansion expansion) {
    VirtTreeUiaItem* provider = EventItem(uia, item);
    if (!provider) return;
    VARIANT oldValue{}, newValue{};
    oldValue.vt = newValue.vt = VT_I4;
    oldValue.lVal =
        expansion == VirtTreeExpansion::Expand ? ExpandCollapseState_Collapsed : ExpandCollapseState_Expanded;
    newValue.lVal =
        expansion == VirtTreeExpansion::Expand ? ExpandCollapseState_Expanded : ExpandCollapseState_Collapsed;
    UiaRaiseAutomationPropertyChangedEvent(provider, UIA_ExpandCollapseExpandCollapseStatePropertyId, oldValue,
                                           newValue);
    UiaRaiseStructureChangedEvent(provider, StructureChangeType_ChildrenInvalidated, nullptr, 0);
    provider->Release();
}

static void RaiseScrollDouble(VirtTreeUia* uia, PROPERTYID id, double before, double after) {
    if (before == after) return;
    VARIANT oldValue{}, newValue{};
    oldValue.vt = newValue.vt = VT_R8;
    oldValue.dblVal = before;
    newValue.dblVal = after;
    UiaRaiseAutomationPropertyChangedEvent(uia, id, oldValue, newValue);
}

static void RaiseScrollable(VirtTreeUia* uia, PROPERTYID id, bool before, bool after) {
    if (before == after) return;
    VARIANT oldValue{}, newValue{};
    oldValue.vt = newValue.vt = VT_BOOL;
    oldValue.boolVal = before ? VARIANT_TRUE : VARIANT_FALSE;
    newValue.boolVal = after ? VARIANT_TRUE : VARIANT_FALSE;
    UiaRaiseAutomationPropertyChangedEvent(uia, id, oldValue, newValue);
}

void VirtTreeUiaScrolled(VirtTreeUia* uia, VirtTreeScroll oldX, VirtTreeScroll oldY, VirtTreeScroll newX,
                         VirtTreeScroll newY) {
    if (!uia || !uia->data || !UiaClientsAreListening()) return;
    uia->AddRef();
    RaiseScrollDouble(uia, UIA_ScrollHorizontalScrollPercentPropertyId, ScrollPercent(oldX), ScrollPercent(newX));
#if IS_DEBUG
    if (uia->data && uia->data->onTestScrollEvent.IsValid()) {
        auto notify = uia->data->onTestScrollEvent;
        uia->data->onTestScrollEvent = {};
        notify.Call();
    }
#endif
    if (uia->data)
        RaiseScrollDouble(uia, UIA_ScrollVerticalScrollPercentPropertyId, ScrollPercent(oldY), ScrollPercent(newY));
    if (uia->data) RaiseScrollDouble(uia, UIA_ScrollHorizontalViewSizePropertyId, ViewPercent(oldX), ViewPercent(newX));
    if (uia->data) RaiseScrollDouble(uia, UIA_ScrollVerticalViewSizePropertyId, ViewPercent(oldY), ViewPercent(newY));
    if (uia->data)
        RaiseScrollable(uia, UIA_ScrollHorizontallyScrollablePropertyId, oldX.MaxPos() > 0, newX.MaxPos() > 0);
    if (uia->data) RaiseScrollable(uia, UIA_ScrollVerticallyScrollablePropertyId, oldY.MaxPos() > 0, newY.MaxPos() > 0);
    uia->Release();
}

VirtTreeUia* CreateVirtTreeUia(VirtTreeUiaData* data) {
    return new VirtTreeUia(data);
}
void FreeVirtTreeUia(VirtTreeUia* uia) {
    if (uia) {
        uia->data = nullptr;
        uia->Release();
    }
}
LRESULT VirtTreeUiaObject(VirtTreeUia* uia, WPARAM wp, LPARAM lp) {
    return UiaReturnRawElementProvider(uia->data->hwnd, wp, lp, uia);
}
