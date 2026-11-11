#include <windows.h>

#if defined(REPRO_DLL)

static HANDLE heap;
static void* block;

extern "C" __declspec(dllexport) void* Init() {
    heap = HeapCreate(HEAP_CREATE_SEGMENT_HEAP, 0, 0);
    block = heap ? HeapAlloc(heap, HEAP_ZERO_MEMORY, 256) : nullptr;
    return block;
}

BOOL WINAPI DllMain(HINSTANCE, DWORD reason, void*) {
    if (reason != DLL_PROCESS_DETACH || !block) {
        return TRUE;
    }
    using Realloc = void*(WINAPI*)(void*, DWORD, void*, SIZE_T);
    auto resize = (Realloc)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlReAllocateHeap");
    void* resized = resize(heap, HEAP_ZERO_MEMORY, block, 512);
    const char* message = resized ? "realloc=ok\n" : "realloc=failed\n";
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), message, (DWORD)lstrlenA(message), &written, nullptr);
    if (resized) {
        HeapFree(heap, 0, resized);
    }
    return TRUE;
}

#else

#include <stdio.h>

#if defined(REPRO_ASAN)
extern "C" int __sanitizer_get_ownership(const volatile void*);
#endif

int main(int argc, char** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    if (argc < 2) {
        return 2;
    }
    HMODULE dll = LoadLibraryA(argv[1]);
    if (!dll) {
        fprintf(stderr, "LoadLibrary(%s): %lu\n", argv[1], GetLastError());
        return 3;
    }
    auto init = (void* (*)())GetProcAddress(dll, "Init");
    void* p = init ? init() : nullptr;
    if (!p) {
        return 4;
    }
#if defined(REPRO_ASAN)
    printf("asan-owned=%d\n", __sanitizer_get_ownership(p));
    fflush(stdout);
#endif
    if (argc > 2 && !FreeLibrary(dll)) {
        return 5;
    }
    return 0;
}

#endif
