/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

inline void LogMupdfMessage(void*, const char* message) {
    Str text(message);
    log(str::EndsWith(text, StrL("\n")) ? text : str::JoinTemp(text, StrL("\n")));
}

inline fz_context* NewMupdfContext(size_t maxStore, const fz_locks_context* locks = nullptr,
                                   void (*onMessage)(void*, const char*) = LogMupdfMessage, void* user = nullptr) {
    fz_context* ctx = fz_new_context(nullptr, locks, maxStore);
    if (ctx) {
        fz_set_warning_callback(ctx, onMessage, user);
        fz_set_error_callback(ctx, onMessage, user);
    }
    return ctx;
}
