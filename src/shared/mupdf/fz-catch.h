/* Copyright 2026 the SumatraPDF project authors (see AUTHORS file).
   License: GPLv3 */

/* Catches for our code (E111). Each one consumes the caught error, so a later throw or
   fz_drop_context() never finds it pending and warns "UNHANDLED EXCEPTION!".
   tests/lint-fz-catch.ts rejects a raw fz_catch() under src/.

     fz_catch_report(ctx) { ... }          logs it; a cancellation (abort, trylater) silently
     fz_catch_report_except(ctx, code)     rethrows that code, logs the rest
     fz_catch_ignore(ctx, "why") { ... }   an expected error, dropped silently
     fz_catch_code(ctx, code) { ... }      dropped silently, its code stored in an int; the body
                                           may fz_report_caught() or fz_rethrow_caught() it
     fz_catch_rethrow(ctx) { ... }         failure-only cleanup, then rethrows; the body must
                                           not return, break or goto

   fz_caught_message() stays valid in the body until the next throw. */

#ifndef FZ_CATCH_H
#define FZ_CATCH_H

enum {
    FZ_CATCH_IGNORE,
    FZ_CATCH_REPORT,
};

static inline int fz_is_cancel_error(int code) {
    return code == FZ_ERROR_ABORT || code == FZ_ERROR_TRYLATER;
}

static inline int fz_consume_caught(fz_context* ctx, int how) {
    int code = fz_caught(ctx);
    if (how == FZ_CATCH_REPORT && !fz_is_cancel_error(code)) {
        fz_report_error(ctx);
    } else {
        fz_ignore_error(ctx);
    }
    return code;
}

/* re-arms a code taken by fz_catch_code so MuPDF logs it */
static inline void fz_report_caught(fz_context* ctx, int code) {
    if (fz_is_cancel_error(code)) {
        return;
    }
    ctx->error.errcode = code;
    fz_report_error(ctx);
}

/* re-arms a code taken by fz_catch_code and propagates it */
static inline FZ_NORETURN void fz_rethrow_caught(fz_context* ctx, int code) {
    ctx->error.errcode = code;
    fz_rethrow(ctx);
}

#define fz_catch_report(ctx) fz_catch(ctx) if (fz_consume_caught(ctx, FZ_CATCH_REPORT) >= 0)
#define fz_catch_report_except(ctx, rethrown) \
    fz_catch(ctx) if ((fz_rethrow_if(ctx, rethrown), fz_consume_caught(ctx, FZ_CATCH_REPORT)) >= 0)
#define fz_catch_ignore(ctx, reason) fz_catch(ctx) if (fz_consume_caught(ctx, FZ_CATCH_IGNORE) >= 0)
#define fz_catch_code(ctx, code) fz_catch(ctx) if (((code) = fz_consume_caught(ctx, FZ_CATCH_IGNORE)) >= 0)
/* the code is kept before the body: a fz_try inside the cleanup resets ctx's */
#define fz_catch_rethrow(ctx) \
    fz_catch(ctx) for (int fz_rethrow_code_ = fz_caught(ctx);; fz_rethrow_caught(ctx, fz_rethrow_code_))

#endif
