#include <windows.h>
#include <oleacc.h>
#include <uiautomation.h>
#include <stdio.h>
#include <stdlib.h>

static LONG stateChanges = 0;

static void CALLBACK OnStateChange(HWINEVENTHOOK, DWORD, HWND, LONG object, LONG child, DWORD, DWORD) {
    if (object == OBJID_CLIENT && child > 0) stateChanges++;
}

struct EventCounter : IUIAutomationEventHandler, IUIAutomationPropertyChangedEventHandler {
    volatile LONG refs = 1;
    volatile LONG selection = 0;
    volatile LONG expansion = 0;
    volatile LONG scroll = 0;
    volatile LONG horizontal = 0;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (id == __uuidof(IUnknown) || id == __uuidof(IUIAutomationEventHandler)) {
            *out = static_cast<IUIAutomationEventHandler*>(this);
        } else if (id == __uuidof(IUIAutomationPropertyChangedEventHandler)) {
            *out = static_cast<IUIAutomationPropertyChangedEventHandler*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs); }
    ULONG STDMETHODCALLTYPE Release() override { return InterlockedDecrement(&refs); }
    HRESULT STDMETHODCALLTYPE HandleAutomationEvent(IUIAutomationElement*, EVENTID) override {
        InterlockedIncrement(&selection);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE HandlePropertyChangedEvent(IUIAutomationElement*, PROPERTYID id, VARIANT) override {
        if (id == UIA_ExpandCollapseExpandCollapseStatePropertyId) InterlockedIncrement(&expansion);
        if (id == UIA_ScrollVerticalScrollPercentPropertyId) InterlockedIncrement(&scroll);
        if (id == UIA_ScrollHorizontalScrollPercentPropertyId) InterlockedIncrement(&horizontal);
        return S_OK;
    }
};

int main(int argc, char** argv) {
    if (argc != 3) return 2;
    HWND hwnd = (HWND)(intptr_t)_atoi64(argv[1]);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IUIAutomation* uia = nullptr;
    HRESULT hr =
        CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation), (void**)&uia);
    if (FAILED(hr) || !uia) return 1;
    IUIAutomationElement* tree = nullptr;
    hr = uia->ElementFromHandle(hwnd, &tree);
    if (FAILED(hr) || !tree) {
        fprintf(stderr, "tree unavailable: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    CONTROLTYPEID type = 0;
    tree->get_CurrentControlType(&type);
    if (type != UIA_TreeControlTypeId) {
        fprintf(stderr, "tree type: %ld\n", type);
        return 1;
    }
    EventCounter events;
    hr = uia->AddAutomationEventHandler(UIA_SelectionItem_ElementSelectedEventId, tree, TreeScope_Subtree, nullptr,
                                        static_cast<IUIAutomationEventHandler*>(&events));
    PROPERTYID properties[] = {UIA_ExpandCollapseExpandCollapseStatePropertyId,
                               UIA_ScrollVerticalScrollPercentPropertyId, UIA_ScrollHorizontalScrollPercentPropertyId};
    HRESULT eventHr = uia->AddPropertyChangedEventHandlerNativeArray(
        tree, TreeScope_Subtree, nullptr, static_cast<IUIAutomationPropertyChangedEventHandler*>(&events), properties,
        3);
    if (FAILED(hr) || FAILED(eventHr)) {
        fprintf(stderr, "event subscription failed: 0x%08x 0x%08x\n", (unsigned)hr, (unsigned)eventHr);
        return 1;
    }
    if (atoi(argv[2]) == 4) {
        SendMessageW(hwnd, WM_APP + 101, 34, 0);
        if (IsWindow(hwnd)) {
            fprintf(stderr, "tree survived the UIA scroll notification\n");
            return 1;
        }
        for (int i = 0; i < 30 && !events.horizontal; i++) Sleep(100);
        if (!events.horizontal) {
            fprintf(stderr, "horizontal UIA scroll event was not delivered\n");
            return 1;
        }
        uia->RemoveAutomationEventHandler(UIA_SelectionItem_ElementSelectedEventId, tree,
                                          static_cast<IUIAutomationEventHandler*>(&events));
        uia->RemovePropertyChangedEventHandler(tree, static_cast<IUIAutomationPropertyChangedEventHandler*>(&events));
        tree->Release();
        uia->Release();
        CoUninitialize();
        return 0;
    }
    HWINEVENTHOOK hook = SetWinEventHook(EVENT_OBJECT_STATECHANGE, EVENT_OBJECT_STATECHANGE, nullptr, OnStateChange, 0,
                                         0, WINEVENT_OUTOFCONTEXT);
    if (!hook) return 1;
    SendMessageW(hwnd, WM_KEYDOWN, VK_HOME, 0);
    SendMessageW(hwnd, WM_KEYDOWN, VK_MULTIPLY, 0);
    for (int i = 0; i < 100 && !stateChanges; i++) {
        MSG msg;
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&msg);
        Sleep(10);
    }
    UnhookWinEvent(hook);
    if (!stateChanges) {
        fprintf(stderr, "MSAA subtree expansion state event missing\n");
        return 1;
    }
    SendMessageW(hwnd, WM_KEYDOWN, VK_DIVIDE, 0);
    IUIAutomationScrollPattern* treeScroll = nullptr;
    hr = tree->GetCurrentPatternAs(UIA_ScrollPatternId, __uuidof(IUIAutomationScrollPattern), (void**)&treeScroll);
    if (FAILED(hr) || !treeScroll || FAILED(treeScroll->SetScrollPercent(UIA_ScrollPatternNoScroll, 50))) {
        fprintf(stderr, "tree scroll pattern failed: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    double vertical = 0;
    hr = treeScroll->get_CurrentVerticalScrollPercent(&vertical);
    if (FAILED(hr) || vertical < 49 || vertical > 51) {
        fprintf(stderr, "tree scroll percent differs: %f\n", vertical);
        return 1;
    }
    if (SUCCEEDED(treeScroll->SetScrollPercent(UIA_ScrollPatternNoScroll, 101))) {
        fprintf(stderr, "invalid scroll percent accepted\n");
        return 1;
    }
    treeScroll->Release();
    IUIAutomationSelectionPattern* selection = nullptr;
    hr = tree->GetCurrentPatternAs(UIA_SelectionPatternId, __uuidof(IUIAutomationSelectionPattern), (void**)&selection);
    if (FAILED(hr) || !selection) {
        fprintf(stderr, "tree selection pattern unavailable: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    IUIAutomationTreeWalker* walker = nullptr;
    hr = uia->get_ControlViewWalker(&walker);
    if (FAILED(hr) || !walker) return 1;
    IUIAutomationElement* item = nullptr;
    hr = walker->GetFirstChildElement(tree, &item);
    if (FAILED(hr) || !item) {
        fprintf(stderr, "first item unavailable: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    BSTR name = nullptr;
    item->get_CurrentName(&name);
    if (!name || wcsncmp(name, L"Item 10:", 8) != 0) {
        fprintf(stderr, "first item name differs\n");
        return 1;
    }
    SysFreeString(name);
    IUIAutomationExpandCollapsePattern* expand = nullptr;
    hr = item->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, __uuidof(IUIAutomationExpandCollapsePattern),
                                   (void**)&expand);
    if (FAILED(hr) || !expand || FAILED(expand->Expand()) || FAILED(expand->Collapse())) {
        fprintf(stderr, "expand/collapse pattern failed: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    expand->Release();
    hr = tree->GetCurrentPatternAs(UIA_ScrollPatternId, __uuidof(IUIAutomationScrollPattern), (void**)&treeScroll);
    if (FAILED(hr) || !treeScroll || FAILED(treeScroll->SetScrollPercent(UIA_ScrollPatternNoScroll, 50))) return 1;
    treeScroll->Release();
    BOOL offscreen = FALSE;
    hr = item->get_CurrentIsOffscreen(&offscreen);
    if (FAILED(hr) || !offscreen) {
        fprintf(stderr, "first item should be offscreen: hr=0x%08x state=%d pos=%lld\n", (unsigned)hr, offscreen,
                (long long)SendMessageW(hwnd, WM_APP + 101, 2, 0));
        return 1;
    }
    IAccessible* accessible = nullptr;
    hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, (void**)&accessible);
    if (FAILED(hr) || !accessible) {
        fprintf(stderr, "MSAA tree unavailable: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    long count = 0;
    hr = accessible->get_accChildCount(&count);
    if (FAILED(hr) || count == 0) {
        fprintf(stderr, "MSAA tree has no children: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    VARIANT children[2];
    VariantInit(&children[0]);
    VariantInit(&children[1]);
    long fetched = 0;
    hr = AccessibleChildren(accessible, 0, 2, children, &fetched);
    if (FAILED(hr) || fetched != 2 || children[0].vt != VT_I4 || children[0].lVal != 1 || children[1].vt != VT_I4 ||
        children[1].lVal != 2) {
        fprintf(stderr, "MSAA child enumeration failed: 0x%08x count=%ld\n", (unsigned)hr, fetched);
        return 1;
    }
    VariantClear(&children[0]);
    VariantClear(&children[1]);
    VARIANT child;
    VariantInit(&child);
    child.vt = VT_I4;
    child.lVal = 1;
    VARIANT role;
    VariantInit(&role);
    hr = accessible->get_accRole(child, &role);
    if (FAILED(hr) || role.vt != VT_I4 || role.lVal != ROLE_SYSTEM_OUTLINEITEM) {
        fprintf(stderr, "MSAA first item role differs\n");
        return 1;
    }
    BSTR msaaName = nullptr;
    hr = accessible->get_accName(child, &msaaName);
    if (FAILED(hr) || !msaaName || wcsncmp(msaaName, L"Item 10:", 8) != 0) {
        fprintf(stderr, "MSAA first item name differs\n");
        return 1;
    }
    SysFreeString(msaaName);
    VARIANT nestedChild = child;
    nestedChild.lVal = 2;
    BSTR level = nullptr;
    hr = accessible->get_accValue(nestedChild, &level);
    if (FAILED(hr) || !level || wcscmp(level, L"1") != 0) {
        fprintf(stderr, "MSAA nested item level differs\n");
        return 1;
    }
    SysFreeString(level);
    VARIANT nestedState;
    VariantInit(&nestedState);
    hr = accessible->get_accState(nestedChild, &nestedState);
    if (FAILED(hr) || nestedState.vt != VT_I4 || !(nestedState.lVal & STATE_SYSTEM_INVISIBLE)) {
        fprintf(stderr, "MSAA collapsed child is not invisible\n");
        return 1;
    }
    VARIANT secondRoot = child;
    secondRoot.lVal = 4;
    BSTR before = nullptr;
    hr = accessible->get_accName(secondRoot, &before);
    if (FAILED(hr) || !before || wcsncmp(before, L"Item 13:", 8) != 0) {
        fprintf(stderr, "MSAA second root name differs\n");
        return 1;
    }
    hr = accessible->accDoDefaultAction(child);
    BSTR after = nullptr;
    HRESULT nameHr = accessible->get_accName(secondRoot, &after);
    if (FAILED(hr) || FAILED(nameHr) || !after || wcscmp(before, after) != 0) {
        fprintf(stderr, "MSAA child ID changed after expansion\n");
        return 1;
    }
    SysFreeString(before);
    SysFreeString(after);
    if (FAILED(accessible->accDoDefaultAction(child))) {
        fprintf(stderr, "MSAA collapse failed\n");
        return 1;
    }
    IUIAutomationScrollItemPattern* scroll = nullptr;
    hr = item->GetCurrentPatternAs(UIA_ScrollItemPatternId, __uuidof(IUIAutomationScrollItemPattern), (void**)&scroll);
    if (FAILED(hr) || !scroll) {
        fprintf(stderr, "scroll pattern unavailable: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    hr = scroll->ScrollIntoView();
    if (FAILED(hr)) {
        fprintf(stderr, "scroll into view failed: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    hr = item->get_CurrentIsOffscreen(&offscreen);
    if (FAILED(hr) || offscreen) {
        fprintf(stderr, "first item remains offscreen\n");
        return 1;
    }
    IUIAutomationElement* nested = nullptr;
    hr = walker->GetFirstChildElement(item, &nested);
    if (FAILED(hr) || !nested) {
        fprintf(stderr, "nested item unavailable: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    IUIAutomationSelectionItemPattern* selectItem = nullptr;
    hr = nested->GetCurrentPatternAs(UIA_SelectionItemPatternId, __uuidof(IUIAutomationSelectionItemPattern),
                                     (void**)&selectItem);
    if (FAILED(hr) || !selectItem || FAILED(selectItem->Select())) {
        fprintf(stderr, "selection item failed: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    if (SendMessageW(hwnd, WM_APP + 101, 16, 0) != 3) {
        fprintf(stderr, "accessibility selection reason differs\n");
        return 1;
    }
    BOOL selected = FALSE;
    hr = selectItem->get_CurrentIsSelected(&selected);
    IUIAutomationElementArray* selectedItems = nullptr;
    HRESULT selectionHr = selection->GetCurrentSelection(&selectedItems);
    int selectionCount = 0;
    if (selectedItems) selectedItems->get_Length(&selectionCount);
    if (FAILED(hr) || !selected || FAILED(selectionHr) || selectionCount != 1) {
        fprintf(stderr, "selection state differs\n");
        return 1;
    }
    selectedItems->Release();
    selectItem->Release();
    for (int i = 0; i < 30 && (events.selection < 1 || events.expansion < 4 || events.scroll < 1); i++) Sleep(100);
    if (events.selection < 1 || events.expansion < 4 || events.scroll < 1) {
        fprintf(stderr, "missing UIA events: selection=%ld expansion=%ld scroll=%ld\n", events.selection,
                events.expansion, events.scroll);
        return 1;
    }
    hr = nested->SetFocus();
    BOOL focused = FALSE;
    HRESULT focusHr = nested->get_CurrentHasKeyboardFocus(&focused);
    if (FAILED(hr) || FAILED(focusHr) || !focused) {
        fprintf(stderr, "nested item focus failed: 0x%08x\n", (unsigned)hr);
        return 1;
    }
    nested->Release();
    SendMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(80, 5));
    SendMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(5, 5));
    for (int i = 0; i < 30 && (events.selection < 2 || events.expansion < 6); i++) Sleep(100);
    if (events.selection < 2 || events.expansion < 6) {
        fprintf(stderr, "missing mouse UIA events: selection=%ld expansion=%ld\n", events.selection, events.expansion);
        return 1;
    }
    SendMessageW(hwnd, WM_APP + 101, 7, 0);
    BSTR stale = nullptr;
    hr = item->get_CurrentName(&stale);
    SysFreeString(stale);
    if (SUCCEEDED(hr)) {
        fprintf(stderr, "stale UIA item remains available after model reset\n");
        return 1;
    }
    count = 0;
    hr = accessible->get_accChildCount(&count);
    if (SUCCEEDED(hr)) {
        fprintf(stderr, "stale MSAA provider remains available after model reset\n");
        return 1;
    }
    accessible->Release();
    uia->RemoveAutomationEventHandler(UIA_SelectionItem_ElementSelectedEventId, tree,
                                      static_cast<IUIAutomationEventHandler*>(&events));
    uia->RemovePropertyChangedEventHandler(tree, static_cast<IUIAutomationPropertyChangedEventHandler*>(&events));
    accessible = nullptr;
    hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, (void**)&accessible);
    if (FAILED(hr) || !accessible || FAILED(accessible->get_accChildCount(&count)) || count == 0) {
        fprintf(stderr, "fresh MSAA provider unavailable after model reset\n");
        return 1;
    }
    IUIAutomationElement* fresh = nullptr;
    hr = walker->GetFirstChildElement(tree, &fresh);
    if (FAILED(hr) || !fresh) {
        fprintf(stderr, "fresh UIA item unavailable after model reset\n");
        return 1;
    }
    if (SendMessageW(hwnd, WM_APP + 101, 2, 0) != 0) {
        fprintf(stderr, "UIA scrolling did not return to the first row\n");
        return 1;
    }
    SendMessageW(hwnd, WM_APP + 101, 20, atoi(argv[2]));
    hr = fresh->SetFocus();
    if (hr != UIA_E_ELEMENTNOTAVAILABLE) {
        fprintf(stderr, "focus returned 0x%08x after selection destroyed the tree\n", (unsigned)hr);
        return 1;
    }
    stale = nullptr;
    hr = fresh->get_CurrentName(&stale);
    SysFreeString(stale);
    if (SUCCEEDED(hr)) {
        fprintf(stderr, "UIA item remains available after window close\n");
        return 1;
    }
    hr = accessible->get_accChildCount(&count);
    if (SUCCEEDED(hr)) {
        fprintf(stderr, "MSAA provider remains available after window close\n");
        return 1;
    }
    fresh->Release();
    accessible->Release();
    scroll->Release();
    item->Release();
    walker->Release();
    selection->Release();
    tree->Release();
    uia->Release();
    CoUninitialize();
    return 0;
}
