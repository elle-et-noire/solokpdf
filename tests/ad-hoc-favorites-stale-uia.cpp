#include <windows.h>
#include <oleacc.h>
#include <uiautomation.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    HWND hwnd = (HWND)(intptr_t)_atoi64(argv[1]);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IUIAutomation* uia = nullptr;
    HRESULT hr =
        CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation), (void**)&uia);
    if (FAILED(hr) || !uia) return 1;
    IUIAutomationElement* tree = nullptr;
    hr = uia->ElementFromHandle(hwnd, &tree);
    if (FAILED(hr) || !tree) return 1;
    IUIAutomationTreeWalker* walker = nullptr;
    hr = uia->get_ControlViewWalker(&walker);
    if (FAILED(hr) || !walker) return 1;
    IUIAutomationElement* item = nullptr;
    hr = walker->GetFirstChildElement(tree, &item);
    while (SUCCEEDED(hr) && item) {
        CONTROLTYPEID type = 0;
        item->get_CurrentControlType(&type);
        if (type == UIA_TreeItemControlTypeId) break;
        IUIAutomationElement* next = nullptr;
        hr = walker->GetNextSiblingElement(item, &next);
        item->Release();
        item = next;
    }
    if (FAILED(hr) || !item) return 1;
    IAccessible* accessible = nullptr;
    hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, (void**)&accessible);
    if (FAILED(hr) || !accessible) return 1;
    BSTR oldName = nullptr;
    hr = item->get_CurrentName(&oldName);
    bool validItem = SUCCEEDED(hr) && oldName && SysStringLen(oldName) > 0;
    SysFreeString(oldName);
    long oldCount = 0;
    hr = accessible->get_accChildCount(&oldCount);
    if (!validItem || FAILED(hr) || oldCount <= 0) return 1;
    puts("READY");
    fflush(stdout);
    char line[16];
    if (!fgets(line, sizeof(line), stdin)) return 1;
    BSTR name = nullptr;
    HRESULT itemHr = item->get_CurrentName(&name);
    SysFreeString(name);
    long count = 0;
    HRESULT msaaHr = accessible->get_accChildCount(&count);
    if (SUCCEEDED(itemHr) || SUCCEEDED(msaaHr)) {
        fprintf(stderr, "stale providers remained connected: UIA=0x%08lx MSAA=0x%08lx\n", (unsigned long)itemHr,
                (unsigned long)msaaHr);
        return 1;
    }
    IUIAutomationElement* fresh = nullptr;
    hr = walker->GetFirstChildElement(tree, &fresh);
    while (SUCCEEDED(hr) && fresh) {
        CONTROLTYPEID type = 0;
        fresh->get_CurrentControlType(&type);
        if (type == UIA_TreeItemControlTypeId) break;
        IUIAutomationElement* next = nullptr;
        hr = walker->GetNextSiblingElement(fresh, &next);
        fresh->Release();
        fresh = next;
    }
    if (FAILED(hr) || !fresh) return 1;
    name = nullptr;
    hr = fresh->get_CurrentName(&name);
    bool correct = SUCCEEDED(hr) && name && wcsstr(name, L"Page 1");
    SysFreeString(name);
    if (!correct) return 1;
    fresh->Release();
    IAccessible* freshMsaa = nullptr;
    hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, (void**)&freshMsaa);
    if (FAILED(hr) || !freshMsaa) return 1;
    long freshCount = 0;
    hr = freshMsaa->get_accChildCount(&freshCount);
    if (FAILED(hr) || freshCount != 1) return 1;
    VARIANT child;
    VariantInit(&child);
    child.vt = VT_I4;
    child.lVal = 1;
    name = nullptr;
    hr = freshMsaa->get_accName(child, &name);
    correct = SUCCEEDED(hr) && name && wcsstr(name, L"Page 1");
    SysFreeString(name);
    freshMsaa->Release();
    if (!correct) return 1;
    accessible->Release();
    item->Release();
    walker->Release();
    tree->Release();
    uia->Release();
    CoUninitialize();
    return 0;
}
