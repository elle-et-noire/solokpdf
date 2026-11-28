/* Copyright 2022 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

class SumatraUIAutomationProvider;
class HomeUiaChild;
struct MainWindow;
class SumatraUIAutomationStartPageProvider : public IRawElementProviderFragment,
                                             public IRawElementProviderSimple,
                                             public ISelectionProvider {
    friend class HomeUiaChild;
    AtomicInt refCount;
    HWND canvasHwnd;
    SumatraUIAutomationProvider* root; // not ref-counted; nulled by DetachRoot()
    int generation = 0;

    MainWindow* Window() const;
    void Child(int, IRawElementProviderFragment**);

  public:
    SumatraUIAutomationStartPageProvider(HWND canvasHwnd, SumatraUIAutomationProvider* root);
    void DetachRoot();
    void InvalidateItems();
    HRESULT GetFocus(IRawElementProviderFragment**);
    ~SumatraUIAutomationStartPageProvider();

    HRESULT STDMETHODCALLTYPE QueryInterface(const IID&, void**);
    ULONG STDMETHODCALLTYPE AddRef();
    ULONG STDMETHODCALLTYPE Release();

    HRESULT STDMETHODCALLTYPE Navigate(enum NavigateDirection direction, IRawElementProviderFragment** pRetVal);
    HRESULT STDMETHODCALLTYPE GetRuntimeId(SAFEARRAY** pRetVal);
    HRESULT STDMETHODCALLTYPE GetEmbeddedFragmentRoots(SAFEARRAY** pRetVal);
    HRESULT STDMETHODCALLTYPE SetFocus();
    HRESULT STDMETHODCALLTYPE get_BoundingRectangle(struct UiaRect* pRetVal);
    HRESULT STDMETHODCALLTYPE get_FragmentRoot(IRawElementProviderFragmentRoot** pRetVal);

    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID patternId, IUnknown** pRetVal);
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID propertyId, VARIANT* pRetVal);
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** pRetVal);
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* pRetVal);
    HRESULT STDMETHODCALLTYPE GetSelection(SAFEARRAY**) override;
    HRESULT STDMETHODCALLTYPE get_CanSelectMultiple(BOOL*) override;
    HRESULT STDMETHODCALLTYPE get_IsSelectionRequired(BOOL*) override;
};
