#include <windows.h>
#include <oleacc.h>
#include <uiautomation.h>
#include <stdio.h>

static bool Check(bool condition, const char* message) {
    if (!condition) {
        fprintf(stderr, "%s\n", message);
    }
    return condition;
}

int main(int argc, char** argv) {
    if (argc < 2 || argc > 4) {
        return 2;
    }
    bool scrollItemTest = false;
    bool checkName = false;
    bool favorites = false;
    bool changed = false;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "scroll-item") == 0) scrollItemTest = true;
        if (strcmp(argv[i], "bookmarks") == 0) checkName = true;
        if (strcmp(argv[i], "favorites") == 0) favorites = true;
        if (strcmp(argv[i], "changed") == 0) changed = true;
    }
    HWND hwnd = (HWND)(intptr_t)_atoi64(argv[1]);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IUIAutomation* uia = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation),
                                  (void**)&uia);
    if (!Check(SUCCEEDED(hr) && uia, "UI Automation unavailable")) {
        return 1;
    }
    IUIAutomationElement* tree = nullptr;
    hr = uia->ElementFromHandle(hwnd, &tree);
    if (!Check(SUCCEEDED(hr) && tree, "tree element unavailable")) {
        return 1;
    }
    CONTROLTYPEID type = 0;
    tree->get_CurrentControlType(&type);
    if (!Check(type == UIA_TreeControlTypeId, "control is not a tree")) {
        return 1;
    }
    if (checkName || favorites || changed) {
        BSTR treeName = nullptr;
        hr = tree->get_CurrentName(&treeName);
        const wchar_t* expected = changed ? L"Changed name" : favorites ? L"Favorites" : L"Bookmarks";
        bool named = SUCCEEDED(hr) && treeName && wcscmp(treeName, expected) == 0;
        SysFreeString(treeName);
        if (!Check(named, "UIA tree name differs")) return 1;
    }
    if (favorites || changed) {
        IAccessible* accessible = nullptr;
        hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, (void**)&accessible);
        if (!Check(SUCCEEDED(hr) && accessible, "MSAA tree unavailable")) return 1;
        VARIANT self;
        VariantInit(&self);
        self.vt = VT_I4;
        self.lVal = CHILDID_SELF;
        BSTR name = nullptr;
        hr = accessible->get_accName(self, &name);
        bool named = SUCCEEDED(hr) && name && wcscmp(name, changed ? L"Changed name" : L"Favorites") == 0;
        SysFreeString(name);
        accessible->Release();
        tree->Release();
        uia->Release();
        CoUninitialize();
        return Check(named, "MSAA tree name differs") ? 0 : 1;
    }
    IUIAutomationSelectionPattern* treeSelect = nullptr;
    hr = tree->GetCurrentPatternAs(UIA_SelectionPatternId, __uuidof(IUIAutomationSelectionPattern),
                                   (void**)&treeSelect);
    if (!Check(SUCCEEDED(hr) && treeSelect, "tree selection pattern unavailable")) {
        return 1;
    }
    treeSelect->Release();
    IUIAutomationScrollPattern* scroll = nullptr;
    hr = tree->GetCurrentPatternAs(UIA_ScrollPatternId, __uuidof(IUIAutomationScrollPattern), (void**)&scroll);
    if (!Check(SUCCEEDED(hr) && scroll, "tree scroll pattern unavailable")) {
        return 1;
    }
    BOOL verticallyScrollable = FALSE;
    hr = scroll->get_CurrentVerticallyScrollable(&verticallyScrollable);
    if (!Check(SUCCEEDED(hr) && verticallyScrollable, "tree should scroll vertically")) {
        return 1;
    }
    hr = scroll->Scroll(ScrollAmount_NoAmount, ScrollAmount_LargeIncrement);
    double percent = 0;
    HRESULT percentHr = scroll->get_CurrentVerticalScrollPercent(&percent);
    if (!Check(SUCCEEDED(hr) && SUCCEEDED(percentHr) && percent > 0, "tree did not scroll")) {
        return 1;
    }
    scroll->SetScrollPercent(UIA_ScrollPatternNoScroll, 0);
    scroll->Release();
    IUIAutomationTreeWalker* walker = nullptr;
    hr = uia->get_ControlViewWalker(&walker);
    if (!Check(SUCCEEDED(hr) && walker, "control view unavailable")) {
        return 1;
    }
    IUIAutomationElement* root = nullptr;
    hr = walker->GetFirstChildElement(tree, &root);
    while (root) {
        root->get_CurrentControlType(&type);
        if (type == UIA_TreeItemControlTypeId) {
            break;
        }
        IUIAutomationElement* next = nullptr;
        walker->GetNextSiblingElement(root, &next);
        root->Release();
        root = next;
    }
    if (!Check(SUCCEEDED(hr) && root, "first tree item unavailable")) {
        return 1;
    }
    root->get_CurrentControlType(&type);
    BSTR name = nullptr;
    root->get_CurrentName(&name);
    bool ok = Check(type == UIA_TreeItemControlTypeId, "first child is not a tree item") &&
              Check(name && wcscmp(name, L"Node 6") == 0, "first item name differs");
    SysFreeString(name);
    IUIAutomationExpandCollapsePattern* expand = nullptr;
    hr = root->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, __uuidof(IUIAutomationExpandCollapsePattern),
                                   (void**)&expand);
    ok = Check(SUCCEEDED(hr) && expand, "expand pattern unavailable") && ok;
    if (expand) {
        ExpandCollapseState state = ExpandCollapseState_LeafNode;
        hr = expand->get_CurrentExpandCollapseState(&state);
        ok = Check(SUCCEEDED(hr) && state == ExpandCollapseState_Collapsed, "first item is not collapsed") && ok;
        hr = expand->Expand();
        ok = Check(SUCCEEDED(hr), "expand failed") && ok;
        hr = expand->get_CurrentExpandCollapseState(&state);
        ok = Check(SUCCEEDED(hr) && state == ExpandCollapseState_Expanded, "first item is not expanded") && ok;
    }
    IUIAutomationElement* child = nullptr;
    hr = walker->GetFirstChildElement(root, &child);
    ok = Check(SUCCEEDED(hr) && child, "expanded child unavailable") && ok;
    if (child) {
        BSTR childName = nullptr;
        hr = child->get_CurrentName(&childName);
        ok = Check(SUCCEEDED(hr) && childName && wcscmp(childName, L"Node 16") == 0, "child name differs") && ok;
        SysFreeString(childName);
        if (scrollItemTest) {
            IUIAutomationScrollItemPattern* scrollItem = nullptr;
            hr = child->GetCurrentPatternAs(UIA_ScrollItemPatternId, __uuidof(IUIAutomationScrollItemPattern),
                                            (void**)&scrollItem);
            ok = Check(SUCCEEDED(hr) && scrollItem, "scroll item pattern unavailable") && ok;
            if (scrollItem) {
                fprintf(stderr, "calling ScrollIntoView\n");
                hr = scrollItem->ScrollIntoView();
                ok = Check(SUCCEEDED(hr), "scroll item into view failed") && ok;
                scrollItem->Release();
            }
        }
        IUIAutomationSelectionItemPattern* select = nullptr;
        hr = child->GetCurrentPatternAs(UIA_SelectionItemPatternId, __uuidof(IUIAutomationSelectionItemPattern),
                                        (void**)&select);
        ok = Check(SUCCEEDED(hr) && select, "selection item pattern unavailable") && ok;
        if (select) {
            hr = select->Select();
            BOOL selected = FALSE;
            select->get_CurrentIsSelected(&selected);
            ok = Check(SUCCEEDED(hr) && selected, "item selection failed") && ok;
            select->Release();
        }
        child->Release();
    }
    if (expand) {
        hr = expand->Collapse();
        ok = Check(SUCCEEDED(hr), "collapse failed") && ok;
        ExpandCollapseState state = ExpandCollapseState_LeafNode;
        hr = expand->get_CurrentExpandCollapseState(&state);
        ok = Check(SUCCEEDED(hr) && state == ExpandCollapseState_Collapsed, "collapse state differs") && ok;
        expand->Release();
    }
    IUIAutomationSelectionItemPattern* rootSelect = nullptr;
    hr = root->GetCurrentPatternAs(UIA_SelectionItemPatternId, __uuidof(IUIAutomationSelectionItemPattern),
                                   (void**)&rootSelect);
    ok = Check(SUCCEEDED(hr) && rootSelect, "root selection pattern unavailable") && ok;
    if (rootSelect) {
        BOOL selected = FALSE;
        hr = rootSelect->get_CurrentIsSelected(&selected);
        ok = Check(SUCCEEDED(hr) && selected, "collapse did not select the ancestor") && ok;
        rootSelect->Release();
    }
    IAccessible* accessible = nullptr;
    hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, (void**)&accessible);
    ok = Check(SUCCEEDED(hr) && accessible, "MSAA tree unavailable") && ok;
    if (accessible) {
        if (checkName) {
            VARIANT self;
            VariantInit(&self);
            self.vt = VT_I4;
            self.lVal = CHILDID_SELF;
            BSTR treeName = nullptr;
            hr = accessible->get_accName(self, &treeName);
            ok = Check(SUCCEEDED(hr) && treeName && wcscmp(treeName, L"Bookmarks") == 0,
                       "MSAA tree name differs") && ok;
            SysFreeString(treeName);
        }
        long count = 0;
        accessible->get_accChildCount(&count);
        ok = Check(count > 0, "MSAA tree has no children") && ok;
        VARIANT first;
        VariantInit(&first);
        long fetched = 0;
        hr = AccessibleChildren(accessible, 0, 1, &first, &fetched);
        ok = Check(SUCCEEDED(hr) && fetched == 1, "MSAA first item unavailable") && ok;
        if (fetched == 1) {
            VARIANT role;
            VariantInit(&role);
            hr = accessible->get_accRole(first, &role);
            ok = Check(SUCCEEDED(hr) && role.vt == VT_I4 && role.lVal == ROLE_SYSTEM_OUTLINEITEM,
                       "MSAA first child is not a tree item") && ok;
            BSTR itemName = nullptr;
            hr = accessible->get_accName(first, &itemName);
            ok = Check(SUCCEEDED(hr) && itemName && wcscmp(itemName, L"Node 6") == 0,
                       "MSAA first item name differs") && ok;
            SysFreeString(itemName);
            VariantClear(&role);
            VariantClear(&first);
        }
        if (checkName && count > 0) {
            VARIANT last;
            VariantInit(&last);
            long lastFetched = 0;
            hr = AccessibleChildren(accessible, count - 1, 1, &last, &lastFetched);
            ok = Check(SUCCEEDED(hr) && lastFetched == 1, "MSAA last item unavailable") && ok;
            if (lastFetched == 1) {
                hr = accessible->accSelect(SELFLAG_TAKESELECTION, last);
                ok = Check(SUCCEEDED(hr), "MSAA last item selection failed") && ok;
                IUIAutomationScrollPattern* finalScroll = nullptr;
                hr = tree->GetCurrentPatternAs(UIA_ScrollPatternId, __uuidof(IUIAutomationScrollPattern),
                                               (void**)&finalScroll);
                if (SUCCEEDED(hr) && finalScroll) {
                    double finalPercent = 0;
                    hr = finalScroll->get_CurrentVerticalScrollPercent(&finalPercent);
                    ok = Check(SUCCEEDED(hr) && finalPercent == 100, "MSAA selection lost bottom padding") && ok;
                    finalScroll->Release();
                } else {
                    ok = Check(false, "tree scroll pattern unavailable after MSAA selection") && ok;
                }
                VariantClear(&last);
            }
        }
        accessible->Release();
    }
    root->Release();
    walker->Release();
    tree->Release();
    uia->Release();
    CoUninitialize();
    return ok ? 0 : 1;
}
