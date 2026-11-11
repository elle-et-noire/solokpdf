#include <windows.h>

#if defined(REPRO_DLL)

static HANDLE heap;
static void* block;
static constexpr SIZE_T kBlockSize = 256;
static constexpr SIZE_T kNewSize = 512;
static constexpr BYTE kPattern = 0x5a;

extern "C" __declspec(dllexport) void* Init() {
    heap = HeapCreate(HEAP_CREATE_SEGMENT_HEAP, 0, 0);
    block = heap ? HeapAlloc(heap, HEAP_ZERO_MEMORY, kBlockSize) : nullptr;
    if (block) {
        FillMemory(block, kBlockSize, kPattern);
    }
    return block;
}

BOOL WINAPI DllMain(HINSTANCE, DWORD reason, void*) {
    if (reason != DLL_PROCESS_DETACH || !block) {
        return TRUE;
    }
    using Realloc = void*(WINAPI*)(void*, DWORD, void*, SIZE_T);
    auto resize = (Realloc)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlReAllocateHeap");
    void* resized = resize(heap, HEAP_ZERO_MEMORY, block, kNewSize);
    bool valid = resized != nullptr;
    for (SIZE_T i = 0; resized && i < kNewSize; i++) {
        unsigned char expected = i < kBlockSize ? kPattern : 0;
        valid = valid && ((unsigned char*)resized)[i] == expected;
    }
    const char* message = !resized ? "realloc=failed\n" : valid ? "realloc=ok data=ok\n" : "realloc=ok data=failed\n";
    DWORD written;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), message, (DWORD)lstrlenA(message), &written, nullptr);
    if (resized) {
        HeapFree(heap, 0, resized);
    }
    return TRUE;
}

#else

#include <stdio.h>
#include <stdlib.h>

#if defined(REPRO_ASAN)
extern "C" int __sanitizer_get_ownership(const volatile void*);
#endif

int main(int argc, char** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    if (argc < 2) {
        return 2;
    }
    if (lstrcmpA(argv[1], "overflow") == 0) {
        constexpr size_t kSize = 16;
        volatile char* p = (char*)malloc(kSize);
        if (!p) {
            return 6;
        }
        p[kSize] = 1;
        free((void*)p);
        return 0;
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
