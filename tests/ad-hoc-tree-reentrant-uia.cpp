#include <windows.h>
#include <oleacc.h>
#include <uiautomation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int Fail(const char* stage, HRESULT hr) {
    fprintf(stderr, "%s failed: 0x%08lx\n", stage, (unsigned long)hr);
    return 1;
}

int main(int argc, char** argv) {
    if (argc != 4) return 2;
    HWND hwnd = (HWND)(intptr_t)_atoi64(argv[1]);
    bool msaa = strncmp(argv[2], "msaa", 4) == 0;
    bool onExpand = strstr(argv[2], "expand") != nullptr;
    int action = atoi(argv[3]);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IUIAutomation* uia = nullptr;
    HRESULT hr =
        CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation), (void**)&uia);
    if (FAILED(hr) || !uia) return Fail("UIA factory", hr);
    IUIAutomationElement* tree = nullptr;
    hr = uia->ElementFromHandle(hwnd, &tree);
    if (FAILED(hr) || !tree) return Fail("tree", hr);
    IUIAutomationTreeWalker* walker = nullptr;
    hr = uia->get_ControlViewWalker(&walker);
    if (FAILED(hr) || !walker) return Fail("walker", hr);
    IUIAutomationElement* root = nullptr;
    hr = walker->GetFirstChildElement(tree, &root);
    while (SUCCEEDED(hr) && root) {
        CONTROLTYPEID type = 0;
        root->get_CurrentControlType(&type);
        if (type == UIA_TreeItemControlTypeId) break;
        IUIAutomationElement* next = nullptr;
        hr = walker->GetNextSiblingElement(root, &next);
        root->Release();
        root = next;
    }
    if (FAILED(hr) || !root) return Fail("root", hr);
    IUIAutomationElement* item = root;
    if (onExpand && !msaa) {
        IUIAutomationExpandCollapsePattern* expansion = nullptr;
        hr = root->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, __uuidof(IUIAutomationExpandCollapsePattern),
                                       (void**)&expansion);
        if (FAILED(hr) || !expansion) return Fail("expand pattern", hr);
        hr = expansion->Expand();
        if (FAILED(hr)) return Fail("expand", hr);
        hr = walker->GetFirstChildElement(root, &item);
        if (FAILED(hr) || !item) return Fail("nested item", hr);
        hr = expansion->Collapse();
        if (FAILED(hr)) return Fail("collapse", hr);
        expansion->Release();
    }
    if (!onExpand) SendMessageW(hwnd, WM_VSCROLL, SB_BOTTOM, 0);
    SendMessageW(hwnd, WM_APP + 101, onExpand ? 30 : 31, action);
    if (msaa) {
        IAccessible* accessible = nullptr;
        hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, (void**)&accessible);
        if (FAILED(hr) || !accessible) return Fail("MSAA", hr);
        VARIANT child;
        VariantInit(&child);
        child.vt = VT_I4;
        child.lVal = onExpand ? 2 : 1;
        hr = accessible->accSelect(SELFLAG_TAKESELECTION, child);
        accessible->Release();
    } else {
        IUIAutomationScrollItemPattern* scroll = nullptr;
        hr = item->GetCurrentPatternAs(UIA_ScrollItemPatternId, __uuidof(IUIAutomationScrollItemPattern),
                                       (void**)&scroll);
        if (FAILED(hr) || !scroll) return Fail("scroll pattern", hr);
        hr = scroll->ScrollIntoView();
        scroll->Release();
    }
    if (item != root) item->Release();
    root->Release();
    walker->Release();
    tree->Release();
    uia->Release();
    CoUninitialize();
    if (SUCCEEDED(hr)) {
        fprintf(stderr, "%s action %d accepted an invalidated item\n", argv[2], action);
        return 1;
    }
    return 0;
}
