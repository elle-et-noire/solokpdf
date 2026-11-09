/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD (see COPYING.BSD) */

#include "base/Base.h"
#include <oleacc.h>
#include "base/Win.h"
#include "gui/UIModels.h"
#include "gui/win/VirtTreeState.h"
#include "TreeUia.h"

#pragma comment(lib, "oleacc.lib")

struct VirtTreeMsaa : IAccessible {
    AtomicInt refs;
    VirtTreeUiaData* data;
    u64 generation;

    explicit VirtTreeMsaa(VirtTreeUiaData* data) : refs(1), data(data), generation(data->state->generation) {}
    bool Live() const { return data && generation == data->state->generation; }
    int Node(VARIANT child);
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT*) override;
    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT, LCID, ITypeInfo**) override;
    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID, LPOLESTR*, UINT, LCID, DISPID*) override;
    HRESULT STDMETHODCALLTYPE Invoke(DISPID, REFIID, LCID, WORD, DISPPARAMS*, VARIANT*, EXCEPINFO*, UINT*) override;
    HRESULT STDMETHODCALLTYPE get_accParent(IDispatch**) override;
    HRESULT STDMETHODCALLTYPE get_accChildCount(long*) override;
    HRESULT STDMETHODCALLTYPE get_accChild(VARIANT, IDispatch**) override;
    HRESULT STDMETHODCALLTYPE get_accName(VARIANT, BSTR*) override;
    HRESULT STDMETHODCALLTYPE get_accValue(VARIANT, BSTR*) override;
    HRESULT STDMETHODCALLTYPE get_accDescription(VARIANT, BSTR*) override;
    HRESULT STDMETHODCALLTYPE get_accRole(VARIANT, VARIANT*) override;
    HRESULT STDMETHODCALLTYPE get_accState(VARIANT, VARIANT*) override;
    HRESULT STDMETHODCALLTYPE get_accHelp(VARIANT, BSTR*) override;
    HRESULT STDMETHODCALLTYPE get_accHelpTopic(BSTR*, VARIANT, long*) override;
    HRESULT STDMETHODCALLTYPE get_accKeyboardShortcut(VARIANT, BSTR*) override;
    HRESULT STDMETHODCALLTYPE get_accFocus(VARIANT*) override;
    HRESULT STDMETHODCALLTYPE get_accSelection(VARIANT*) override;
    HRESULT STDMETHODCALLTYPE get_accDefaultAction(VARIANT, BSTR*) override;
    HRESULT STDMETHODCALLTYPE accSelect(long, VARIANT) override;
    HRESULT STDMETHODCALLTYPE accLocation(long*, long*, long*, long*, VARIANT) override;
    HRESULT STDMETHODCALLTYPE accNavigate(long, VARIANT, VARIANT*) override;
    HRESULT STDMETHODCALLTYPE accHitTest(long, long, VARIANT*) override;
    HRESULT STDMETHODCALLTYPE accDoDefaultAction(VARIANT) override;
    HRESULT STDMETHODCALLTYPE put_accName(VARIANT, BSTR) override;
    HRESULT STDMETHODCALLTYPE put_accValue(VARIANT, BSTR) override;
};

int VirtTreeMsaa::Node(VARIANT child) {
    if (!Live() || child.vt != VT_I4 || child.lVal <= 0 || child.lVal > len(data->state->nodes)) return -1;
    return child.lVal - 1;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::QueryInterface(REFIID id, void** out) {
    static const QITAB qit[] = {QITABENT(VirtTreeMsaa, IAccessible), QITABENT(VirtTreeMsaa, IDispatch), {nullptr}};
    return QISearch(this, qit, id, out);
}
ULONG STDMETHODCALLTYPE VirtTreeMsaa::AddRef() {
    return AtomicIntInc(&refs);
}
ULONG STDMETHODCALLTYPE VirtTreeMsaa::Release() {
    return ComRelease(&refs, [this] { delete this; });
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::GetTypeInfoCount(UINT* count) {
    if (!count) return E_POINTER;
    *count = 0;
    return E_NOTIMPL;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::GetTypeInfo(UINT, LCID, ITypeInfo** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    return E_NOTIMPL;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::GetIDsOfNames(REFIID, LPOLESTR*, UINT, LCID, DISPID*) {
    return E_NOTIMPL;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::Invoke(DISPID, REFIID, LCID, WORD, DISPPARAMS*, VARIANT*, EXCEPINFO*, UINT*) {
    return E_NOTIMPL;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accParent(IDispatch** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    return AccessibleObjectFromWindow(data->hwnd, (DWORD)OBJID_WINDOW, IID_IDispatch, (void**)out);
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accChildCount(long* out) {
    if (!out) return E_POINTER;
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    *out = len(data->state->nodes);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accChild(VARIANT child, IDispatch** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    return Node(child) >= 0 ? S_FALSE : E_INVALIDARG;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accName(VARIANT child, BSTR* out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    if (child.vt == VT_I4 && child.lVal == CHILDID_SELF) {
        *out = VirtTreeName(data->hwnd);
        return *out ? S_OK : E_OUTOFMEMORY;
    }
    int node = Node(child);
    if (node < 0) return E_INVALIDARG;
    TreeItem item = data->state->nodes[node].item;
    WStr name = ToWStrTemp(data->state->model->Text(item));
    *out = SysAllocStringLen(name.s, len(name));
    return *out ? S_OK : E_OUTOFMEMORY;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accValue(VARIANT child, BSTR* out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    if (child.vt == VT_I4 && child.lVal == CHILDID_SELF) return S_FALSE;
    int node = Node(child);
    if (node < 0) return E_INVALIDARG;
    WStr value = ToWStrTemp(fmt("%d", data->state->nodes[node].depth));
    *out = SysAllocStringLen(value.s, len(value));
    return *out ? S_OK : E_OUTOFMEMORY;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accDescription(VARIANT child, BSTR* out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    int node = Node(child);
    if (node < 0) return E_INVALIDARG;
    WStr desc = ToWStrTemp(fmt("Level %d", data->state->nodes[node].depth + 1));
    *out = SysAllocStringLen(desc.s, len(desc));
    return *out ? S_OK : E_OUTOFMEMORY;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accRole(VARIANT child, VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    if (child.vt != VT_I4 || (child.lVal != CHILDID_SELF && Node(child) < 0)) return E_INVALIDARG;
    out->vt = VT_I4;
    out->lVal = child.lVal == CHILDID_SELF ? ROLE_SYSTEM_OUTLINE : ROLE_SYSTEM_OUTLINEITEM;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accState(VARIANT child, VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    if (child.vt != VT_I4) return E_INVALIDARG;
    out->vt = VT_I4;
    if (child.lVal == CHILDID_SELF) {
        out->lVal = STATE_SYSTEM_FOCUSABLE;
        return S_OK;
    }
    int idx = Node(child);
    if (idx < 0) return E_INVALIDARG;
    const VirtTreeNode& node = data->state->nodes[idx];
    out->lVal = STATE_SYSTEM_FOCUSABLE | STATE_SYSTEM_SELECTABLE;
    if (node.childCount) out->lVal |= node.expanded ? STATE_SYSTEM_EXPANDED : STATE_SYSTEM_COLLAPSED;
    if (data->state->selected == node.item) {
        out->lVal |= STATE_SYSTEM_SELECTED;
        if (::GetFocus() == data->hwnd) out->lVal |= STATE_SYSTEM_FOCUSED;
    }
    int row = data->state->FindRow(node.item);
    i64 top = (i64)row * *data->rowDy - data->scrollY->pos;
    if (row < 0) out->lVal |= STATE_SYSTEM_INVISIBLE;
    if (row < 0 || top + *data->rowDy <= 0 || top >= data->scrollY->viewport) out->lVal |= STATE_SYSTEM_OFFSCREEN;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accHelp(VARIANT, BSTR* out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    return S_FALSE;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accHelpTopic(BSTR* out, VARIANT, long* topic) {
    if (!out || !topic) return E_POINTER;
    *out = nullptr;
    *topic = -1;
    return S_FALSE;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accKeyboardShortcut(VARIANT, BSTR* out) {
    return get_accHelp({}, out);
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accFocus(VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    if (::GetFocus() != data->hwnd) return S_FALSE;
    int node = data->state->FindNode(data->state->selected);
    out->vt = VT_I4;
    out->lVal = node < 0 ? CHILDID_SELF : node + 1;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accSelection(VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    int node = data->state->FindNode(data->state->selected);
    if (node < 0) return S_FALSE;
    out->vt = VT_I4;
    out->lVal = node + 1;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::get_accDefaultAction(VARIANT child, BSTR* out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    int idx = Node(child);
    if (idx < 0) return E_INVALIDARG;
    const VirtTreeNode& node = data->state->nodes[idx];
    if (!node.childCount) return S_FALSE;
    *out = SysAllocString(node.expanded ? L"Collapse" : L"Expand");
    return *out ? S_OK : E_OUTOFMEMORY;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::accSelect(long flags, VARIANT child) {
    int node = Node(child);
    if (node < 0 || !(flags & (SELFLAG_TAKESELECTION | SELFLAG_TAKEFOCUS)) ||
        (flags & ~(SELFLAG_TAKESELECTION | SELFLAG_TAKEFOCUS)))
        return E_INVALIDARG;
    TreeItem item = data->state->nodes[node].item;
    int row = data->state->FindRow(item);
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
            if (!Live()) return CO_E_OBJNOTCONNECTED;
        }
        row = data->state->FindRow(item);
    }
    if (row < 0) return CO_E_OBJNOTCONNECTED;
    i64 top = (i64)row * *data->rowDy;
    int start = (int)std::min(top, (i64)INT_MAX);
    int end = VirtTreeRowEnd(row, len(data->state->rows), *data->rowDy, *data->bottomPad, data->scrollY->viewport);
    data->scrollY->EnsureVisible(start, end);
    auto scroll = data->onScroll;
    scroll.Call();
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    VirtTreeSelectEvent ev{item, (flags & SELFLAG_TAKEFOCUS) != 0, VirtTreeSelectReason::Accessibility};
    auto select = data->onSelect;
    select.Call(&ev);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::accLocation(long* x, long* y, long* width, long* height, VARIANT child) {
    if (!x || !y || !width || !height) return E_POINTER;
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    Rect rc = HwndClientRect(data->hwnd);
    Point origin = HwndClientToScreen(data->hwnd, {0, 0});
    *x = origin.x;
    *y = origin.y;
    *width = rc.dx;
    *height = rc.dy;
    if (child.vt == VT_I4 && child.lVal == CHILDID_SELF) return S_OK;
    int node = Node(child);
    if (node < 0) return E_INVALIDARG;
    int row = data->state->FindRow(data->state->nodes[node].item);
    if (row < 0) {
        *width = *height = 0;
        return S_FALSE;
    }
    *y += (int)((i64)row * *data->rowDy - data->scrollY->pos);
    *height = *data->rowDy;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::accNavigate(long direction, VARIANT start, VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    int row = Node(start);
    if (start.vt == VT_I4 && start.lVal == CHILDID_SELF && direction == NAVDIR_FIRSTCHILD)
        row = 0;
    else if (start.vt == VT_I4 && start.lVal == CHILDID_SELF && direction == NAVDIR_LASTCHILD)
        row = len(data->state->nodes) - 1;
    else if (row >= 0 && direction == NAVDIR_NEXT)
        row++;
    else if (row >= 0 && direction == NAVDIR_PREVIOUS)
        row--;
    else
        return S_FALSE;
    if (row < 0 || row >= len(data->state->nodes)) return S_FALSE;
    out->vt = VT_I4;
    out->lVal = row + 1;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::accHitTest(long x, long y, VARIANT* out) {
    if (!out) return E_POINTER;
    VariantInit(out);
    if (!Live()) return CO_E_OBJNOTCONNECTED;
    Point pt = HwndScreenToClient(data->hwnd, {(int)x, (int)y});
    if (!HwndClientRect(data->hwnd).Contains(pt) || *data->rowDy <= 0) return S_FALSE;
    int row = (pt.y + data->scrollY->pos) / *data->rowDy;
    if (row < 0 || row >= len(data->state->rows)) {
        out->vt = VT_I4;
        out->lVal = CHILDID_SELF;
        return S_OK;
    }
    out->vt = VT_I4;
    out->lVal = data->state->rows[row] + 1;
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::accDoDefaultAction(VARIANT child) {
    int idx = Node(child);
    if (idx < 0) return E_INVALIDARG;
    VirtTreeNode node = data->state->nodes[idx];
    if (!node.childCount) return S_FALSE;
    VirtTreeExpandEvent ev{node.item, node.expanded ? VirtTreeExpansion::Collapse : VirtTreeExpansion::Expand,
                           VirtTreeSelectReason::Accessibility};
    data->onExpand.Call(&ev);
    return S_OK;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::put_accName(VARIANT, BSTR) {
    return E_NOTIMPL;
}
HRESULT STDMETHODCALLTYPE VirtTreeMsaa::put_accValue(VARIANT, BSTR) {
    return E_NOTIMPL;
}

VirtTreeMsaa* CreateVirtTreeMsaa(VirtTreeUiaData* data) {
    return new VirtTreeMsaa(data);
}
void FreeVirtTreeMsaa(VirtTreeMsaa* msaa) {
    if (msaa) {
        msaa->data = nullptr;
        msaa->Release();
    }
}
bool IsVirtTreeMsaaLive(VirtTreeMsaa* msaa) {
    return msaa && msaa->Live();
}
LRESULT VirtTreeMsaaObject(VirtTreeMsaa* msaa, WPARAM wp) {
    return LresultFromObject(IID_IAccessible, wp, msaa);
}
