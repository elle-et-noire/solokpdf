/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

#include "base/Base.h"
#include "base/UITask.h"
#include "base/Win.h"
#include <uiautomation.h>
#include "HomePage.h"
#include "uia/Common.h"
#include "uia/Provider.h"
#include "uia/StartPageProvider.h"

static HRESULT HomeProviderOptions(ProviderOptions* out) {
    if (!out) {
        return E_POINTER;
    }
    *out = ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading | ProviderOptions_ProviderOwnsSetFocus;
    return S_OK;
}

class HomeUiaChild : public IRawElementProviderSimple,
                     public IRawElementProviderFragment,
                     public IInvokeProvider,
                     public ISelectionItemProvider {
    AtomicInt refs = 1;
    SumatraUIAutomationStartPageProvider* parent;
    int generation;
    int index;
    Str path;

    MainWindow* Resolve(Str* name = nullptr, Rect* bounds = nullptr) const;
    void InvokeNow();

  public:
    HomeUiaChild(SumatraUIAutomationStartPageProvider* parent, int index, Str path)
        : parent(parent), generation(parent->generation), index(index), path(str::Dup(path)) {
        parent->AddRef();
    }
    ~HomeUiaChild() {
        str::Free(path);
        parent->Release();
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID, IUnknown**) override;
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID, VARIANT*) override;
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** out) override {
        return UiaReturnNull(out);
    }
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* out) override { return HomeProviderOptions(out); }
    HRESULT STDMETHODCALLTYPE Navigate(NavigateDirection, IRawElementProviderFragment**) override;
    HRESULT STDMETHODCALLTYPE GetRuntimeId(SAFEARRAY**) override;
    HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY** out) override { return UiaReturnNull(out); }
    HRESULT STDMETHODCALLTYPE SetFocus() override;
    HRESULT STDMETHODCALLTYPE get_BoundingRectangle(UiaRect*) override;
    HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot**) override;
    HRESULT STDMETHODCALLTYPE Invoke() override;
    HRESULT STDMETHODCALLTYPE Select() override;
    HRESULT STDMETHODCALLTYPE AddToSelection() override { return Select(); }
    HRESULT STDMETHODCALLTYPE RemoveFromSelection() override { return UIA_E_INVALIDOPERATION; }
    HRESULT STDMETHODCALLTYPE get_IsSelected(BOOL*) override;
    HRESULT STDMETHODCALLTYPE get_SelectionContainer(IRawElementProviderSimple**) override;
};

MainWindow* HomeUiaChild::Resolve(Str* nameOut, Rect* boundsOut) const {
    if (parent->generation != generation) {
        return nullptr;
    }
    MainWindow* win = parent->Window();
    Str name, currentPath;
    Rect bounds;
    if (!HomeUiaItem(win, index, name, currentPath, bounds) || !str::Eq(path, currentPath)) {
        return nullptr;
    }
    if (nameOut) {
        *nameOut = name;
    }
    if (boundsOut) {
        *boundsOut = bounds;
    }
    return win;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::QueryInterface(REFIID id, void** out) {
    static const QITAB qit[] = {QITABENT(HomeUiaChild, IRawElementProviderSimple),
                                QITABENT(HomeUiaChild, IRawElementProviderFragment),
                                QITABENT(HomeUiaChild, IInvokeProvider),
                                QITABENT(HomeUiaChild, ISelectionItemProvider),
                                {nullptr}};
    return QISearch(this, qit, id, out);
}

ULONG STDMETHODCALLTYPE HomeUiaChild::AddRef() {
    return AtomicIntInc(&refs);
}

ULONG STDMETHODCALLTYPE HomeUiaChild::Release() {
    return ComRelease(&refs, [this] { delete this; });
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::GetPatternProvider(PATTERNID id, IUnknown** out) {
    if (!out) {
        return E_POINTER;
    }
    *out = nullptr;
    if (!Resolve()) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    if (id == UIA_InvokePatternId) {
        *out = static_cast<IInvokeProvider*>(this);
    } else if (id == UIA_SelectionItemPatternId && index != kHomeUiaOpen) {
        *out = static_cast<ISelectionItemProvider*>(this);
    }
    if (*out) {
        AddRef();
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::GetPropertyValue(PROPERTYID id, VARIANT* out) {
    if (!out) {
        return E_POINTER;
    }
    VariantInit(out);
    Str name;
    Rect bounds;
    MainWindow* win = Resolve(&name, &bounds);
    if (!win) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    bool isLink = index == kHomeUiaOpen;
    switch (id) {
        case UIA_NamePropertyId: {
            WStr wide = ToWStrTemp(name);
            out->vt = VT_BSTR;
            out->bstrVal = SysAllocStringLen(wide.s, len(wide));
            return out->bstrVal ? S_OK : E_OUTOFMEMORY;
        }
        case UIA_ControlTypePropertyId:
            out->vt = VT_I4;
            out->lVal = isLink ? UIA_HyperlinkControlTypeId : UIA_ListItemControlTypeId;
            break;
        case UIA_IsEnabledPropertyId:
        case UIA_IsControlElementPropertyId:
        case UIA_IsContentElementPropertyId:
            out->vt = VT_BOOL;
            out->boolVal = VARIANT_TRUE;
            break;
        case UIA_IsKeyboardFocusablePropertyId:
        case UIA_HasKeyboardFocusPropertyId:
        case UIA_IsOffscreenPropertyId: {
            bool focused = !isLink && HomeUiaSelected(win) == index && HomeUiaHasFocus(win);
            bool value = id == UIA_IsOffscreenPropertyId           ? bounds.IsEmpty()
                         : id == UIA_IsKeyboardFocusablePropertyId ? !isLink
                                                                   : focused;
            out->vt = VT_BOOL;
            out->boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
            break;
        }
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::Navigate(NavigateDirection dir, IRawElementProviderFragment** out) {
    if (!out) {
        return E_POINTER;
    }
    *out = nullptr;
    if (!Resolve()) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    if (dir == NavigateDirection_Parent) {
        *out = parent;
        parent->AddRef();
    } else if (dir == NavigateDirection_NextSibling) {
        parent->Child(index + 1, out);
    } else if (dir == NavigateDirection_PreviousSibling) {
        parent->Child(index - 1, out);
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::GetRuntimeId(SAFEARRAY** out) {
    if (!out) {
        return E_POINTER;
    }
    int id[] = {HandleToLong(parent->canvasHwnd), kSumatraUiaStartPageRuntimeId, generation, index};
    *out = SafeArrayCreateVector(VT_I4, 0, dimof(id));
    if (!*out) {
        return E_OUTOFMEMORY;
    }
    for (LONG i = 0; i < dimofi(id); i++) {
        SafeArrayPutElement(*out, &i, &id[i]);
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::SetFocus() {
    MainWindow* win = Resolve();
    if (!win) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    if (index == kHomeUiaOpen) {
        return UIA_E_INVALIDOPERATION;
    }
    // UIA requests focus before Select. Keep the native filter edit active.
    if (HomeUiaSearchFocus(win)) {
        return S_OK;
    }
    HomeUiaFocus(win);
    return Select();
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::get_BoundingRectangle(UiaRect* out) {
    if (!out) {
        return E_POINTER;
    }
    Rect bounds;
    if (!Resolve(nullptr, &bounds)) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    *out = {};
    if (!bounds.IsEmpty()) {
        Point p = HwndClientToScreen(parent->canvasHwnd, {bounds.x, bounds.y});
        *out = {(double)p.x, (double)p.y, (double)bounds.dx, (double)bounds.dy};
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::get_FragmentRoot(IRawElementProviderFragmentRoot** out) {
    return UiaRootFragmentRoot(Resolve() ? parent->root : nullptr, out);
}

// Recheck the row after returning to the message loop to open the file.
void HomeUiaChild::InvokeNow() {
    if (auto* win = Resolve()) {
        HomeUiaInvoke(win, index);
    }
    Release();
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::Invoke() {
    if (!Resolve()) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    AddRef();
    uitask::Post(MkMethod0<HomeUiaChild, &HomeUiaChild::InvokeNow>(this), "HomeUiaInvoke");
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::Select() {
    MainWindow* win = Resolve();
    if (!win) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    if (index == kHomeUiaOpen) {
        return UIA_E_INVALIDOPERATION;
    }
    HomeUiaSelect(win, index);
    if (UiaClientsAreListening()) {
        UiaRaiseAutomationEvent(this, UIA_SelectionItem_ElementSelectedEventId);
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::get_IsSelected(BOOL* out) {
    if (!out) {
        return E_POINTER;
    }
    MainWindow* win = Resolve();
    if (!win) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    *out = index != kHomeUiaOpen && HomeUiaSelected(win) == index;
    return S_OK;
}

HRESULT STDMETHODCALLTYPE HomeUiaChild::get_SelectionContainer(IRawElementProviderSimple** out) {
    if (!out) {
        return E_POINTER;
    }
    *out = nullptr;
    if (!Resolve()) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    *out = parent;
    parent->AddRef();
    return S_OK;
}

SumatraUIAutomationStartPageProvider::SumatraUIAutomationStartPageProvider(HWND canvasHwnd,
                                                                           SumatraUIAutomationProvider* root)
    : refCount(1), canvasHwnd(canvasHwnd), root(root) {
    // root->AddRef(); Don't add refs to our parent & owner.
}

SumatraUIAutomationStartPageProvider::~SumatraUIAutomationStartPageProvider() = default;

// IUnknown
HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::QueryInterface(REFIID riid, void** ppv) {
    static const QITAB qit[] = {QITABENT(SumatraUIAutomationStartPageProvider, IRawElementProviderSimple),
                                QITABENT(SumatraUIAutomationStartPageProvider, IRawElementProviderFragment),
                                QITABENT(SumatraUIAutomationStartPageProvider, ISelectionProvider),
                                {nullptr}};
    return QISearch(this, qit, riid, ppv);
}

// clients may keep this provider after the root that owns it is gone
void SumatraUIAutomationStartPageProvider::DetachRoot() {
    root = nullptr;
}

void SumatraUIAutomationStartPageProvider::InvalidateItems() {
    generation++;
}

MainWindow* SumatraUIAutomationStartPageProvider::Window() const {
    return root ? FindHomeUiaWindow(canvasHwnd, root) : nullptr;
}

void SumatraUIAutomationStartPageProvider::Child(int index, IRawElementProviderFragment** out) {
    Str name, path;
    Rect bounds;
    *out = HomeUiaItem(Window(), index, name, path, bounds) ? new HomeUiaChild(this, index, path) : nullptr;
}

HRESULT SumatraUIAutomationStartPageProvider::GetFocus(IRawElementProviderFragment** out) {
    MainWindow* win = Window();
    *out = nullptr;
    if (HomeUiaSearchFocus(win)) {
        return S_OK;
    }
    int selected = HomeUiaSelected(win);
    if (selected >= 0 && HomeUiaHasFocus(win)) {
        Child(selected, out);
    }
    if (!*out && root) {
        *out = this;
        AddRef();
    }
    return S_OK;
}

ULONG STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::AddRef() {
    return AtomicIntInc(&refCount);
}

ULONG STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::Release() {
    return ComRelease(&refCount, [this] { delete this; });
}

// IRawElementProviderFragment
HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::Navigate(enum NavigateDirection direction,
                                                                         IRawElementProviderFragment** pRetVal) {
    if (pRetVal == nullptr) {
        return E_POINTER;
    }

    *pRetVal = nullptr;
    if (!root) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    if (direction == NavigateDirection_Parent) {
        *pRetVal = root;
        (*pRetVal)->AddRef();
    } else if (direction == NavigateDirection_FirstChild) {
        Child(kHomeUiaOpen, pRetVal);
    } else if (direction == NavigateDirection_LastChild) {
        Child(HomeUiaCount(Window()) - 1, pRetVal);
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::GetRuntimeId(SAFEARRAY** pRetVal) {
    if (pRetVal == nullptr) {
        return E_POINTER;
    }

    SAFEARRAY* psa = SafeArrayCreateVector(VT_I4, 0, 2);
    if (!psa) {
        return E_OUTOFMEMORY;
    }

    // RuntimeID magic, use hwnd to differentiate providers of different windows
    int rId[] = {HandleToLong(canvasHwnd), kSumatraUiaStartPageRuntimeId};
    for (LONG i = 0; i < 2; i++) {
        HRESULT hr = SafeArrayPutElement(psa, &i, (void*)&(rId[i]));
        ReportIf(FAILED(hr));
    }

    *pRetVal = psa;
    return S_OK;
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::GetEmbeddedFragmentRoots(SAFEARRAY** pRetVal) {
    return UiaReturnNull(pRetVal);
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::SetFocus() {
    return S_OK;
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::get_BoundingRectangle(struct UiaRect* pRetVal) {
    return UiaRootRect(root, pRetVal);
}

HRESULT STDMETHODCALLTYPE
SumatraUIAutomationStartPageProvider::get_FragmentRoot(IRawElementProviderFragmentRoot** pRetVal) {
    return UiaRootFragmentRoot(root, pRetVal);
}

// IRawElementProviderSimple
HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::GetPatternProvider(PATTERNID patternId,
                                                                                   IUnknown** pRetVal) {
    *pRetVal = nullptr;
    if (patternId == UIA_SelectionPatternId && HomeUiaCount(Window()) >= 0) {
        *pRetVal = static_cast<ISelectionProvider*>(this);
        AddRef();
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::GetPropertyValue(PROPERTYID propertyId,
                                                                                 VARIANT* pRetVal) {
    if (propertyId == UIA_NamePropertyId) {
        pRetVal->vt = VT_BSTR;
        pRetVal->bstrVal = SysAllocString(L"Start Page");
        return S_OK;
    }
    if (propertyId == UIA_ControlTypePropertyId && HomeUiaCount(Window()) >= 0) {
        pRetVal->vt = VT_I4;
        pRetVal->lVal = UIA_ListControlTypeId;
        return S_OK;
    }

    pRetVal->vt = VT_EMPTY;
    return S_OK;
}

HRESULT STDMETHODCALLTYPE
SumatraUIAutomationStartPageProvider::get_HostRawElementProvider(IRawElementProviderSimple** pRetVal) {
    return UiaReturnNull(pRetVal);
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::get_ProviderOptions(ProviderOptions* pRetVal) {
    return HomeProviderOptions(pRetVal);
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::GetSelection(SAFEARRAY** out) {
    if (!out) {
        return E_POINTER;
    }
    *out = nullptr;
    MainWindow* win = Window();
    if (HomeUiaCount(win) < 0) {
        return UIA_E_ELEMENTNOTAVAILABLE;
    }
    int selected = HomeUiaSelected(win);
    *out = SafeArrayCreateVector(VT_UNKNOWN, 0, selected < 0 ? 0 : 1);
    if (!*out) {
        return E_OUTOFMEMORY;
    }
    if (selected >= 0) {
        IRawElementProviderFragment* item = nullptr;
        Child(selected, &item);
        LONG pos = 0;
        SafeArrayPutElement(*out, &pos, item);
        item->Release();
    }
    return S_OK;
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::get_CanSelectMultiple(BOOL* out) {
    if (!out) {
        return E_POINTER;
    }
    *out = FALSE;
    return S_OK;
}

HRESULT STDMETHODCALLTYPE SumatraUIAutomationStartPageProvider::get_IsSelectionRequired(BOOL* out) {
    return get_CanSelectMultiple(out);
}
