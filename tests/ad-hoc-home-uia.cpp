#include <windows.h>
#include <uiautomation.h>
#include <wrl/client.h>
#include <stdio.h>
#include <string>

using Microsoft::WRL::ComPtr;

static bool Check(bool ok, const char* what) {
    if (!ok) {
        fprintf(stderr, "%s\n", what);
    }
    return ok;
}

static std::wstring Name(IUIAutomationElement* el) {
    BSTR name = nullptr;
    el->get_CurrentName(&name);
    std::wstring result = name ? name : L"";
    SysFreeString(name);
    return result;
}

static ComPtr<IUIAutomationElement> Find(IUIAutomationElement* parent, IUIAutomation* uia, int type) {
    ComPtr<IUIAutomationCondition> condition;
    VARIANT v{};
    v.vt = VT_I4;
    v.lVal = type;
    uia->CreatePropertyCondition(UIA_ControlTypePropertyId, v, &condition);
    ComPtr<IUIAutomationElement> item;
    parent->FindFirst(TreeScope_Subtree, condition.Get(), &item);
    return item;
}

template <class T>
static ComPtr<T> Pattern(IUIAutomationElement* el, int id) {
    ComPtr<T> pattern;
    if (el) {
        el->GetCurrentPatternAs(id, IID_PPV_ARGS(&pattern));
    }
    return pattern;
}

static bool Exchange(const char* message) {
    puts(message);
    fflush(stdout);
    return getchar() == '\n';
}

static bool Run(HWND hwnd) {
    ComPtr<IUIAutomation> uia;
    HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia));
    if (!Check(SUCCEEDED(hr), "UI Automation unavailable")) return false;
    ComPtr<IUIAutomationElement> canvas;
    hr = uia->ElementFromHandle(hwnd, &canvas);
    if (!Check(SUCCEEDED(hr) && canvas, "Canvas unavailable")) return false;

    auto home = Find(canvas.Get(), uia.Get(), UIA_ListControlTypeId);
    auto open = Find(canvas.Get(), uia.Get(), UIA_HyperlinkControlTypeId);
    RECT bounds{};
    if (!Check(open && Name(open.Get()).find(L"Open") == 0 &&
                   Pattern<IUIAutomationInvokePattern>(open.Get(), UIA_InvokePatternId) &&
                   SUCCEEDED(open->get_CurrentBoundingRectangle(&bounds)) && bounds.right > bounds.left,
               "Home Open link unavailable"))
        return false;
    if (!Check(!!home, "Home list unavailable")) return false;

    ComPtr<IUIAutomationCondition> condition;
    VARIANT type{};
    type.vt = VT_I4;
    type.lVal = UIA_ListItemControlTypeId;
    uia->CreatePropertyCondition(UIA_ControlTypePropertyId, type, &condition);
    ComPtr<IUIAutomationElementArray> items;
    int count = 0;
    home->FindAll(TreeScope_Children, condition.Get(), &items);
    if (items) items->get_Length(&count);
    if (!Check(count == 2, "Expected two Home entries")) return false;
    ComPtr<IUIAutomationElement> first, target;
    items->GetElement(0, &first);
    items->GetElement(1, &target);
    if (Name(first.Get()).find(L"target-folder") != std::wstring::npos) first.Swap(target);
    if (!Check(Name(first.Get()).find(L"same.pdf") != std::wstring::npos &&
                   Name(target.Get()).find(L"same.pdf") != std::wstring::npos &&
                   Name(target.Get()).find(L"target-folder") != std::wstring::npos &&
                   Name(first.Get()) != Name(target.Get()),
               "Names must disambiguate identical filenames"))
        return false;

    auto select = Pattern<IUIAutomationSelectionItemPattern>(target.Get(), UIA_SelectionItemPatternId);
    auto invoke = Pattern<IUIAutomationInvokePattern>(target.Get(), UIA_InvokePatternId);
    auto selection = Pattern<IUIAutomationSelectionPattern>(home.Get(), UIA_SelectionPatternId);
    if (!Exchange("ready")) return false;
    BOOL selected = FALSE;
    if (!Check(select && invoke && selection && SUCCEEDED(select->Select()) &&
                   SUCCEEDED(select->get_CurrentIsSelected(&selected)) && selected,
               "UIA could not select the target"))
        return false;
    ComPtr<IUIAutomationElementArray> picked;
    selection->GetCurrentSelection(&picked);
    count = 0;
    if (picked) picked->get_Length(&count);
    ComPtr<IUIAutomationElement> chosen;
    if (count == 1) picked->GetElement(0, &chosen);
    if (!Check(chosen && Name(chosen.Get()) == Name(target.Get()), "UIA selection disagrees with the item"))
        return false;

    if (!Exchange("selected")) return false;
    if (!Check(invoke->Invoke() == UIA_E_ELEMENTNOTAVAILABLE && select->Select() == UIA_E_ELEMENTNOTAVAILABLE,
               "Filtered entry was still actionable"))
        return false;
    if (!Check(!Find(home.Get(), uia.Get(), UIA_ListItemControlTypeId), "Filtered Home still has items")) return false;

    if (!Exchange("filtered")) return false;
    items.Reset();
    home->FindAll(TreeScope_Children, condition.Get(), &items);
    count = 0;
    if (items) items->get_Length(&count);
    if (!Check(count == 2, "Expected two restored Home entries")) return false;
    ComPtr<IUIAutomationInvokePattern> current;
    for (int i = 0; i < count; i++) {
        ComPtr<IUIAutomationElement> candidate;
        items->GetElement(i, &candidate);
        if (Name(candidate.Get()).find(L"target-folder") != std::wstring::npos) {
            current = Pattern<IUIAutomationInvokePattern>(candidate.Get(), UIA_InvokePatternId);
        }
    }
    if (!Check(current && SUCCEEDED(current->Invoke()), "UIA could not open the target")) return false;
    if (!Exchange("invoked")) return false;
    if (!Check(current->Invoke() == UIA_E_ELEMENTNOTAVAILABLE, "Home entry survived document switch")) return false;
    if (!Exchange("switched")) return false;
    return Check(current->Invoke() == UIA_E_ELEMENTNOTAVAILABLE, "Home entry survived window close");
}

int main(int argc, char** argv) {
    if (argc != 2) return 1;
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool ok = Run((HWND)(intptr_t)_atoi64(argv[1]));
    CoUninitialize();
    return ok ? 0 : 1;
}
