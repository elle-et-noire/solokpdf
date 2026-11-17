/* Copyright 2024 the SumatraPDF project authors (see AUTHORS file).
   License: Simplified BSD */

#include "base/Base.h"

#if OS_WIN

#include <csignal>
#include <exception> // set_terminate
#include <intrin.h>  // _ReturnAddress
#include <new.h>     // _set_new_handler

#include "base/WinDynCalls.h"
#include "base/DbgHelpDyn.h"
#include "base/File.h"
#include "base/Http.h"
#include "base/Win.h"
#include "base/CrashHandler.h"

/* Note: we cannot use standard malloc()/free()/new()/delete() in crash handler.
For multi-thread safety, there is a per-heap lock taken by HeapAlloc() etc.
It's possible that a crash originates from  inside such functions after a lock
has been taken. If we then try to allocate memory from the same heap, we'll
deadlock and won't send crash report.
For that reason we create a heap used only for crash handler and must only
allocate, directly or indirectly, from that heap.
I'm not sure what happens if a Windows function (e.g. http calls) has to
allocate memory. I assume it'll use GetProcessHeap() heap and further assume
that CRT creates its own heap for malloc()/free() etc. so that while a deadlock
is still possible, the probability should be greatly reduced. */

static Arena* gCrashHandlerArena = nullptr;

// everything app-specific, handed to us by InstallCrashHandler()
static CrashHandlerConfig gCfg{};

Arena* CrashHandlerArena() {
    return gCrashHandlerArena;
}

static void CallCb(void (*cb)()) {
    if (cb) {
        cb();
    }
}

// The report is built here rather than threaded through every helper as a
// str::Builder&. Lives in the arena so there is no static ctor/dtor.
static str::Builder* gCrashInfo = nullptr;

static void CrashInfoAppend(Str s) {
    if (!gCrashInfo) {
        return;
    }
    gCrashInfo->Append(s);
}

// start a fresh report, keeping the storage already allocated
static void CrashInfoStart(int cap) {
    if (!gCrashInfo) {
        return;
    }
    gCrashInfo->Reset();
    gCrashInfo->Reserve(cap);
}

static Str CrashInfoTake() {
    if (!gCrashInfo) {
        return {};
    }
    return gCrashInfo->TakeStr();
}

// exit code for a debug report (ReportIf) in a -for-testing run; test runners
// (tests/control.ts) treat it as "assertion fired", so keep the value in sync
constexpr UINT kDebugReportTestExitCode = 105;

// Note: intentionally not using ScopedMem<> to avoid
// static initializers/destructors, which are bad
static Str gSystemInfo;
static HANDLE gDumpEvent = nullptr;
// set by the dump thread when the report is done: its exit would wait for the loader
static HANDLE gReportDoneEvent = nullptr;
// set by the dump thread once prepareCrashInfo ran and the dump helper started
static HANDLE gReadyEvent = nullptr;
constexpr DWORD kReadyTimeoutMs = 10 * 1000;
static ThreadHandle gDumpThread = nullptr;
static bool gCrashed = false;
static AtomicBool gCrashHandlerStarted = 0;
static ThreadId gCrashThreadId = 0;
static ThreadId gDumpThreadId = 0;

static MINIDUMP_EXCEPTION_INFORMATION gMei{};
// read from fullDumpEnvVar at install: GetEnvironmentVariableA() allocates
static bool gFullDump = false;
static LPTOP_LEVEL_EXCEPTION_FILTER gPrevExceptionFilter = nullptr;
// kept so UninstallCrashHandler() can remove the handler: it reads globals
// that uninstall tears down
static PVOID gVectoredHandler = nullptr;

static bool TryStartCrashHandling(Str handlerName) {
    if (!AtomicBoolSwap(&gCrashHandlerStarted, true)) {
        gCrashThreadId = GetCurrentThreadId();
        CallCb(gCfg.onCrashBegin);
        return true;
    }

    OutputDebugStringA(CStrTemp(handlerName));
    OutputDebugStringA(": ignoring nested crash\n");

    ThreadId threadId = GetCurrentThreadId();
    if (threadId == gCrashThreadId || threadId == gDumpThreadId) {
        TerminateProcess(GetCurrentProcess(), 1);
    }

    if (gDumpThread) {
        WaitForSingleObject(gDumpThread, INFINITE);
    }

    // The first crash handler will show the crash message and terminate the process.
    Sleep(INFINITE);
    return false;
}

static void WriteCrashInfoToStdErr(Str d) {
    if (len(d) == 0) {
        return;
    }
    HANDLE h = GetStdHandle(STD_ERROR_HANDLE);
    if (!h || h == INVALID_HANDLE_VALUE) {
        return;
    }
    DWORD written = 0;
    WriteFile(h, (u8*)d.s, (DWORD)d.len, &written, nullptr);
}

// path of the .dmp the report being built goes to, see BuildCrashComment()
static Str gDumpPath;

// crashDumpPath with "-<unix epoch in minutes>" before the extension, so a
// dump doesn't overwrite earlier ones: sumatrapdfcrash-29871234.dmp. A second
// dump in the same minute gets "-2" and so on.
static Str UniqueDumpPath() {
    Arena* a = gCrashHandlerArena;
    Str path = gCfg.crashDumpPath;
    Str ext = path::GetExtTemp(path);
    Str base = Str(path.s, len(path) - len(ext));
    i64 minutes = UnixTimeMsNow() / (60 * 1000);
    Str res = str::Format(a, "%s-%d%s", base, minutes, ext);
    for (int i = 2; i < 100 && file::Exists(res); i++) {
        res = str::Format(a, "%s-%d-%d%s", base, minutes, i, ext);
    }
    return res;
}

Str CrashHandlerDumpPath() {
    return gDumpPath;
}

static bool InitializeDbgHelp();

// The report text is the app's to write; we only say when and give it the
// arena to write into. Every report builds its text before writing its .dmp,
// so this is where the .dmp gets its name: the text can then say where it is.
static Str BuildCrashComment(Str condStr, Str fileLine, bool isCrash) {
    if (gReadyEvent) {
        WaitForSingleObject(gReadyEvent, kReadyTimeoutMs);
    }
    gDumpPath = UniqueDumpPath();
    if (!gCfg.getCrashComment) {
        return {};
    }
    if (!isCrash) {
        InitializeDbgHelp();
    }
    return gCfg.getCrashComment(gCrashHandlerArena, condStr, fileLine, isCrash);
}

/*
MiniDumpWriteDump() on our own process suspends every other thread and then
needs the loader, so a thread suspended inside the loader deadlocks it. Starting
a process at crash time isn't safe either: CreateProcess() waits for the loader
and the process heap. So the handler starts a helper process (our exe with
-crash-dump-helper) at install, and a crash only fills gDumpRequest and signals:

  app (crashing)                          helper (RunCrashDumpHelper)
  gDumpRequest = {thread, exception, ...}
  SetEvent(request)  -------------------> ReadProcessMemory(app, gDumpRequest)
  wait: done, helper gone or timeout      MiniDumpWriteDump(app, ClientPointers)
                     <------------------- SetEvent(done)
*/

// what the helper reads from our memory; pointers are our addresses
struct DumpRequest {
    u64 exceptionPointers; // EXCEPTION_POINTERS*, 0 for none
    u64 path;              // utf-8, gDumpPath
    u64 comment;           // utf-8, the comment stream
    u32 pathLen;
    u32 commentLen;
    u32 threadId;
    u32 fullDump;
};

constexpr DWORD kHelperAppAccess = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE | SYNCHRONIZE;
// a full dump of a large process takes seconds; past this we give up on it
constexpr DWORD kDumpTimeoutMs = 30 * 1000;
constexpr u32 kMaxRequestStrLen = 256 * 1024 * 1024;

static DumpRequest gDumpRequest{};
static HANDLE gHelperProcess = nullptr;
static HANDLE gHelperRequestEvent = nullptr;
static HANDLE gHelperDoneEvent = nullptr;
// one request at a time: a crash can come while an ended thread's dump is written
static HANDLE gHelperLock = nullptr;
// set once the helper missed a request: a late "done" would answer the next one
static AtomicBool gHelperFailed = 0;

// Has the helper write the .dmp at gDumpPath. Only our memory, events and a
// mutex: no heap, no loader. False if there is no helper or it didn't finish.
static bool WriteDumpViaHelper(Str comment, MINIDUMP_EXCEPTION_INFORMATION* mei) {
    if (!gHelperProcess || AtomicBoolGet(&gHelperFailed)) {
        log(StrL("WriteDumpViaHelper: no helper\n"));
        return false;
    }
    DWORD res = WaitForSingleObject(gHelperLock, kDumpTimeoutMs);
    if (res != WAIT_OBJECT_0 && res != WAIT_ABANDONED) {
        log(StrL("WriteDumpViaHelper: another dump is taking too long\n"));
        return false;
    }

    gDumpRequest.exceptionPointers = mei ? (u64)(uintptr_t)mei->ExceptionPointers : 0;
    gDumpRequest.threadId = mei ? mei->ThreadId : 0;
    gDumpRequest.path = (u64)(uintptr_t)gDumpPath.s;
    gDumpRequest.pathLen = (u32)len(gDumpPath);
    gDumpRequest.comment = (u64)(uintptr_t)comment.s;
    gDumpRequest.commentLen = (u32)len(comment);
    gDumpRequest.fullDump = gFullDump ? 1 : 0;
    SetEvent(gHelperRequestEvent);

    HANDLE waits[2] = {gHelperDoneEvent, gHelperProcess};
    res = WaitForMultipleObjects(dimof(waits), waits, FALSE, kDumpTimeoutMs);
    bool ok = res == WAIT_OBJECT_0;
    if (!ok) {
        AtomicBoolSet(&gHelperFailed, true);
        logf("WriteDumpViaHelper: helper failed, wait result %u\n", (uint)res);
    }
    ReleaseMutex(gHelperLock);
    return ok;
}

// Writes the .dmp with logText attached as its comment stream, then uploads it
// if shouldUpload. Writing it is unconditional: a local .dmp is useful even in
// a build that must not send anything.
static void WriteAndUploadMinidump(Str logText, MINIDUMP_EXCEPTION_INFORMATION* mei, bool shouldUpload) {
    if (len(gDumpPath) == 0) {
        gDumpPath = UniqueDumpPath();
    }
    if (!WriteDumpViaHelper(logText, mei)) {
        return;
    }

    if (!shouldUpload) {
        log(StrL("WriteAndUploadMinidump: skipping upload, !shouldUpload\n"));
        return;
    }
    if (IsDebuggerPresent()) {
        log(StrL("WriteAndUploadMinidump: skipping upload, debugger present\n"));
        return;
    }
    if (len(gCfg.submitUrl) == 0) {
        log(StrL("WriteAndUploadMinidump: skipping upload, no submit url\n"));
        return;
    }

    Str dump = file::ReadFileWithArena(gDumpPath, gCrashHandlerArena);
    if (len(dump) == 0) {
        log(StrL("WriteAndUploadMinidump: empty dump, not uploading\n"));
        return;
    }

    HttpRsp rsp;
    bool ok = HttpPostUrl(gCfg.submitUrl, StrL("application/octet-stream"), {}, dump, &rsp);
    logf("WriteAndUploadMinidump: upload ok=%d status=%u err=%u bytes=%d url=%s\n", (int)ok,
         (unsigned)rsp.httpStatusCode, (unsigned)rsp.error, dump.len, gCfg.submitUrl);
}

static void HandleCrashWithMinidump() {
    log(StrL("HandleCrashWithMinidump\n"));

    // localOnly is a run that must not talk to the network (tests, control pipe)
    bool shouldUpload = gCfg.uploadCrashes && !gCfg.localOnly;
    Str logText = BuildCrashComment(Str(), StrL(""), true);
    WriteCrashInfoToStdErr(logText);
    WriteAndUploadMinidump(logText, &gMei, shouldUpload);
}

// Symbols are only ever the .pdb sitting next to the .exe (a local build); we
// no longer download them, released crashes are symbolized from the minidump.
static bool InitializeDbgHelp() {
    TempStr symPath = GetSelfExeDirTemp();
    TempWStr ws = ToWStrTemp(symPath);
    if (!dbghelp::Initialize(ws, false)) {
        logf("InitializeDbgHelp: dbghelp::Initialize('%s') failed\n", symPath);
        return false;
    }

    if (!dbghelp::HasSymbols()) {
        logf("InitializeDbgHelp(): dbghelp::HasSymbols(), symPath: '%s' failed\n", symPath);
        return false;
    }
    logf("InitializeDbgHelp(): did initialize ok, symPath: '%s'\n", symPath);
    return true;
}

/* A debug report has no exception, so without help the .dmp gets no exception
   stream: no .ecxr, no "interesting" thread (the debugger falls back to thread
   0), and every report buckets the same. So we synthesize one. */

// Customer-defined code (bit 29 set), so it can't collide with a system one.
constexpr DWORD kDebugReportExceptionCode = 0xE0444247; // 'DBGR'

// Read by the helper from our memory. Static so that writing a report
// allocates nothing.
static EXCEPTION_RECORD gDebugReportExcRec{};
static CONTEXT gDebugReportCtx{};
static EXCEPTION_POINTERS gDebugReportExcPtrs{};
static MINIDUMP_EXCEPTION_INFORMATION gDebugReportMei{};

// Writes and uploads the debug report .dmp with this thread, here, as its
// exception. The captured context stays valid: we wait in deeper frames while
// the helper writes the dump.
// ExceptionAddress is the ReportIf() site rather than the context's ip, so .exr
// names the assert. !analyze still buckets on the stack top, i.e. here, so the
// Cond: line in the comment stream is what tells reports apart.
static NO_INLINE void WriteAndUploadDebugReportMinidump(Str logText, bool shouldUpload, void* exceptionAddr) {
    RtlCaptureContext(&gDebugReportCtx);
    gDebugReportExcRec.ExceptionCode = kDebugReportExceptionCode;
    gDebugReportExcRec.ExceptionAddress = exceptionAddr;
    gDebugReportExcPtrs.ExceptionRecord = &gDebugReportExcRec;
    gDebugReportExcPtrs.ContextRecord = &gDebugReportCtx;
    gDebugReportMei.ThreadId = GetCurrentThreadId();
    gDebugReportMei.ExceptionPointers = &gDebugReportExcPtrs;
    WriteAndUploadMinidump(logText, &gDebugReportMei, shouldUpload);
}

// like crash report, but can be triggered without a crash
// NO_INLINE because _ReturnAddress() below must be our caller, i.e. the
// ReportIf() that fired
NO_INLINE void _uploadDebugReport(Str condStr, Str fileLine, bool isCrash) {
    // in release builds ReportIf() will break if running under
    // the debugger. In other builds it sends a debug report
    if (condStr) {
        logf("_uploadDebugReport: %s %s\n", condStr, fileLine);
    } else {
        log(StrL("_uploadDebugReport\n"));
    }

    bool shouldUpload = isCrash ? gCfg.uploadCrashes : gCfg.uploadDebugReports;

    if (gCfg.localOnly) {
        auto s = BuildCrashComment(condStr, fileLine, isCrash);
        if (len(s) == 0) {
            log(StrL("_uploadDebugReport(): skipping because !BuildCrashComment()\n"));
            return;
        }
        WriteCrashInfoToStdErr(s);
        log(s);
        log(StrL("_uploadDebugReport() finished local-only\n"));
        if (gCfg.forTesting && !isCrash && !IsDebuggerPresent()) {
            // automated tests must fail on debug reports (crashes already
            // kill the process with a non-zero code on their own)
            log(StrL("_uploadDebugReport(): -for-testing, terminating with exit code 105\n"));
            ::TerminateProcess(GetCurrentProcess(), kDebugReportTestExitCode);
        }
        return;
    }

    if (!shouldUpload) {
        if (IsDebuggerPresent()) {
            DebugBreak();
        } else {
            auto s = BuildCrashComment(condStr, fileLine, isCrash);
            if (len(s) == 0) {
                log(StrL("_uploadDebugReport(): skipping because !BuildCrashComment()\n"));
                return;
            }
            log(s);
        }
        log(StrL("_uploadDebugReport skipping because !shouldUpload\n"));
        return;
    }

    // we want to avoid submitting multiple reports for the same
    // condition. I'm too lazy to implement tracking this granularly
    // so only allow once submission in a given session
    static bool didSubmitDebugReport = false;

    // don't send report if this is me debugging
    if (IsDebuggerPresent()) {
        log(StrL("_uploadDebugReport skipping because IsDebuggerPresent\n"));
        DebugBreak();
        return;
    }

    if (didSubmitDebugReport) {
        return;
    }
    didSubmitDebugReport = true;

    logf("_uploadDebugReport: isCrash: %d\n", (int)isCrash);

    Str logText = BuildCrashComment(condStr, fileLine, isCrash);
    WriteAndUploadDebugReportMinidump(logText, shouldUpload, _ReturnAddress());
    log(logText);
    log(StrL("_uploadDebugReport() finished\n"));
}

static void StartDumpHelper();

static DWORD WINAPI CrashDumpThread(LPVOID /*data*/) {
    // off the UI thread: the app's crash info, the dump helper (~30 ms to start)
    // and SymInitialize, which walks every loaded module (~45 ms). A crash
    // signaled meanwhile waits for it, dbghelp::Initialize serializes
    CallCb(gCfg.prepareCrashInfo);
    StartDumpHelper();
    SetEvent(gReadyEvent);
    InitializeDbgHelp();
    WaitForSingleObject(gDumpEvent, INFINITE);
    if (!gCrashed) {
        return 0;
    }

    log(StrL("CrashDumpThread\n"));
    HandleCrashWithMinidump();
    SetEvent(gReportDoneEvent);
    return 0;
}

// This is needed to intercept memory corruption reports from windows heap manager
// https://peteronprogramming.wordpress.com/2017/07/30/crashes-you-cant-handle-easily-3-status_heap_corruption-on-windows/
// https://phabricator.services.mozilla.com/D83753
// reports on the dump thread, shows the crash message and exits
static LONG HandleCrash(EXCEPTION_POINTERS* exceptionInfo, Str who) {
    logf("%s\n", who);
    gCrashed = true;

    gMei.ThreadId = GetCurrentThreadId();
    gMei.ExceptionPointers = exceptionInfo;
    if (GetCurrentThreadId() == gDumpThreadId) {
        // crashed while preparing: no other thread to report for us, and
        // nothing more gets ready
        SetEvent(gReadyEvent);
        HandleCrashWithMinidump();
    } else {
        // the dump thread has a whole stack; a stack overflow leaves this one little
        SetEvent(gDumpEvent);
        WaitForSingleObject(gReportDoneEvent, INFINITE);
    }

    if (!gCfg.localOnly) {
        CallCb(gCfg.showCrashMessage);
    }
    TerminateProcess(GetCurrentProcess(), 1);
    return EXCEPTION_CONTINUE_SEARCH;
}

static LONG WINAPI CrashDumpVectoredExceptionHandler(EXCEPTION_POINTERS* exceptionInfo) {
    if (exceptionInfo->ExceptionRecord->ExceptionCode != STATUS_HEAP_CORRUPTION) {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    if (!TryStartCrashHandling(StrL("CrashDumpVectoredExceptionHandler"))) {
        return EXCEPTION_CONTINUE_SEARCH; // Note: or should TerminateProcess()?
    }

    return HandleCrash(exceptionInfo, StrL("CrashDumpVectoredExceptionHandler"));
}

// there is no documented Win32 API for a thread's start address
static void* CurrentThreadStartAddr() {
    using NtQueryInfoThreadFn = LONG(WINAPI*)(HANDLE, int, void*, ULONG, ULONG*);
    constexpr int kThreadQuerySetWin32StartAddress = 9;
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto queryInfo =
        ntdll ? reinterpret_cast<NtQueryInfoThreadFn>(GetProcAddress(ntdll, "NtQueryInformationThread")) : nullptr;
    if (!queryInfo) {
        return nullptr;
    }
    void* addr = nullptr;
    LONG status = queryInfo(GetCurrentThread(), kThreadQuerySetWin32StartAddress, (void*)&addr, sizeof(addr), nullptr);
    return status >= 0 ? addr : nullptr;
}

static HMODULE ModuleFromAddr(void* addr) {
    HMODULE mod = nullptr;
    DWORD flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
    GetModuleHandleExW(flags, (LPCWSTR)addr, &mod);
    return mod;
}

// our threads and thread pool workers (they run our callbacks) must not be ended
static bool IsForeignThread() {
    HMODULE mod = ModuleFromAddr(CurrentThreadStartAddr());
    if (!mod) {
        return false;
    }
    return mod != GetModuleHandleW(nullptr) && mod != GetModuleHandleW(L"ntdll.dll");
}

static AtomicBool gEndedCrashedThread = 0;

// A third-party DLL (e.g. a SAPI voice engine) crashed on a thread it started:
// report it, then end only that thread. Once per session; a repeat crashes.
static void MaybeEndCrashedThread(EXCEPTION_POINTERS* exceptionInfo) {
    if (!gCfg.canEndCrashedThread || !IsForeignThread()) {
        return;
    }
    if (!gCfg.canEndCrashedThread(exceptionInfo->ExceptionRecord->ExceptionAddress)) {
        return;
    }
    if (AtomicBoolSwap(&gEndedCrashedThread, true)) {
        return;
    }

    log(StrL("MaybeEndCrashedThread: ending crashed thread\n"));
    MINIDUMP_EXCEPTION_INFORMATION mei{};
    mei.ThreadId = GetCurrentThreadId();
    mei.ExceptionPointers = exceptionInfo;
    Str logText = BuildCrashComment(StrL("crashed thread ended, process kept running"), StrL(""), true);
    WriteCrashInfoToStdErr(logText);
    bool shouldUpload = gCfg.uploadCrashes && !gCfg.localOnly;
    WriteAndUploadMinidump(logText, &mei, shouldUpload);

    CallCb(gCfg.onCrashedThreadEnded);
    ExitThread(1);
}

static LONG WINAPI CrashDumpExceptionHandler(EXCEPTION_POINTERS* exceptionInfo) {
    if (!exceptionInfo || (EXCEPTION_BREAKPOINT == exceptionInfo->ExceptionRecord->ExceptionCode)) {
        log(
            StrL("CrashDumpExceptionHandler: exiting because !exceptionInfo || EXCEPTION_BREAKPOINT == "
                 "exceptionInfo->ExceptionRecord->ExceptionCode\n"));
        return EXCEPTION_CONTINUE_SEARCH;
    }

    MaybeEndCrashedThread(exceptionInfo);

    if (!TryStartCrashHandling(StrL("CrashDumpExceptionHandler"))) {
        return EXCEPTION_CONTINUE_SEARCH; // Note: or should TerminateProcess()?
    }

    return HandleCrash(exceptionInfo, StrL("CrashDumpExceptionHandler"));
}

static void GetOsVersion() {
    OSVERSIONINFOEX ver{};
    bool ok = GetOsVersion(ver);
    ver.dwOSVersionInfoSize = sizeof(ver);
    if (!ok) {
        return;
    }

    TempStr os = OsNameFromVerTemp(ver);
    int servicePackMajor = ver.wServicePackMajor;
    int servicePackMinor = ver.wServicePackMinor;
    int buildNumber = (int)ver.dwBuildNumber & 0xFFFF;
    const auto* arch = "64-bit";
    if (IsProcess32()) {
        arch = IsRunningInWow64() ? "Wow64" : "32-bit";
    }
    TempStr sp = StrL("");
    if (servicePackMajor != 0) {
        sp = servicePackMinor == 0 ? fmt(" SP%d", servicePackMajor) : fmt(" %d.%d", servicePackMajor, servicePackMinor);
    }
    CrashInfoAppend(fmt("OS: Windows %s%s build %d %s\n", os, sp, buildNumber, Str(arch)));
}

static void GetProcessorName() {
    const auto* key = R"(HARDWARE\DESCRIPTION\System\CentralProcessor)";
    TempStr name = ReadRegStrTemp(HKEY_LOCAL_MACHINE, Str(key), StrL("ProcessorNameString"));
    if (len(name) == 0) {
        // if more than one processor
        key = R"(HARDWARE\DESCRIPTION\System\CentralProcessor\0)";
        name = ReadRegStrTemp(HKEY_LOCAL_MACHINE, Str(key), StrL("ProcessorNameString"));
    }
    if (name) {
        CrashInfoAppend(fmt("Processor: %s\n", name));
    }
}

#define kGfxDriverKeyPrefix "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\"

static void GetGraphicsDriverInfo() {
    // the info is in registry in:
    // HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000\
    //   Device Description REG_SZ (same as DriverDesc, so we don't read it)
    //   DriverDesc REG_SZ
    //   DriverVersion REG_SZ
    //   UserModeDriverName REG_MULTI_SZ
    //
    // There can be more than one driver, they are in 0000, 0001 etc.
    for (int i = 0;; i++) {
        TempStr key = str::JoinTemp(StrL(kGfxDriverKeyPrefix), fmt("%04d", i));
        TempStr v = ReadRegStrTemp(HKEY_LOCAL_MACHINE, key, StrL("DriverDesc"));
        // I assume that if I can't read the value, there are no more drivers
        if (len(v) == 0) {
            break;
        }
        CrashInfoAppend(fmt("Graphics driver %d\n", i));
        CrashInfoAppend(fmt("  DriverDesc:         %s\n", v));

        v = ReadRegStrTemp(HKEY_LOCAL_MACHINE, key, StrL("DriverVersion"));
        if (v) {
            CrashInfoAppend(fmt("  DriverVersion:      %s\n", v));
        }

        v = ReadRegStrTemp(HKEY_LOCAL_MACHINE, key, StrL("UserModeDriverName"));
        if (v) {
            CrashInfoAppend(fmt("  UserModeDriverName: %s\n", v));
        }
    }
}

static void GetSystemInfo() {
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    CrashInfoAppend(fmt("Number Of Processors: %d\n", si.dwNumberOfProcessors));
    GetProcessorName();

    {
        MEMORYSTATUSEX ms;
        ms.dwLength = sizeof(ms);
        GlobalMemoryStatusEx(&ms);

        float physMemGB = (float)ms.ullTotalPhys / (float)(1024 * 1024 * 1024);
        float totalPageGB = (float)ms.ullTotalPageFile / (float)(1024 * 1024 * 1024);
        DWORD usedPerc = ms.dwMemoryLoad;
        CrashInfoAppend(fmt("Physical Memory: %.2f GB\nCommit Charge Limit: %.2f GB\nMemory Used: %d%%\n", physMemGB,
                            totalPageGB, usedPerc));
    }
    {
        // get computer name
        TempStr s1 =
            ReadRegStrTemp(HKEY_LOCAL_MACHINE, StrL(R"(HARDWARE\DESCRIPTION\System\BIOS)"), StrL("SystemFamily"));
        TempStr s2 =
            ReadRegStrTemp(HKEY_LOCAL_MACHINE, StrL(R"(HARDWARE\DESCRIPTION\System\BIOS)"), StrL("SystemVersion"));

        if (len(s1) == 0 && len(s2) == 0) {
            // no-op
        } else if (len(s1) == 0) {
            CrashInfoAppend(fmt("Machine: %s\n", s2));
        } else if (len(s2) == 0 || str::EqI(s1, s2)) {
            CrashInfoAppend(fmt("Machine: %s\n", s1));
        } else {
            CrashInfoAppend(fmt("Machine: %s %s\n", s1, s2));
        }
    }
    {
        // get language
        char country[32] = {}, lang[32]{};
        GetLocaleInfoA(LOCALE_USER_DEFAULT, LOCALE_SISO3166CTRYNAME, country, dimof(country) - 1);
        GetLocaleInfoA(LOCALE_USER_DEFAULT, LOCALE_SISO639LANGNAME, lang, dimof(lang) - 1);
        CrashInfoAppend(fmt("Lang: %s %s\n", Str(lang), Str(country)));
    }
    GetGraphicsDriverInfo();
    CrashInfoAppend(fmt("CPU: %s\n", CpuFeaturesTemp()));
}

static void BuildSystemInfo() {
    CrashInfoStart(1024);
    GetOsVersion();
    GetSystemInfo();
    gSystemInfo = CrashInfoTake();
}

Str CrashHandlerSystemInfo() {
    return gSystemInfo;
}

static void __cdecl onSignalAbort(int /*sig*/) {
    // put the signal back because can be called many times
    // (from multiple threads) and raise() resets the handler
    signal(SIGABRT, onSignalAbort);
    CrashMe();
}

static void onTerminate() {
    CrashMe();
}

// The CRT calls this when an API is handed something it refuses to work with -
// atof(nullptr), a bad printf format, an out-of-range index in a checked
// iterator... The default handler is _invoke_watson(), which fails the process
// fast without going through SetUnhandledExceptionFilter or the vectored
// handler, so those crashes died silently with no report (#5909). Crash the way
// everything else here does, so the normal machinery walks the stack and sends
// a report. The arguments only carry anything in a debug CRT, so ignore them.
static void __cdecl onInvalidParameter(const wchar_t*, const wchar_t*, const wchar_t*, unsigned int, uintptr_t) {
    CrashMe();
}

// new couldn't get the memory. Without a handler this ends in std::bad_alloc,
// which with _HAS_EXCEPTIONS=0 aborts somewhere down in the CRT; crashing here
// keeps the frame that asked for the memory on the stack, which is the only
// interesting part of an out-of-memory report. Never returns (returning 0 would
// tell new to give up, 1 to retry the allocation).
static int __cdecl onNewFailed(size_t) {
    CrashMe();
    return 0;
}

// shadow crt's _purecall() so that we're called instead of CRT.
// must keep external linkage: that's how it overrides the CRT's definition
int __cdecl _purecall() {
    CrashMe();
    return 0;
}

// Starts the helper process that writes our dumps, see WriteDumpViaHelper().
// It inherits only our process handle and its two events.
static void StartDumpHelper() {
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    gHelperRequestEvent = CreateEventW(&sa, FALSE, FALSE, nullptr);
    gHelperDoneEvent = CreateEventW(&sa, FALSE, FALSE, nullptr);
    gHelperLock = CreateMutexW(nullptr, FALSE, nullptr);
    HANDLE self = nullptr;
    DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(), &self, kHelperAppAccess, TRUE, 0);
    if (!gHelperRequestEvent || !gHelperDoneEvent || !gHelperLock || !self) {
        logf("StartDumpHelper: handles failed, err=%u\n", GetLastError());
        SafeCloseHandle(&self);
        return;
    }

    HANDLE inherit[3] = {self, gHelperRequestEvent, gHelperDoneEvent};
    SIZE_T attrsSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrsSize);
    auto attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)AllocZero(GetTempArena(), attrsSize);
    bool ok = InitializeProcThreadAttributeList(attrs, 1, 0, &attrsSize);
    ok = ok && UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof(inherit), nullptr,
                                         nullptr);

    STARTUPINFOEXW si{};
    si.StartupInfo.cb = sizeof(si);
    // no std handles: a caller waiting for our stdout / stderr to close must not wait for the helper
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.lpAttributeList = attrs;
    TempStr cmd =
        fmt("\"%s\" -crash-dump-helper %lld:%lld:%lld:%lld", GetSelfExePathTemp(), (i64)(uintptr_t)self,
            (i64)(uintptr_t)gHelperRequestEvent, (i64)(uintptr_t)gHelperDoneEvent, (i64)(uintptr_t)&gDumpRequest);
    TempWStr cmdW = ToWStrTemp(cmd);
    PROCESS_INFORMATION pi{};
    DWORD flags = EXTENDED_STARTUPINFO_PRESENT;
    ok = ok && CreateProcessW(nullptr, cmdW.s, nullptr, nullptr, TRUE, flags, nullptr, nullptr, &si.StartupInfo, &pi);
    if (!ok) {
        logf("StartDumpHelper: CreateProcessW failed, err=%u\n", GetLastError());
    }
    DeleteProcThreadAttributeList(attrs);
    CloseHandle(self);
    if (!ok) {
        return;
    }
    CloseHandle(pi.hThread);
    gHelperProcess = pi.hProcess;
}

static void StopDumpHelper() {
    if (gHelperProcess) {
        TerminateProcess(gHelperProcess, 0);
    }
    SafeCloseHandle(&gHelperProcess);
    SafeCloseHandle(&gHelperRequestEvent);
    SafeCloseHandle(&gHelperDoneEvent);
    SafeCloseHandle(&gHelperLock);
    AtomicBoolSet(&gHelperFailed, false);
}

// n bytes at addr in app, from the temp arena; empty if unreadable
static Str ReadAppMemory(HANDLE app, u64 addr, u32 n) {
    if (addr == 0 || n == 0 || n > kMaxRequestStrLen) {
        return {};
    }
    char* d = AllocArray<char>(GetTempArena(), (int)n + 1);
    SIZE_T nRead = 0;
    if (!ReadProcessMemory(app, (void*)(uintptr_t)addr, d, n, &nRead) || nRead != n) {
        return {};
    }
    return Str(d, (int)n);
}

static void WriteRequestedDump(HANDLE app, u64 requestAddr) {
    DumpRequest req{};
    SIZE_T nRead = 0;
    if (!ReadProcessMemory(app, (void*)(uintptr_t)requestAddr, &req, sizeof(req), &nRead) || nRead != sizeof(req)) {
        return;
    }
    Str path = ReadAppMemory(app, req.path, req.pathLen);
    if (len(path) == 0) {
        return;
    }
    Str comment = ReadAppMemory(app, req.comment, req.commentLen);

    MINIDUMP_EXCEPTION_INFORMATION mei{};
    mei.ThreadId = req.threadId;
    mei.ExceptionPointers = (EXCEPTION_POINTERS*)(uintptr_t)req.exceptionPointers;
    // the exception record and context are the app's memory
    mei.ClientPointers = TRUE;
    dir::CreateForFile(path);
    dbghelp::WriteMiniDump(app, ToWStrTemp(path), req.exceptionPointers ? &mei : nullptr, req.fullDump != 0, comment);
}

// The helper process: writes the dumps the app that started it asks for, until
// that app exits. arg is "<app process>:<request event>:<done event>:<request address>".
int RunCrashDumpHelper(Str arg) {
    StrVec parts;
    if (Split(&parts, arg, StrL(":")) != 4) {
        return 1;
    }
    HANDLE app = (HANDLE)(intptr_t)ParseInt64(parts[0]);
    HANDLE request = (HANDLE)(intptr_t)ParseInt64(parts[1]);
    HANDLE done = (HANDLE)(intptr_t)ParseInt64(parts[2]);
    u64 requestAddr = (u64)ParseInt64(parts[3]);

    HANDLE waits[2] = {app, request};
    for (;;) {
        DWORD res = WaitForMultipleObjects(dimof(waits), waits, FALSE, INFINITE);
        if (res != WAIT_OBJECT_0 + 1) {
            return 0;
        }
        WriteRequestedDump(app, requestAddr);
        ResetTempArena();
        SetEvent(done);
    }
}

void InstallCrashHandler(const CrashHandlerConfig& cfg) {
    ReportIf(gDumpEvent || gDumpThread);

    if (len(cfg.crashDumpPath) == 0) {
        log(StrL("InstallCrashHandler: skipping because !crashDumpPath\n"));
        return;
    }

    // we pre-allocate as much as possible to minimize allocations
    // when crash handler is invoked. It's ok to use standard
    // allocation functions here.
    gCrashHandlerArena = ArenaNew();
    gCrashInfo = New<str::Builder>(gCrashHandlerArena, gCrashHandlerArena);

    logf("InstallCrashHandler:\n  crashDumpPath: '%s'\n  submitUrl: '%s'\n", cfg.crashDumpPath, cfg.submitUrl);

    gCfg = cfg;
    // the caller's strings can be temporary, ours must outlive any crash
    gCfg.crashDumpPath = str::Dup(gCrashHandlerArena, cfg.crashDumpPath);
    gCfg.submitUrl = str::Dup(gCrashHandlerArena, cfg.submitUrl);
    gCfg.fullDumpEnvVar = str::Dup(gCrashHandlerArena, cfg.fullDumpEnvVar);
    gFullDump = len(cfg.fullDumpEnvVar) > 0 && GetEnvironmentVariableA(CStrTemp(cfg.fullDumpEnvVar), nullptr, 0) != 0;
    gCrashThreadId = 0;
    gDumpThreadId = 0;
    AtomicBoolSet(&gCrashHandlerStarted, false);

    BuildSystemInfo();
    gDumpEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    gReportDoneEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    gReadyEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    if (!gDumpEvent || !gReportDoneEvent || !gReadyEvent) {
        log(StrL("InstallCrashHandler: skipping because !gDumpEvent\n"));
        return;
    }
    gDumpThread = CreateThread(nullptr, 0, CrashDumpThread, nullptr, 0, &gDumpThreadId);
    if (!gDumpThread) {
        log(StrL("InstallCrashHandler: skipping because !gDumpThread\n"));
        return;
    }
    gPrevExceptionFilter = SetUnhandledExceptionFilter(CrashDumpExceptionHandler);
    // 1 means that our handler will be called first, 0 would be: last
    gVectoredHandler = AddVectoredExceptionHandler(1, CrashDumpVectoredExceptionHandler);

    // Note: a fail-fast (__fastfail / RtlFailFast, i.e. 0xC0000409) gets us
    // nothing at all - not this filter, not the vectored handler, not even the
    // stderr report - because the kernel kills the process without dispatching
    // an exception. That's deliberate, so that corrupted state can't intercept
    // its own death, and it's what a /GS cookie or CFG failure uses. The only
    // backstop is WER LocalDumps, which is per-machine and needs admin, so
    // there is nothing to fix here. The CRT's own fail-fast paths (abort(),
    // invalid parameter, pure call) are routed into CrashMe() below instead.

    signal(SIGABRT, onSignalAbort);
#if COMPILER_MSVC
    // must be the global one: threads that never call the thread-local setter
    // (i.e. all of ours) fall back to it
    _set_invalid_parameter_handler(onInvalidParameter);
    _set_new_handler(onNewFailed);
    // deliberately not _set_new_mode(1): that would route failed malloc() to the
    // new handler too, and plenty of code here checks malloc for null and
    // recovers instead of dying
    //
    // abort() runs the SIGABRT handler above, which crashes and reports. Take
    // the CRT's own reactions out of the way: _CALL_REPORTFAULT would hand the
    // process to WER, _WRITE_ABORT_MSG prints a message no user of a GUI app
    // ever sees
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    std::set_terminate(onTerminate);
#endif
}

void UninstallCrashHandler() {
    if (!gDumpEvent || !gDumpThread) {
        return;
    }

    if (gPrevExceptionFilter) {
        SetUnhandledExceptionFilter(gPrevExceptionFilter);
    }
    // must go before we close the handles it waits on: left registered, it
    // would run on a heap corruption during shutdown and SetEvent() / wait on
    // closed handles, whose values may since have been recycled
    if (gVectoredHandler) {
        RemoveVectoredExceptionHandler(gVectoredHandler);
        gVectoredHandler = nullptr;
    }

    SetEvent(gDumpEvent);
    WaitForSingleObject(gDumpThread, 1000); // 1 sec

    SafeCloseThreadHandle(&gDumpThread);
    CloseHandle(gDumpEvent);
    SafeCloseHandle(&gReportDoneEvent);
    SafeCloseHandle(&gReadyEvent);
    StopDumpHelper();
    // InstallCrashHandler() asserts on both being null, so don't leave a stale
    // handle value behind
    gDumpEvent = nullptr;

    // those are allocated from gCrashHandlerArena so are freed by ArenaDelete()
    gSystemInfo = {};
    gCfg = {};
    ArenaDelete(gCrashHandlerArena);
    gCrashInfo = nullptr;
    gCrashHandlerArena = nullptr;
    gCrashThreadId = 0;
    gDumpThreadId = 0;
    AtomicBoolSet(&gCrashHandlerStarted, false);
}

#endif // OS_WIN
