/* Copyright 2026 the SolokPDF project authors.
   License: GPLv3 */

#include "base/Base.h"
#include "base/Win.h"
#include "gui/Dpi.h"
#include "gui/UIModels.h"
#include "gui/Layout.h"
#include "gui/win/WinGui.h"
#include "gui/PlatformFont.h"
#include "gui/Gfx.h"
#include "gui/GuiColors.h"
#include "gui/VirtCtrl.h"

#include "Settings.h"
#include "AppSettings.h"
#include "Commands.h"
#include "Accelerators.h"
#include "EngineBase.h"
#include "MainWindow.h"
#include "AppTools.h"
#include "Translations.h"
#include "Theme.h"
#include "DarkMode.h"
#include "SumatraConfig.h"
#include "SumatraPDF.h"
#include "PdfToolsCommon.h"
#include "SumatraDialogs.h"

static Shortcut* CopyShortcut(const Shortcut* from) {
    auto* sc = (Shortcut*)calloc(1, sizeof(Shortcut));
    sc->cmd = str::Dup(from->cmd);
    sc->key = str::Dup(from->key);
    sc->name = str::Dup(from->name);
    sc->toolbarText = str::Dup(from->toolbarText);
    sc->toolbarSvgIcon = str::Dup(from->toolbarSvgIcon);
    return sc;
}

static void FreeShortcut(Shortcut* sc) {
    str::Free(sc->cmd);
    str::Free(sc->key);
    str::Free(sc->name);
    str::Free(sc->toolbarText);
    str::Free(sc->toolbarSvgIcon);
    free(sc);
}

static int DefinitionCmdId(Str definition) {
    str::TrimWs(definition);
    Str name;
    str::CutChar(definition, ' ', &name, nullptr);
    return GetCommandIdByName(name);
}

static int OriginalCmdId(int id) {
    CustomCommand* custom = FindCustomCommand(id);
    return custom ? custom->origId : id;
}

enum class ConflictMode {
    Ask,
    Replace
};

struct ShortcutsWnd : WindowBase {
    ~ShortcutsWnd() override;

    MainWindow* win = nullptr;
    Edit* filter = nullptr;
    Edit* argument = nullptr;
    VirtListBox* commands = nullptr;
    VirtListBox* bindings = nullptr;
    ListBoxModelStrings* commandModel = nullptr;
    ListBoxModelStrings* bindingModel = nullptr;
    VirtText* captureHint = nullptr;
    VirtButton* removeButton = nullptr;
    VirtButton* okButton = nullptr;
    Vec<Shortcut*> draft;
    Vec<Accel> defaults;
    Vec<int> shownCommands;
    Vec<int> shownBindings;
    int bindingCommandId = 0;
    bool capturing = false;

    bool Create(MainWindow* mainWin);
    int SelectedCommand() const;
    int DraftForKey(const KeyShortcut& key) const;
    int OwnerOfKey(const KeyShortcut& key) const;
    TempStr KeysForCommand(int cmdId) const;
    void RefreshCommands();
    void RefreshBindings();
    void OnBindingSelected();
    void OnKeyDown(KeyEvent* ev);
    void OnAdd(VirtMouseEvent* ev = nullptr);
    void OnRemove(VirtMouseEvent* ev = nullptr);
    void OnReset(VirtMouseEvent* ev = nullptr);
    void OnCancel(VirtMouseEvent* ev = nullptr);
    void OnOk(VirtMouseEvent* ev = nullptr);
    bool Assign(Str key, ConflictMode mode = ConflictMode::Ask);
};

static ShortcutsWnd* gShortcutsWnd = nullptr;

ShortcutsWnd::~ShortcutsWnd() {
    for (Shortcut* sc : draft) {
        FreeShortcut(sc);
    }
}

int ShortcutsWnd::SelectedCommand() const {
    int row = commands->GetCurrentSelection();
    return row >= 0 && row < len(shownCommands) ? shownCommands[row] : 0;
}

int ShortcutsWnd::DraftForKey(const KeyShortcut& key) const {
    for (int i = 0; i < len(draft); i++) {
        KeyShortcut other;
        if (ParseShortcutString(draft[i]->key, other) && other.SameKey(key)) {
            return i;
        }
    }
    return -1;
}

int ShortcutsWnd::OwnerOfKey(const KeyShortcut& key) const {
    int idx = DraftForKey(key);
    if (idx >= 0) {
        return DefinitionCmdId(draft[idx]->cmd);
    }
    for (const Accel& accel : defaults) {
        if (accel.sc.SameKey(key)) {
            return OriginalCmdId(accel.cmd);
        }
    }
    return 0;
}

TempStr ShortcutsWnd::KeysForCommand(int cmdId) const {
    str::Builder keys;
    for (Shortcut* sc : draft) {
        if (DefinitionCmdId(sc->cmd) != cmdId || len(sc->key) == 0) {
            continue;
        }
        if (len(keys)) {
            keys.Append(StrL(", "));
        }
        keys.Append(fmt("%s (%s)", sc->key, Tr("user")));
    }
    for (const Accel& accel : defaults) {
        if (OriginalCmdId(accel.cmd) != cmdId || DraftForKey(accel.sc) >= 0) {
            continue;
        }
        if (len(keys)) {
            keys.Append(StrL(", "));
        }
        keys.Append(ShortcutToGpuiStroke(accel.sc));
    }
    return ToStrTemp(keys);
}

void ShortcutsWnd::RefreshCommands() {
    int selected = commands->GetCurrentSelection();
    int selectedId = selected >= 0 && selected < len(shownCommands) ? shownCommands[selected] : 0;
    VecReset(shownCommands);
    commandModel->strings.Reset();
    Str query = filter->GetTextTemp();
    str::TrimWs(query);
    for (int i = 0; i < gCommandsCount; i++) {
        int id = gCommands[i].id;
        Str name = GetCommandName(id);
        Str desc = Tr(GetCommandDescription(id));
        TempStr keys = KeysForCommand(id);
        if (len(query) && !str::ContainsI(name, query) && !str::ContainsI(desc, query) &&
            !str::ContainsI(keys, query)) {
            continue;
        }
        VecAppend(shownCommands, id);
        commandModel->strings.Append(fmt("%s — %s — %s", name, desc, len(keys) ? keys : Tr("Unassigned")));
    }
    commands->SetModel(commandModel);
    int row = 0;
    for (int i = 0; i < len(shownCommands); i++) {
        if (shownCommands[i] == selectedId) {
            row = i;
            break;
        }
    }
    if (len(shownCommands)) {
        commands->SetCurrentSelection(row);
    }
    RefreshBindings();
}

void ShortcutsWnd::RefreshBindings() {
    int cmdId = SelectedCommand();
    if (cmdId != bindingCommandId) {
        bindingCommandId = cmdId;
        if (argument) {
            HwndSetText(argument->hwnd, StrL(""));
        }
    }
    VecReset(shownBindings);
    bindingModel->strings.Reset();
    for (int i = 0; i < len(draft); i++) {
        Shortcut* sc = draft[i];
        if (DefinitionCmdId(sc->cmd) != cmdId || len(sc->key) == 0) {
            continue;
        }
        VecAppend(shownBindings, i);
        bindingModel->strings.Append(fmt("%s — %s (%s)", sc->key, sc->cmd, Tr("user")));
    }
    for (const Accel& accel : defaults) {
        if (OriginalCmdId(accel.cmd) != cmdId || DraftForKey(accel.sc) >= 0) {
            continue;
        }
        VecAppend(shownBindings, -1);
        bindingModel->strings.Append(fmt("%s (%s)", ShortcutToGpuiStroke(accel.sc), Tr("default")));
    }
    bindings->SetModel(bindingModel);
    if (len(shownBindings)) {
        bindings->SetCurrentSelection(0);
    }
    OnBindingSelected();
}

void ShortcutsWnd::OnBindingSelected() {
    int row = bindings->GetCurrentSelection();
    removeButton->SetIsEnabled(row >= 0 && row < len(shownBindings) && shownBindings[row] >= 0);
}

bool ShortcutsWnd::Assign(Str keyText, ConflictMode mode) {
    int cmdId = SelectedCommand();
    KeyShortcut key;
    if (!cmdId || !ParseShortcutString(keyText, key)) {
        return false;
    }
    Str name = GetCommandName(cmdId);
    Str arg = argument->GetTextTemp();
    str::TrimWs(arg);
    TempStr definition = len(arg) ? fmt("%s %s", name, arg) : str::DupTemp(name);
    if (len(arg)) {
        CustomCommand* parsed = CreateCommandFromDefinition(definition);
        if (!parsed || !parsed->firstArg) {
            MsgBox(hwnd, Tr("Invalid command argument"), Tr("Keyboard Shortcuts"), MB_OK | MB_ICONERROR);
            return false;
        }
    }
    int owner = OwnerOfKey(key);
    if (owner && owner != cmdId && mode == ConflictMode::Ask) {
        Str prompt = fmt(Tr("%s is assigned to %s. Reassign it?").s, keyText, GetCommandName(owner));
        if (MsgBox(hwnd, prompt, Tr("Keyboard Shortcuts"), MB_YESNO | MB_ICONQUESTION) != IDYES) {
            return false;
        }
    }
    int old = DraftForKey(key);
    if (old >= 0) {
        FreeShortcut(draft[old]);
        VecRemoveAt(draft, old);
    }
    Shortcut sc{};
    sc.cmd = definition;
    sc.key = keyText;
    VecAppend(draft, CopyShortcut(&sc));
    RefreshCommands();
    return true;
}

void ShortcutsWnd::OnKeyDown(KeyEvent* ev) {
    if (capturing) {
        ev->didHandle = true;
        if (ev->vkey == VK_ESCAPE) {
            capturing = false;
            captureHint->SetText(Tr("Select a command and press Add key..."));
            return;
        }
        if (ev->vkey == VK_SHIFT || ev->vkey == VK_CONTROL || ev->vkey == VK_MENU) {
            return;
        }
        u8 mods = KeyShortcut::kVirtKey;
        if (ev->isCtrl) {
            mods |= KeyShortcut::kCtrlKey;
        }
        if (ev->isShift) {
            mods |= KeyShortcut::kShiftKey;
        }
        if (ev->isAlt) {
            mods |= KeyShortcut::kAltKey;
        }
        TempStr key = ShortcutToGpuiStroke(KeyShortcut(mods, (u16)ev->vkey));
        if (len(key) && Assign(key)) {
            capturing = false;
            captureHint->SetText(Tr("Select a command and press Add key..."));
        }
        return;
    }
    if (ev->vkey == VK_ESCAPE) {
        OnCancel();
        ev->didHandle = true;
    }
}

void ShortcutsWnd::OnAdd(VirtMouseEvent*) {
    if (!SelectedCommand()) {
        return;
    }
    capturing = true;
    captureHint->SetText(Tr("Press a key combination. Esc cancels capture."));
    HwndSetFocus(hwnd);
}

void ShortcutsWnd::OnRemove(VirtMouseEvent*) {
    int row = bindings->GetCurrentSelection();
    if (row < 0 || row >= len(shownBindings)) {
        return;
    }
    int idx = shownBindings[row];
    if (idx < 0) {
        return;
    }
    FreeShortcut(draft[idx]);
    VecRemoveAt(draft, idx);
    RefreshCommands();
}

void ShortcutsWnd::OnReset(VirtMouseEvent*) {
    int cmdId = SelectedCommand();
    for (int i = len(draft) - 1; i >= 0; i--) {
        bool remove = DefinitionCmdId(draft[i]->cmd) == cmdId;
        KeyShortcut key;
        if (ParseShortcutString(draft[i]->key, key)) {
            for (const Accel& accel : defaults) {
                if (OriginalCmdId(accel.cmd) == cmdId && accel.sc.SameKey(key)) {
                    remove = true;
                    break;
                }
            }
        }
        if (!remove) {
            continue;
        }
        FreeShortcut(draft[i]);
        VecRemoveAt(draft, i);
    }
    RefreshCommands();
}

void ShortcutsWnd::OnCancel(VirtMouseEvent*) {
    ScheduleDelete();
}

void ShortcutsWnd::OnOk(VirtMouseEvent*) {
    ScheduleDelete();
    for (Shortcut* sc : *gSettings->shortcuts) {
        FreeShortcut(sc);
    }
    VecReset(*gSettings->shortcuts);
    for (Shortcut* sc : draft) {
        VecAppend(*gSettings->shortcuts, sc);
    }
    VecReset(draft);
    ScheduleSaveSettings();
    ForceReloadSettings();
}

bool ShortcutsWnd::Create(MainWindow* mainWin) {
    win = mainWin;
    for (Shortcut* sc : *gSettings->shortcuts) {
        VecAppend(draft, CopyShortcut(sc));
    }
    GetDefaultAccelerators(defaults);

    PlatformFont* font = DlgUiFont(kToolDlgTextFontPx);
    SetFont(font);
    Color bg = ThemeWindowControlBackgroundColor();
    Color text = ThemeWindowTextColor();
    CreateCustomArgs args;
    args.title = Tr("Keyboard Shortcuts");
    args.visible = false;
    args.style = WS_POPUPWINDOW | WS_CAPTION | WS_THICKFRAME;
    args.font = font;
    args.bgColor = bg;
    args.icon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(GetAppIconID()));
    CreateCustom(args);
    if (!hwnd) {
        return false;
    }
    SetColors(text, bg);

    auto* vbox = new VBox();
    vbox->alignCross = CrossAxisAlign::Stretch;
    Edit::CreateArgs editArgs;
    editArgs.parent = hwnd;
    editArgs.font = font;
    editArgs.cueText = Tr("Filter commands, descriptions, or keys");
    filter = new Edit();
    filter->SetColors(text, bg);
    filter->Create(editArgs);
    filter->onTextChanged = MkMethod0<ShortcutsWnd, &ShortcutsWnd::RefreshCommands>(this);
    vbox->AddChild(new Padding(filter, DpiScaledInsets(8)));

    commands = new VirtListBox();
    commands->dpi = GetDpi();
    commands->font = font;
    commands->idealSizeLines = 15;
    commandModel = new ListBoxModelStrings();
    commands->SetModel(commandModel);
    commands->onSelectionChanged = MkMethod0<ShortcutsWnd, &ShortcutsWnd::RefreshBindings>(this);
    vbox->AddChild(commands, 1);

    captureHint = NewDlgLabel(Tr("Select a command and press Add key..."), font, ThemeWindowTextDisabledColor(),
                              DpiScale(kToolDlgRowDy));
    vbox->AddChild(new Padding(captureHint, DpiScaledInsets(4, 8)));

    bindings = new VirtListBox();
    bindings->dpi = GetDpi();
    bindings->font = font;
    bindings->idealSizeLines = 4;
    bindingModel = new ListBoxModelStrings();
    bindings->SetModel(bindingModel);
    bindings->onSelectionChanged = MkMethod0<ShortcutsWnd, &ShortcutsWnd::OnBindingSelected>(this);
    vbox->AddChild(bindings);

    auto* argRow = NewDlgFieldRow();
    argRow->AddChild(NewDlgLabel(Tr("Command &argument (optional):"), font, ThemeWindowTextDisabledColor(),
                                 DpiScale(kToolDlgRowDy), true));
    editArgs.cueText = Tr("e.g. 4 for CmdScrollDown 4");
    argument = new Edit();
    argument->SetColors(text, bg);
    argument->Create(editArgs);
    argRow->AddChild(argument, 1);
    vbox->AddChild(new Padding(argRow, DpiScaledInsets(6, 8)));

    auto* actions = new HBox();
    actions->gap = DpiScale(8);
    auto* add = NewDlgButton(hwnd, Tr("Add key..."), font, DlgButtonStyle::Outline, false);
    add->onClick = MkMethod1<ShortcutsWnd, VirtMouseEvent*, &ShortcutsWnd::OnAdd>(this);
    actions->AddChild(add);
    removeButton = NewDlgButton(hwnd, Tr("Remove key"), font, DlgButtonStyle::Outline, false);
    removeButton->onClick = MkMethod1<ShortcutsWnd, VirtMouseEvent*, &ShortcutsWnd::OnRemove>(this);
    actions->AddChild(removeButton);
    auto* reset = NewDlgButton(hwnd, Tr("Reset to defaults"), font, DlgButtonStyle::Outline, false);
    reset->onClick = MkMethod1<ShortcutsWnd, VirtMouseEvent*, &ShortcutsWnd::OnReset>(this);
    actions->AddChild(reset);
    vbox->AddChild(new Padding(actions, DpiScaledInsets(6, 8)));

    auto* cancel = NewDlgButton(hwnd, Tr("Cancel"), font, DlgButtonStyle::Outline, false);
    cancel->onClick = MkMethod1<ShortcutsWnd, VirtMouseEvent*, &ShortcutsWnd::OnCancel>(this);
    auto* ok = NewDlgButton(hwnd, Tr("OK"), font, DlgButtonStyle::Filled, true);
    ok->onClick = MkMethod1<ShortcutsWnd, VirtMouseEvent*, &ShortcutsWnd::OnOk>(this);
    okButton = ok;
    vbox->AddChild(NewDlgFooter(cancel, ok));
    layout = vbox;

    RefreshCommands();
    LayoutAndSizeToContent(layout, DpiScale(850), DpiScale(620), hwnd);
    DoLayout(HwndClientRect(hwnd).Size());
    HwndCenterDialog(hwnd, win->hwndFrame);
    UpdateTheme();
    DarkModeApplyToPopupWindow(hwnd);
    SetIsVisible(true);
    HwndSetFocus(filter->hwnd);
    return true;
}

static void ClearShortcutsWnd() {
    gShortcutsWnd = nullptr;
}

static void CloseShortcutsWnd(WindowBase::CloseEvent*) {
    if (gShortcutsWnd) {
        gShortcutsWnd->ScheduleDelete();
    }
}

static void DestroyShortcutsWnd(WindowBase::DestroyEvent*) {
    if (gShortcutsWnd) {
        gShortcutsWnd->ScheduleDelete();
    }
}

void ShowShortcutsDialog(MainWindow* win) {
    if (!win || !HasPermission(Perm::SavePreferences)) {
        return;
    }
    if (gShortcutsWnd) {
        HwndSetFocus(gShortcutsWnd->hwnd);
        return;
    }
    auto* wnd = new ShortcutsWnd();
    wnd->onBeforeDelete = MkFunc0Void(ClearShortcutsWnd);
    wnd->onClose = MkFunc1Void<WindowBase::CloseEvent*>(CloseShortcutsWnd);
    wnd->onDestroy = MkFunc1Void<WindowBase::DestroyEvent*>(DestroyShortcutsWnd);
    wnd->onKeyDown = MkMethod1<ShortcutsWnd, KeyEvent*, &ShortcutsWnd::OnKeyDown>(wnd);
    if (!wnd->Create(win)) {
        delete wnd;
        return;
    }
    gShortcutsWnd = wnd;
}

TempStr ShortcutsDialogTestTemp(Str action, Str command, Str key, Str arg, int* exitCodeOut) {
    if (exitCodeOut) {
        *exitCodeOut = 1;
    }
    if (str::Eq(action, StrL("press")) || str::Eq(action, StrL("resolve"))) {
        KeyShortcut shortcut;
        if (!ParseShortcutString(key, shortcut) || len(gWindows) == 0) {
            return str::DupTemp(StrL("invalid key or window"));
        }
        int n = 0;
        const Accel* accels = GetAcceleratorTable(n);
        for (int i = 0; i < n; i++) {
            if (!accels[i].sc.SameKey(shortcut)) {
                continue;
            }
            int cmdId = OriginalCmdId(accels[i].cmd);
            if (str::Eq(action, StrL("press"))) {
                SendMessageW(gWindows[0]->hwndFrame, WM_COMMAND, accels[i].cmd, 0);
            }
            if (exitCodeOut) {
                *exitCodeOut = 0;
            }
            return GetCommandName(cmdId);
        }
        return str::DupTemp(StrL("key unbound"));
    }
    ShortcutsWnd* wnd = gShortcutsWnd;
    if (!wnd) {
        return str::DupTemp(StrL("no dialog"));
    }
    if (str::Eq(action, StrL("state"))) {
        if (exitCodeOut) {
            *exitCodeOut = 0;
        }
        Rect cr = HwndClientRect(wnd->hwnd);
        Rect list = wnd->commands->BoundsInWindow();
        Rect ok = wnd->okButton->BoundsInWindow();
        return fmt("commands=%d bindings=%d client=%d list=%d,%d ok=%d,%d", len(wnd->shownCommands),
                   len(wnd->shownBindings), cr.dy, list.y, list.dy, ok.y, ok.dy);
    }
    if (str::Eq(action, StrL("add")) || str::Eq(action, StrL("reset")) || str::Eq(action, StrL("begin"))) {
        int cmdId = GetCommandIdByName(command);
        for (int i = 0; i < len(wnd->shownCommands); i++) {
            if (wnd->shownCommands[i] != cmdId) {
                continue;
            }
            wnd->commands->SetCurrentSelection(i);
            wnd->RefreshBindings();
            if (str::Eq(action, StrL("reset"))) {
                wnd->OnReset();
                if (exitCodeOut) {
                    *exitCodeOut = 0;
                }
                return fmt("reset=%s", command);
            }
            HwndSetText(wnd->argument->hwnd, arg);
            if (str::Eq(action, StrL("begin"))) {
                wnd->OnAdd();
                if (exitCodeOut) {
                    *exitCodeOut = 0;
                }
                return fmt("%d", (i64)(uintptr_t)wnd->hwnd);
            }
            if (!wnd->Assign(key, ConflictMode::Replace)) {
                return str::DupTemp(StrL("assignment failed"));
            }
            if (exitCodeOut) {
                *exitCodeOut = 0;
            }
            return fmt("assigned=%s key=%s", command, key);
        }
        return str::DupTemp(StrL("command not shown"));
    }
    if (str::Eq(action, StrL("has"))) {
        bool found = false;
        for (Shortcut* sc : wnd->draft) {
            if (DefinitionCmdId(sc->cmd) == GetCommandIdByName(command) && str::EqI(sc->key, key)) {
                found = true;
                break;
            }
        }
        if (exitCodeOut) {
            *exitCodeOut = 0;
        }
        return found ? StrL("1") : StrL("0");
    }
    if (str::Eq(action, StrL("save"))) {
        wnd->OnOk();
        if (exitCodeOut) {
            *exitCodeOut = 0;
        }
        return str::DupTemp(StrL("saved"));
    }
    if (str::Eq(action, StrL("cancel"))) {
        wnd->OnCancel();
        if (exitCodeOut) {
            *exitCodeOut = 0;
        }
        return str::DupTemp(StrL("canceled"));
    }
    return str::DupTemp(StrL("unknown action"));
}
