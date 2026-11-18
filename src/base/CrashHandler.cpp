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
static HANDLE gHelperReadyEvent = nullptr;
// set by the dump thread once prepareCrashInfo ran
static HANDLE gReadyEvent = nullptr;
constexpr DWORD kReadyTimeoutMs = 10 * 1000;
constexpr DWORD kReportTimeoutMs = 8 * 1000;
static ThreadHandle gDumpThread = nullptr;
enum CrashState {
    Stopped,
    Idle,
    Handling
};
static AtomicInt gCrashState = Stopped;
static AtomicInt gCrashThreadId = 0;
static ThreadId gDumpThreadId = 0;

static MINIDUMP_EXCEPTION_INFORMATION gMei{};
struct CrashPath {
    Str path;
    WStr wide;
    WStr fallbackTemp;
};
static CrashPath gCrashPaths[2]; // a recovered voice engine crash can precede a fatal one
static unsigned gCrashCount = 0;
static CrashPath* gCrashPath = nullptr;
static MINIDUMP_SYSTEM_INFO gDumpSystemInfo{};
static bool gRawDumpWritten = false;
static bool gMayRecover = false;
static bool gRecovered = false;
static ULONGLONG gReportDeadline = 0;
static HMODULE gExeModule = nullptr;
static HMODULE gNtdllModule = nullptr;
// read from fullDumpEnvVar at install: GetEnvironmentVariableA() allocates
static bool gFullDump = false;
enum class CrashTestMode {
    Normal,
    ReportStop,
    HeapLock,
    NoHelper,
    HelperStop,
};
static CrashTestMode gCrashTestMode = CrashTestMode::Normal;
static HANDLE gCrashTestHeap = nullptr;
static LPTOP_LEVEL_EXCEPTION_FILTER gPrevExceptionFilter = nullptr;
static bool gExceptionFilterInstalled = false;
// kept so UninstallCrashHandler() can remove the handler: it reads globals
// that uninstall tears down
static PVOID gVectoredHandler = nullptr;

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
static thread_local Str gDumpPath;

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

// ReportIf can select a path here. Fatal crashes use a preallocated path.
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

enum class DumpKind : u32 {
    DebugReport,
    Crash,
    TestHelperStop
};

// what the helper reads from our memory; pointers are our addresses
struct DumpRequest {
    u64 exceptionPointers; // EXCEPTION_POINTERS*, 0 for none
    u64 path;              // utf-8, gDumpPath
    u64 comment;           // utf-8, the comment stream
    ULONGLONG deadline;
    u32 pathLen;
    u32 commentLen;
    u32 threadId;
    u32 fullDump;
    DumpKind kind;
};

struct DumpHelperEvents {
    u64 request;
    u64 done;
};

constexpr DWORD kHelperAppAccess =
    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE | PROCESS_TERMINATE | SYNCHRONIZE;
// a full dump of a large process takes seconds; past this we give up on it
constexpr DWORD kDumpTimeoutMs = 30 * 1000;
constexpr u32 kMaxRequestStrLen = 256 * 1024 * 1024;

static DumpRequest gDumpRequest{};
static DumpHelperEvents gRemoteEvents{};
static HANDLE gHelperProcess = nullptr;
static HANDLE gHelperRequestEvent = nullptr;
static HANDLE gHelperDoneEvent = nullptr;
// one request at a time: a crash can come while an ended thread's dump is written
static HANDLE gHelperLock = nullptr;
// set once the helper missed a request: a late "done" would answer the next one
static AtomicBool gHelperFailed = 0;

static DWORD TimeLeft(ULONGLONG deadline) {
    ULONGLONG now = GetTickCount64();
    if (now >= deadline) {
        return 0;
    }
    ULONGLONG remaining = deadline - now;
    return remaining > kDumpTimeoutMs ? kDumpTimeoutMs : (DWORD)remaining;
}

// Has the helper write the .dmp at gDumpPath. Only our memory, events and a
// mutex: no heap, no loader. False if there is no helper or it didn't finish.
static bool WriteDumpViaHelper(Str path, Str comment, const MINIDUMP_EXCEPTION_INFORMATION* mei, DumpKind kind,
                               ULONGLONG deadline) {
    if (!gHelperProcess || AtomicBoolGet(&gHelperFailed)) {
        return false;
    }
    DWORD res = WaitForSingleObject(gHelperLock, TimeLeft(deadline));
    if (res != WAIT_OBJECT_0 && res != WAIT_ABANDONED) {
        return false;
    }

    if (AtomicBoolGet(&gHelperFailed) || TimeLeft(deadline) == 0) {
        ReleaseMutex(gHelperLock);
        return false;
    }

    gDumpRequest.exceptionPointers = mei ? (u64)(uintptr_t)mei->ExceptionPointers : 0;
    gDumpRequest.threadId = mei ? mei->ThreadId : 0;
    gDumpRequest.path = (u64)(uintptr_t)path.s;
    gDumpRequest.pathLen = (u32)len(path);
    gDumpRequest.comment = (u64)(uintptr_t)comment.s;
    gDumpRequest.commentLen = (u32)len(comment);
    gDumpRequest.fullDump = gFullDump ? 1 : 0;
    gDumpRequest.kind = kind;
    gDumpRequest.deadline = deadline;
    SetEvent(gHelperRequestEvent);

    HANDLE waits[2] = {gHelperDoneEvent, gHelperProcess};
    res = WaitForMultipleObjects(dimof(waits), waits, FALSE, TimeLeft(deadline));
    bool ok = res == WAIT_OBJECT_0;
    if (!ok) {
        AtomicBoolSet(&gHelperFailed, true);
    }
    ReleaseMutex(gHelperLock);
    return ok;
}

static void UploadMinidump(bool shouldUpload) {
    if (!shouldUpload) {
        log(StrL("UploadMinidump: skipping upload, !shouldUpload\n"));
        return;
    }
    if (IsDebuggerPresent()) {
        log(StrL("UploadMinidump: skipping upload, debugger present\n"));
        return;
    }
    if (len(gCfg.submitUrl) == 0) {
        log(StrL("UploadMinidump: skipping upload, no submit url\n"));
        return;
    }

    Str dump = file::ReadFileWithArena(gDumpPath, gCrashHandlerArena);
    if (len(dump) == 0) {
        log(StrL("UploadMinidump: empty dump, not uploading\n"));
        return;
    }

    HttpRsp rsp;
    bool ok = HttpPostUrl(gCfg.submitUrl, StrL("application/octet-stream"), {}, dump, &rsp);
    logf("UploadMinidump: ok=%d status=%u err=%u bytes=%d url=%s\n", (int)ok, (unsigned)rsp.httpStatusCode,
         (unsigned)rsp.error, dump.len, gCfg.submitUrl);
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
    if (WriteDumpViaHelper(gDumpPath, logText, &gDebugReportMei, DumpKind::DebugReport,
                           GetTickCount64() + kDumpTimeoutMs)) {
        UploadMinidump(shouldUpload);
    }
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
static bool CanEndCrashedThread();

static bool WriteDumpFile(HANDLE process, Str path, MINIDUMP_EXCEPTION_INFORMATION* mei, bool fullDump, Str comment) {
    dir::CreateForFile(path);
    TempWStr stage = ToWStrTemp(fmt("%s-%u.tmp", path, GetCurrentProcessId()));
    bool ok = dbghelp::WriteMiniDump(process, stage, mei, fullDump, comment);
    if (ok) {
        DWORD flags = MOVEFILE_WRITE_THROUGH | (comment ? MOVEFILE_REPLACE_EXISTING : 0);
        ok = MoveFileExW(stage.s, ToWStrTemp(path).s, flags);
    }
    if (!ok) {
        DeleteFileW(stage.s);
    }
    return ok;
}

struct FallbackDump {
    struct ThreadList {
        ULONG32 count;
        MINIDUMP_THREAD thread;
    };
    MINIDUMP_HEADER header;
    MINIDUMP_DIRECTORY streams[4];
    MINIDUMP_SYSTEM_INFO system;
    MINIDUMP_EXCEPTION_STREAM exception;
    ThreadList threads;
    CONTEXT context;
};
static_assert(offsetof(FallbackDump::ThreadList, thread) == offsetof(MINIDUMP_THREAD_LIST, Threads));

static bool WriteDumpBytes(HANDLE file, const void* data, DWORD size) {
    DWORD written = 0;
    return WriteFile(file, data, size, &written, nullptr) && written == size;
}

// DbgHelp can suspend the thread enforcing the deadline. This fallback writes
// the fault context directly and never suspends threads or walks the loader.
static bool WriteFallbackDump(Str comment) {
    FallbackDump dump{};
    dump.header.Signature = MINIDUMP_SIGNATURE;
    dump.header.Version = MINIDUMP_VERSION;
    dump.header.NumberOfStreams = comment ? 4 : 3;
    dump.header.StreamDirectoryRva = offsetof(FallbackDump, streams);
    dump.streams[0] = {SystemInfoStream, {sizeof(dump.system), offsetof(FallbackDump, system)}};
    dump.streams[1] = {ExceptionStream, {sizeof(dump.exception), offsetof(FallbackDump, exception)}};
    dump.streams[2] = {ThreadListStream, {sizeof(dump.threads), offsetof(FallbackDump, threads)}};
    dump.streams[3] = {CommentStreamA, {(ULONG32)len(comment) + 1, sizeof(dump)}};

    dump.system = gDumpSystemInfo;
    dump.context = *gMei.ExceptionPointers->ContextRecord;
    dump.exception.ThreadId = gMei.ThreadId;
    dump.exception.ThreadContext = {sizeof(dump.context), offsetof(FallbackDump, context)};
    const EXCEPTION_RECORD& record = *gMei.ExceptionPointers->ExceptionRecord;
    auto& ex = dump.exception.ExceptionRecord;
    ex.ExceptionCode = record.ExceptionCode;
    ex.ExceptionFlags = record.ExceptionFlags;
    ex.ExceptionAddress = (u64)(uintptr_t)record.ExceptionAddress;
    ex.NumberParameters = record.NumberParameters;
    if (ex.NumberParameters > dimof(ex.ExceptionInformation)) {
        ex.NumberParameters = dimof(ex.ExceptionInformation);
    }
    for (DWORD i = 0; i < ex.NumberParameters; i++) {
        ex.ExceptionInformation[i] = record.ExceptionInformation[i];
    }
    dump.threads.count = 1;
    dump.threads.thread.ThreadId = gMei.ThreadId;
    dump.threads.thread.ThreadContext = dump.exception.ThreadContext;

    const WCHAR* temp = gCrashPath->fallbackTemp.s;
    HANDLE file = CreateFileW(temp, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    bool ok = WriteDumpBytes(file, &dump, sizeof(dump));
    if (ok && comment) {
        const char end = 0;
        ok = WriteDumpBytes(file, comment.s, len(comment)) && WriteDumpBytes(file, &end, sizeof(end));
    }
    CloseHandle(file);
    if (ok) {
        DWORD flags = MOVEFILE_WRITE_THROUGH | (comment ? MOVEFILE_REPLACE_EXISTING : 0);
        ok = MoveFileExW(temp, gCrashPath->wide.s, flags);
    }
    if (!ok) {
        DeleteFileW(temp);
    }
    return ok;
}

// A raw dump is already safe on disk if the report, upload or dialog stalls.
static void FinishCrashReport() {
    gDumpPath = gCrashPath->path;
    bool usedHelper = gRawDumpWritten;
    bool haveDump = usedHelper || WriteFallbackDump({});
    if (gCrashTestMode == CrashTestMode::ReportStop) {
        Sleep(INFINITE);
    }
    if (gCrashTestMode == CrashTestMode::HeapLock) {
        void* probe = HeapAlloc(gCrashTestHeap, 0, 64);
        HeapFree(gCrashTestHeap, 0, probe);
    }

    bool recover = gMayRecover && CanEndCrashedThread();
    if (!recover) {
        CallCb(gCfg.onCrashBegin);
    }
    Str cond = recover ? StrL("crashed thread ended, process kept running") : Str{};
    Str comment = gCfg.getCrashComment ? gCfg.getCrashComment(gCrashHandlerArena, cond, {}, true) : Str{};
    WriteCrashInfoToStdErr(comment);
    if (haveDump && len(comment) > 0) {
        if (usedHelper) {
            WriteDumpViaHelper(gDumpPath, comment, &gMei, DumpKind::Crash, gReportDeadline);
        } else {
            WriteFallbackDump(comment);
        }
    }
    if (haveDump) {
        UploadMinidump(gCfg.uploadCrashes && !gCfg.localOnly);
    }
    if (recover) {
        CallCb(gCfg.onCrashedThreadEnded);
    } else if (!gCfg.localOnly) {
        CallCb(gCfg.showCrashMessage);
    }
    gRecovered = recover;
}

static DWORD WINAPI CrashDumpThread(LPVOID /*data*/) {
    // off the UI thread: the app's crash info, the dump helper (~30 ms to start)
    // and SymInitialize, which walks every loaded module (~45 ms). A crash
    // signaled meanwhile waits for it, dbghelp::Initialize serializes
    StartDumpHelper();
    SetEvent(gHelperReadyEvent);
    dir::CreateForFile(gCrashPaths[0].path);
    CallCb(gCfg.prepareCrashInfo);
    SetEvent(gReadyEvent);
    InitializeDbgHelp();
    while (WaitForSingleObject(gDumpEvent, INFINITE) == WAIT_OBJECT_0 && AtomicIntGet(&gCrashState) == Handling) {
        FinishCrashReport();
        SetEvent(gReportDoneEvent);
    }
    return 0;
}

// This is needed to intercept memory corruption reports from windows heap manager
// https://peteronprogramming.wordpress.com/2017/07/30/crashes-you-cant-handle-easily-3-status_heap_corruption-on-windows/
// https://phabricator.services.mozilla.com/D83753
static LONG HandleCrash(EXCEPTION_POINTERS* exceptionInfo, bool mayRecover) {
    DWORD threadId = GetCurrentThreadId();
    LONG previous = InterlockedCompareExchange(&gCrashState, Handling, Idle);
    if (previous == Stopped) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    if (previous == Handling) {
        if (threadId != (DWORD)AtomicIntGet(&gCrashThreadId) && threadId != gDumpThreadId) {
            WaitForSingleObject(GetCurrentProcess(), kReadyTimeoutMs + kDumpTimeoutMs + kReportTimeoutMs);
        }
        TerminateProcess(GetCurrentProcess(), 1);
        return EXCEPTION_CONTINUE_SEARCH;
    }

    AtomicIntSet(&gCrashThreadId, (int)threadId);
    gCrashPath = &gCrashPaths[gCrashCount++];
    gMei.ThreadId = threadId;
    gMei.ExceptionPointers = exceptionInfo;
    gMayRecover = mayRecover;
    gRecovered = false;

    DWORD readyMs = threadId == gDumpThreadId ? 0 : kReadyTimeoutMs;
    gRawDumpWritten = false;
    if (WaitForSingleObject(gHelperReadyEvent, readyMs) == WAIT_OBJECT_0) {
        constexpr DWORD kTestHelperTimeoutMs = 3000;
        bool testStop = gCrashTestMode == CrashTestMode::HelperStop;
        auto kind = testStop ? DumpKind::TestHelperStop : DumpKind::Crash;
        DWORD timeout = testStop ? kTestHelperTimeoutMs : kDumpTimeoutMs;
        gRawDumpWritten = WriteDumpViaHelper(gCrashPath->path, {}, &gMei, kind, GetTickCount64() + timeout);
    }
    if (threadId != gDumpThreadId) {
        gReportDeadline = GetTickCount64() + kReportTimeoutMs;
        ResetEvent(gReportDoneEvent);
        SetEvent(gDumpEvent);
        if (WaitForSingleObject(gReportDoneEvent, TimeLeft(gReportDeadline)) == WAIT_OBJECT_0 && gRecovered) {
            AtomicIntSet(&gCrashState, Idle);
            ExitThread(1);
        }
    }
    TerminateProcess(GetCurrentProcess(), 1);
    return EXCEPTION_CONTINUE_SEARCH;
}

static LONG WINAPI CrashDumpVectoredExceptionHandler(EXCEPTION_POINTERS* exceptionInfo) {
    if (exceptionInfo->ExceptionRecord->ExceptionCode != STATUS_HEAP_CORRUPTION) {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    return HandleCrash(exceptionInfo, false);
}

// there is no documented Win32 API for a thread's start address
static void* ThreadStartAddr(DWORD tid) {
    using NtQueryInfoThreadFn = LONG(WINAPI*)(HANDLE, int, void*, ULONG, ULONG*);
    constexpr int kThreadQuerySetWin32StartAddress = 9;
    auto queryInfo =
        gNtdllModule ? reinterpret_cast<NtQueryInfoThreadFn>(GetProcAddress(gNtdllModule, "NtQueryInformationThread"))
                     : nullptr;
    if (!queryInfo) {
        return nullptr;
    }
    void* addr = nullptr;
    HANDLE thread = OpenThread(THREAD_QUERY_INFORMATION, FALSE, tid);
    if (!thread) {
        return nullptr;
    }
    LONG status = queryInfo(thread, kThreadQuerySetWin32StartAddress, (void*)&addr, sizeof(addr), nullptr);
    CloseHandle(thread);
    return status >= 0 ? addr : nullptr;
}

// our threads and thread pool workers (they run our callbacks) must not be ended
static bool CanEndCrashedThread() {
    if (gCrashCount != 1 || !gCfg.canEndCrashedThread) {
        return false;
    }
    void* start = ThreadStartAddr(gMei.ThreadId);
    MEMORY_BASIC_INFORMATION info{};
    if (!start || !VirtualQuery(start, &info, sizeof(info)) || info.Type != MEM_IMAGE) {
        return false;
    }
    if (info.AllocationBase == gExeModule || info.AllocationBase == gNtdllModule) {
        return false;
    }
    return gCfg.canEndCrashedThread(gMei.ExceptionPointers->ExceptionRecord->ExceptionAddress);
}

static LONG WINAPI CrashDumpExceptionHandler(EXCEPTION_POINTERS* exceptionInfo) {
    if (!exceptionInfo || (EXCEPTION_BREAKPOINT == exceptionInfo->ExceptionRecord->ExceptionCode)) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    return HandleCrash(exceptionInfo, true);
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
// Start suspended and duplicate the events into this child only.
static void StartDumpHelper() {
    if (gCrashTestMode == CrashTestMode::NoHelper) {
        return;
    }
    gHelperRequestEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    gHelperDoneEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    gHelperLock = CreateMutexW(nullptr, FALSE, nullptr);
    if (!gHelperRequestEvent || !gHelperDoneEvent || !gHelperLock) {
        logf("StartDumpHelper: handles failed, err=%u\n", GetLastError());
        return;
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    // no std handles: a caller waiting for our stdout / stderr to close must not wait for the helper
    si.dwFlags = STARTF_USESTDHANDLES;
    TempStr cmd = fmt("\"%s\" -crash-dump-helper %u:%lld:%lld", GetSelfExePathTemp(), GetCurrentProcessId(),
                      (i64)(uintptr_t)&gRemoteEvents, (i64)(uintptr_t)&gDumpRequest);
    TempWStr cmdW = ToWStrTemp(cmd);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, cmdW.s, nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, nullptr, &si, &pi)) {
        logf("StartDumpHelper: CreateProcessW failed, err=%u\n", GetLastError());
        return;
    }

    HANDLE request = nullptr;
    HANDLE done = nullptr;
    HANDLE self = GetCurrentProcess();
    bool ok = DuplicateHandle(self, gHelperRequestEvent, pi.hProcess, &request, SYNCHRONIZE, FALSE, 0) &&
              DuplicateHandle(self, gHelperDoneEvent, pi.hProcess, &done, EVENT_MODIFY_STATE, FALSE, 0);
    gRemoteEvents = {(u64)(uintptr_t)request, (u64)(uintptr_t)done};
    if (!ok || ResumeThread(pi.hThread) == (DWORD)-1) {
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return;
    }
    CloseHandle(pi.hThread);
    gHelperProcess = pi.hProcess;
}

static bool StopDumpHelper(DWORD timeoutMs) {
    if (gHelperProcess) {
        TerminateProcess(gHelperProcess, 0);
        if (WaitForSingleObject(gHelperProcess, timeoutMs) != WAIT_OBJECT_0) {
            return false;
        }
    }
    SafeCloseHandle(&gHelperProcess);
    SafeCloseHandle(&gHelperRequestEvent);
    SafeCloseHandle(&gHelperDoneEvent);
    SafeCloseHandle(&gHelperLock);
    AtomicBoolSet(&gHelperFailed, false);
    return true;
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
    d[n] = 0;
    return Str(d, (int)n);
}

static bool WriteRequestedDump(HANDLE app, const DumpRequest& req) {
    Str path = ReadAppMemory(app, req.path, req.pathLen);
    if (len(path) == 0) {
        return false;
    }
    if (req.kind == DumpKind::TestHelperStop) {
        HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION, FALSE, req.threadId);
        if (thread && GetProcessIdOfThread(thread) == GetProcessId(app) && SuspendThread(thread) != (DWORD)-1) {
            TempWStr marker = ToWStrTemp(fmt("%s.suspended", path));
            HANDLE file =
                CreateFileW(marker.s, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (file != INVALID_HANDLE_VALUE) {
                CloseHandle(file);
            }
            Sleep(INFINITE);
        }
        SafeCloseHandle(&thread);
        return false;
    }
    Str comment = ReadAppMemory(app, req.comment, req.commentLen);

    MINIDUMP_EXCEPTION_INFORMATION mei{};
    mei.ThreadId = req.threadId;
    mei.ExceptionPointers = (EXCEPTION_POINTERS*)(uintptr_t)req.exceptionPointers;
    // the exception record and context are the app's memory
    mei.ClientPointers = TRUE;
    return WriteDumpFile(app, path, req.exceptionPointers ? &mei : nullptr, req.fullDump != 0, comment);
}

struct DumpWork {
    HANDLE app;
    const DumpRequest& request;
};

static DWORD WINAPI DumpWorker(void* data) {
    const auto& work = *(DumpWork*)data;
    bool ok = WriteRequestedDump(work.app, work.request);
    DestroyTempArena();
    return ok ? 0 : 1;
}

// DbgHelp may suspend the target, including the thread enforcing its deadline.
static bool WriteWatchedDump(HANDLE app, const DumpRequest& request) {
    DumpWork work{app, request};
    HANDLE writer = CreateThread(nullptr, 0, DumpWorker, &work, 0, nullptr);
    if (!writer) {
        return false;
    }
    HANDLE waits[] = {writer, app};
    DWORD wait = WaitForMultipleObjects(dimof(waits), waits, FALSE, TimeLeft(request.deadline));
    if (wait != WAIT_OBJECT_0) {
        if (wait != WAIT_OBJECT_0 + 1) {
            TerminateProcess(app, 1);
        }
        // A stuck writer can still be using the request on our stack.
        TerminateProcess(GetCurrentProcess(), 1);
        return false;
    }
    DWORD exitCode = 1;
    GetExitCodeThread(writer, &exitCode);
    CloseHandle(writer);
    return exitCode == 0;
}

// The helper process: writes the dumps the app that started it asks for, until
// that app exits. arg is "<app pid>:<events address>:<request address>".
int RunCrashDumpHelper(Str arg) {
    StrVec parts;
    if (Split(&parts, arg, StrL(":")) != 3) {
        return 1;
    }
    HANDLE app = OpenProcess(kHelperAppAccess, FALSE, (DWORD)ParseInt64(parts[0]));
    const void* eventsAddr = (void*)(uintptr_t)ParseInt64(parts[1]);
    u64 requestAddr = (u64)ParseInt64(parts[2]);
    DumpHelperEvents events{};
    SIZE_T nRead = 0;
    if (!app || !ReadProcessMemory(app, eventsAddr, &events, sizeof(events), &nRead) || nRead != sizeof(events)) {
        return 1;
    }
    HANDLE request = (HANDLE)(uintptr_t)events.request;
    HANDLE done = (HANDLE)(uintptr_t)events.done;

    HANDLE waits[2] = {app, request};
    for (;;) {
        DWORD res = WaitForMultipleObjects(dimof(waits), waits, FALSE, INFINITE);
        if (res != WAIT_OBJECT_0 + 1) {
            return 0;
        }
        DumpRequest req{};
        if (!ReadProcessMemory(app, (void*)(uintptr_t)requestAddr, &req, sizeof(req), &nRead) || nRead != sizeof(req)) {
            return 1;
        }
        if (req.kind == DumpKind::DebugReport) {
            if (!WriteRequestedDump(app, req)) {
                return 1;
            }
            ResetTempArena();
        } else if (!WriteWatchedDump(app, req)) {
            return 1;
        }
        SetEvent(done);
    }
}

static void PrepareFallbackInfo() {
    SYSTEM_INFO info{};
    OSVERSIONINFOEX version{};
    GetSystemInfo(&info);
    GetOsVersion(version);
    gDumpSystemInfo.ProcessorArchitecture = info.wProcessorArchitecture;
    gDumpSystemInfo.ProcessorLevel = info.wProcessorLevel;
    gDumpSystemInfo.ProcessorRevision = info.wProcessorRevision;
    DWORD processors = info.dwNumberOfProcessors;
    gDumpSystemInfo.NumberOfProcessors = processors < UCHAR_MAX ? (UCHAR)processors : UCHAR_MAX;
    gDumpSystemInfo.ProductType = version.wProductType;
    gDumpSystemInfo.MajorVersion = version.dwMajorVersion;
    gDumpSystemInfo.MinorVersion = version.dwMinorVersion;
    gDumpSystemInfo.BuildNumber = version.dwBuildNumber;
    gDumpSystemInfo.PlatformId = version.dwPlatformId;
}

static void PrepareDumpPaths(Str path) {
    Str ext = path::GetExtTemp(path);
    Str base(path.s, len(path) - len(ext));
    GUID guid{};
    WCHAR idText[39];
    i64 now = UnixTimeMsNow();
    Str id;
    if (SUCCEEDED(CoCreateGuid(&guid)) && StringFromGUID2(guid, idText, dimofi(idText))) {
        id = ToUtf8Temp(WStr(idText + 1, dimofi(idText) - 3));
    } else {
        id = fmt("%lld-%u", now, GetCurrentProcessId());
    }
    i64 minutes = now / (60 * 1000);
    Arena* a = gCrashHandlerArena;
    for (int i = 0; i < dimofi(gCrashPaths); i++) {
        Str out = str::Format(a, "%s-%d-%s-%d%s", base, minutes, id, i + 1, ext);
        WStr wide = wstr::Dup(a, ToWStrTemp(out));
        WStr temp = wstr::Dup(a, ToWStrTemp(fmt("%s.fallback.tmp", out)));
        gCrashPaths[i] = {out, wide, temp};
    }
}

void InstallCrashHandler(const CrashHandlerConfig& cfg) {
    ReportIf(gDumpEvent || gDumpThread);
    if (gDumpEvent || gDumpThread) {
        return;
    }

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
    gCrashTestMode = CrashTestMode::Normal;
    if (cfg.forTesting) {
        char mode[20]{};
        GetEnvironmentVariableA("SOLOKPDF_TEST_CRASH_HANDLER", mode, dimof(mode));
        if (str::Eq(Str(mode), StrL("report-stop"))) {
            gCrashTestMode = CrashTestMode::ReportStop;
        } else if (str::Eq(Str(mode), StrL("heap-lock"))) {
            gCrashTestMode = CrashTestMode::HeapLock;
            constexpr SIZE_T kTestHeapSize = 64 * 1024;
            gCrashTestHeap = HeapCreate(0, kTestHeapSize, kTestHeapSize);
        } else if (str::Eq(Str(mode), StrL("no-helper"))) {
            gCrashTestMode = CrashTestMode::NoHelper;
        } else if (str::Eq(Str(mode), StrL("helper-stop"))) {
            gCrashTestMode = CrashTestMode::HelperStop;
        }
    }
    Str dumpPath = cfg.crashDumpPath;
    if (cfg.forTesting) {
        WCHAR dir[MAX_PATH];
        DWORD n = GetEnvironmentVariableW(L"SOLOKPDF_TEST_CRASH_DIR", dir, dimof(dir));
        if (n > 0 && n < dimof(dir)) {
            dumpPath = path::JoinTemp(ToUtf8Temp(WStr(dir, (int)n)), StrL("sumatrapdfcrash.dmp"));
        }
    }
    // The faulting thread never formats or checks its path on disk.
    gCfg.crashDumpPath = str::Dup(gCrashHandlerArena, dumpPath);
    PrepareDumpPaths(dumpPath);
    PrepareFallbackInfo();
    gCfg.submitUrl = str::Dup(gCrashHandlerArena, cfg.submitUrl);
    gCfg.fullDumpEnvVar = str::Dup(gCrashHandlerArena, cfg.fullDumpEnvVar);
    gFullDump = len(cfg.fullDumpEnvVar) > 0 && GetEnvironmentVariableA(CStrTemp(cfg.fullDumpEnvVar), nullptr, 0) != 0;
    gCrashCount = 0;
    AtomicIntSet(&gCrashThreadId, 0);
    gDumpThreadId = 0;
    gExeModule = GetModuleHandleW(nullptr);
    gNtdllModule = GetModuleHandleW(L"ntdll.dll");

    BuildSystemInfo();
    gDumpEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    gReportDoneEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    gHelperReadyEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    gReadyEvent = CreateEvent(nullptr, TRUE, FALSE, nullptr);
    if (!gDumpEvent || !gReportDoneEvent || !gHelperReadyEvent || !gReadyEvent) {
        log(StrL("InstallCrashHandler: skipping because !gDumpEvent\n"));
        UninstallCrashHandler();
        return;
    }
    gDumpThread = CreateThread(nullptr, 0, CrashDumpThread, nullptr, 0, &gDumpThreadId);
    if (!gDumpThread) {
        log(StrL("InstallCrashHandler: skipping because !gDumpThread\n"));
        UninstallCrashHandler();
        return;
    }
    AtomicIntSet(&gCrashState, Idle);
    gPrevExceptionFilter = SetUnhandledExceptionFilter(CrashDumpExceptionHandler);
    gExceptionFilterInstalled = true;
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
    if (InterlockedCompareExchange(&gCrashState, Stopped, Idle) == Handling) {
        return;
    }

    if (gExceptionFilterInstalled) {
        SetUnhandledExceptionFilter(gPrevExceptionFilter);
        gExceptionFilterInstalled = false;
    }
    // must go before we close the handles it waits on: left registered, it
    // would run on a heap corruption during shutdown and SetEvent() / wait on
    // closed handles, whose values may since have been recycled
    if (gVectoredHandler) {
        RemoveVectoredExceptionHandler(gVectoredHandler);
        gVectoredHandler = nullptr;
    }

    constexpr DWORD kShutdownWaitMs = 1000;
    if (gDumpThread) {
        SetEvent(gDumpEvent);
        // Leave the configuration and events alive if preparation is still using them.
        if (WaitForSingleObject(gDumpThread, kShutdownWaitMs) != WAIT_OBJECT_0) {
            return;
        }
    }
    if (!StopDumpHelper(kShutdownWaitMs)) {
        return;
    }

    SafeCloseThreadHandle(&gDumpThread);
    SafeCloseHandle(&gDumpEvent);
    SafeCloseHandle(&gReportDoneEvent);
    SafeCloseHandle(&gHelperReadyEvent);
    SafeCloseHandle(&gReadyEvent);
    if (gCrashTestHeap) {
        HeapDestroy(gCrashTestHeap);
        gCrashTestHeap = nullptr;
    }

    // those are allocated from gCrashHandlerArena so are freed by ArenaDelete()
    gSystemInfo = {};
    gCfg = {};
    ArenaDelete(gCrashHandlerArena);
    gCrashInfo = nullptr;
    gCrashHandlerArena = nullptr;
    gDumpThreadId = 0;
    gDumpPath = {};
}

HANDLE CrashHandlerTestHeap() {
    return gCrashTestHeap;
}

bool CrashTestHandlesPrivate() {
    if (!gCfg.forTesting || WaitForSingleObject(gHelperReadyEvent, kReadyTimeoutMs) != WAIT_OBJECT_0) {
        return false;
    }
    HANDLE handles[] = {gHelperProcess, gHelperRequestEvent, gHelperDoneEvent, gHelperLock};
    for (HANDLE handle : handles) {
        DWORD flags = 0;
        if (!GetHandleInformation(handle, &flags) || (flags & HANDLE_FLAG_INHERIT)) {
            return false;
        }
    }
    return true;
}

bool CrashTestRestoreFilter() {
    if (!gCfg.forTesting || !gExceptionFilterInstalled) {
        return false;
    }
    LPTOP_LEVEL_EXCEPTION_FILTER expected = gPrevExceptionFilter;
    UninstallCrashHandler();
    return SetUnhandledExceptionFilter(expected) == expected;
}

#endif // OS_WIN
