// Smoke test for the mupdf static library: opens a document and prints how
// many pages it has. With -js-throw / -js-oom it also checks that an error
// while form JavaScript runs doesn't escape on the JS engine's context.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mupdf/fitz.h"
#include "mupdf/pdf.h"

// Not empty: the linker would fold empty ones into mupdf's default lock
// functions, and fz_clone_context() refuses a context that has those.
static int gLockDepth = 0;

static void Lock(void*, int) {
    gLockDepth++;
}

static void Unlock(void*, int) {
    gLockDepth--;
}

static void ThrowingConsoleWrite(void* user, const char*) {
    fz_throw((fz_context*)user, FZ_ERROR_GENERIC, "console write failed");
}

static pdf_js_console gThrowingConsole = {nullptr, nullptr, nullptr, nullptr, ThrowingConsoleWrite};

// size of the one allocation -js-oom fails: the copy of a kOomValueLen
// character event.value, which nothing else in mupdf happens to ask for
constexpr size_t kOomValueLen = 5000;
constexpr size_t kOomAllocSize = kOomValueLen + 1;

static void* OomMalloc(void*, size_t size) {
    if (size == kOomAllocSize) {
        return nullptr;
    }
    return malloc(size);
}

static void* OomRealloc(void*, void* p, size_t size) {
    return realloc(p, size);
}

static void OomFree(void*, void* p) {
    free(p);
}

enum class JsFault {
    ConsoleThrows,
    ValueCopyOom,
};

// Loads page 1 on a cloned context, the way a render thread does: the JS
// engine keeps the context it was enabled with, which has no fz_try here.
static int JsFaultTest(const char* path, JsFault fault) {
    // cloning needs lock callbacks; this test has one thread
    fz_locks_context locks = {nullptr, Lock, Unlock};
    fz_alloc_context oomAlloc = {nullptr, OomMalloc, OomRealloc, OomFree};
    fz_alloc_context* alloc = fault == JsFault::ValueCopyOom ? &oomAlloc : nullptr;
    fz_context* ctx = fz_new_context(alloc, &locks, FZ_STORE_DEFAULT);
    if (!ctx) {
        fprintf(stderr, "fz_new_context() failed\n");
        return 1;
    }
    fz_document* doc = nullptr;
    fz_var(doc);
    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        doc = fz_open_document(ctx, path);
        pdf_document* pdf = pdf_document_from_fz_document(ctx, doc);
        pdf_enable_js(ctx, pdf);
        if (fault == JsFault::ConsoleThrows) {
            pdf_js_set_console(ctx, pdf, &gThrowingConsole, ctx);
        }
    }
    fz_catch(ctx) {
        fprintf(stderr, "%s: %s\n", path, fz_caught_message(ctx));
        return 1;
    }

    fz_context* clone = fz_clone_context(ctx);
    if (!clone) {
        fprintf(stderr, "fz_clone_context() failed\n");
        return 1;
    }
    int res = 0;
    fz_try(clone) {
        fz_drop_page(clone, fz_load_page(clone, doc, 0));
    }
    fz_catch(clone) {
        fprintf(stderr, "%s: %s\n", path, fz_caught_message(clone));
        // running out of memory may fail the page, but on the caller's context
        res = fault == JsFault::ValueCopyOom ? 0 : 1;
    }
    fz_drop_context(clone);
    fz_drop_document(ctx, doc);
    fz_drop_context(ctx);
    if (res == 0) {
        printf("%s: JavaScript error contained\n", path);
    }
    return res;
}

static void RedStroke(fz_context* ctx, void*, pdf_obj** cs, int* n, float color[FZ_MAX_COLORS]) {
    pdf_drop_obj(ctx, *cs);
    *cs = pdf_keep_obj(ctx, PDF_NAME(DeviceRGB));
    *n = 3;
    color[0] = 1;
    color[1] = 0;
    color[2] = 0;
}

enum class ColorResources {
    Present,
    Missing
};

static int ColorFilterTest(ColorResources resourceMode) {
    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    if (!ctx) {
        return 1;
    }
    pdf_document* doc = nullptr;
    pdf_page* page = nullptr;
    fz_pixmap* pix = nullptr;
    fz_buffer* contents = nullptr;
    pdf_obj* resources = nullptr;
    pdf_obj* pageObj = nullptr;
    int result = 1;
    fz_var(doc);
    fz_var(page);
    fz_var(pix);
    fz_var(contents);
    fz_var(resources);
    fz_var(pageObj);
    fz_var(result);
    fz_try(ctx) {
        doc = pdf_create_document(ctx);
        if (resourceMode == ColorResources::Present) {
            resources = pdf_new_dict(ctx, doc, 0);
        }
        const char* path = "10 w 5 5 m 95 5 l 95 95 l 5 95 l s";
        contents = fz_new_buffer_from_copied_data(ctx, (const unsigned char*)path, strlen(path));
        pageObj = pdf_add_page(ctx, doc, fz_make_rect(0, 0, 100, 100), 0, resources, contents);
        pdf_insert_page(ctx, doc, 0, pageObj);
        if (resourceMode == ColorResources::Missing) {
            pdf_dict_del(ctx, pageObj, PDF_NAME(Resources));
        }
        page = pdf_load_page(ctx, doc, 0);
        pdf_color_filter_options colors{};
        colors.color_rewrite = RedStroke;
        pdf_filter_factory filters[2]{};
        filters[0].filter = pdf_new_color_filter;
        filters[0].options = &colors;
        pdf_filter_options options{};
        options.filters = filters;
        pdf_filter_page_contents(ctx, doc, page, &options);
        pix = pdf_new_pixmap_from_page_contents_with_usage(ctx, page, fz_identity, fz_device_rgb(ctx), 0, "View",
                                                           FZ_CROP_BOX);
        if (pix->w == 100 && pix->h == 100 && pix->n == 3) {
            unsigned char* p = pix->samples + 95 * pix->stride + 50 * pix->n;
            result = p[0] == 255 && p[1] == 0 && p[2] == 0 ? 0 : 1;
            fprintf(stderr, "filtered stroke (%s resources): %u,%u,%u\n",
                    resourceMode == ColorResources::Present ? "with" : "without", p[0], p[1], p[2]);
        }
    }
    fz_always(ctx) {
        fz_drop_pixmap(ctx, pix);
        fz_drop_page(ctx, (fz_page*)page);
        pdf_drop_obj(ctx, pageObj);
        pdf_drop_obj(ctx, resources);
        fz_drop_buffer(ctx, contents);
        pdf_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        fprintf(stderr, "color filter: %s\n", fz_caught_message(ctx));
    }
    fz_drop_context(ctx);
    return result;
}

static void InvertGray(fz_context* ctx, void*, pdf_obj** cs, int* n, float color[FZ_MAX_COLORS]) {
    if (*n == 3) {
        for (int i = 0; i < 3; i++) {
            color[i] = 1 - color[i];
        }
        return;
    }
    if (*n != 1) {
        return;
    }
    float inverted = 1 - color[0];
    pdf_drop_obj(ctx, *cs);
    *cs = pdf_keep_obj(ctx, PDF_NAME(DeviceRGB));
    *n = 3;
    color[0] = color[1] = color[2] = inverted;
}

static void InvertVertex(fz_context* ctx, void*, fz_colorspace*, float* dst, fz_colorspace* src, const float* color) {
    float rgb[3]{};
    fz_convert_color(ctx, src, color, fz_device_rgb(ctx), rgb, nullptr, fz_default_color_params);
    for (int i = 0; i < 3; i++) {
        dst[i] = 1 - rgb[i];
    }
}

static pdf_recolor_vertex* InvertShade(fz_context* ctx, void*, fz_colorspace*, fz_colorspace** dst) {
    *dst = fz_device_rgb(ctx);
    return InvertVertex;
}

enum class ColorContent {
    Page,
    Widget,
    WidgetSnapshot,
    Mask,
    MaskDefault,
    MaskPattern,
    MaskGray,
    MaskDynamic,
    MaskShade,
    MaskShadeSnapshot,
    MaskShadeDynamic,
    MaskShadeNoRewrite,
    MaskSoft
};

static void ColorFilterWarning(void* user, const char* message) {
    if (strstr(message, "found duplicate pdf_obj in the store") ||
        strstr(message, "unexpectedly replacing entry in PDF store") ||
        strstr(message, "trying to repair broken xref")) {
        *(int*)user = 1;
    }
    fprintf(stderr, "warning: %s\n", message);
}

struct SuffixOutput {
    fz_buffer* buffer;
    int64_t originalSize;
    int64_t position;
};

static void WriteSuffix(fz_context* ctx, void* state, const void* data, size_t size) {
    auto* out = (SuffixOutput*)state;
    size_t skip = out->position < out->originalSize ? (size_t)(out->originalSize - out->position) : 0;
    if (skip > size) {
        skip = size;
    }
    fz_append_data(ctx, out->buffer, (const unsigned char*)data + skip, size - skip);
    out->position += (int64_t)size;
}

static int64_t TellSuffix(fz_context*, void* state) {
    return ((SuffixOutput*)state)->position;
}

static int SharedColorTest(const char* path, ColorContent content, const char* outputPath = nullptr) {
    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    if (!ctx) {
        return 1;
    }
    pdf_document* doc = nullptr;
    pdf_page* page = nullptr;
    fz_pixmap* pix = nullptr;
    fz_buffer* output = nullptr;
    fz_buffer* suffix = nullptr;
    fz_output* writer = nullptr;
    fz_stream* input = nullptr;
    int result = 0;
    int duplicate = 0;
    fz_set_warning_callback(ctx, ColorFilterWarning, &duplicate);
    fz_var(doc);
    fz_var(page);
    fz_var(pix);
    fz_var(output);
    fz_var(suffix);
    fz_var(writer);
    fz_var(input);
    fz_var(result);
    fz_var(duplicate);
    fz_try(ctx) {
        doc = pdf_open_document(ctx, path);
        bool snapshot = content == ColorContent::MaskShadeSnapshot || content == ColorContent::WidgetSnapshot;
        bool widget = content == ColorContent::Widget || content == ColorContent::WidgetSnapshot;
        pdf_color_filter_options colors{};
        colors.color_rewrite = InvertGray;
        colors.preserve_image_masks = content == ColorContent::Mask || content == ColorContent::MaskDefault ||
                                      content == ColorContent::MaskPattern || content == ColorContent::MaskGray ||
                                      content == ColorContent::MaskDynamic || content == ColorContent::MaskShade ||
                                      content == ColorContent::MaskShadeSnapshot ||
                                      content == ColorContent::MaskShadeDynamic;
        if (content == ColorContent::MaskShade || content == ColorContent::MaskShadeDynamic ||
            content == ColorContent::MaskShadeSnapshot) {
            colors.shade_rewrite = InvertShade;
        }
        pdf_filter_factory filters[2]{};
        filters[0].filter = pdf_new_color_filter;
        filters[0].options = &colors;
        pdf_filter_options options{};
        options.filters = filters;
        options.recurse = 1;
        options.preserve_soft_masks = content == ColorContent::MaskSoft;
        unsigned char original[3][3]{};
        if (content == ColorContent::MaskDynamic || content == ColorContent::MaskShadeDynamic ||
            content == ColorContent::MaskShadeNoRewrite) {
            page = pdf_load_page(ctx, doc, 0);
            pix = pdf_new_pixmap_from_page_contents_with_usage(ctx, page, fz_identity, fz_device_rgb(ctx), 0, "View",
                                                               FZ_CROP_BOX);
            if (pix->w != 300 || pix->h != 100 || pix->n != 3) {
                fz_throw(ctx, FZ_ERROR_GENERIC, "unexpected input dimensions");
            }
            memcpy(original[0], pix->samples + 50 * pix->stride + 50 * pix->n, 3);
            memcpy(original[1], pix->samples + 50 * pix->stride + 150 * pix->n, 3);
            memcpy(original[2], pix->samples + 50 * pix->stride + 250 * pix->n, 3);
            fz_drop_pixmap(ctx, pix);
            pix = nullptr;
            fz_drop_page(ctx, (fz_page*)page);
            page = nullptr;
        }
        int pageCount = content == ColorContent::Page ? 2 : 1;
        for (int i = 0; i < pageCount; i++) {
            page = pdf_load_page(ctx, doc, i);
            if (!widget) {
                pdf_filter_page_contents(ctx, doc, page, &options);
            } else {
                for (pdf_annot* annot = pdf_first_widget(ctx, page); annot; annot = pdf_next_widget(ctx, annot)) {
                    pdf_filter_annot_contents(ctx, doc, annot, &options);
                }
            }
            fz_drop_page(ctx, (fz_page*)page);
            page = nullptr;
        }
        SuffixOutput suffixState{};
        if (snapshot) {
            suffix = fz_new_buffer(ctx, 0);
            suffixState.buffer = suffix;
            suffixState.originalSize = doc->file_size;
            writer = fz_new_output(ctx, 0, &suffixState, WriteSuffix, nullptr, nullptr);
            writer->tell = TellSuffix;
            int rejected = 0;
            fz_var(rejected);
            fz_try(ctx) {
                pdf_write_snapshot_suffix(ctx, doc, writer);
            }
            fz_catch(ctx) {
                rejected = 1;
            }
            if (!rejected) {
                fz_throw(ctx, FZ_ERROR_GENERIC, "invalid snapshot offset accepted");
            }
            suffixState.position = suffixState.originalSize;
        } else {
            output = fz_new_buffer(ctx, 0);
            writer = fz_new_output_with_buffer(ctx, output);
        }
        pdf_write_options write{};
        if (snapshot) {
            pdf_write_snapshot_suffix(ctx, doc, writer);
        } else {
            pdf_write_document(ctx, doc, writer, &write);
        }
        fz_close_output(ctx, writer);
        fz_drop_output(ctx, writer);
        writer = nullptr;
        if (snapshot) {
            output = fz_read_file(ctx, path);
            unsigned char* bytes = nullptr;
            size_t size = fz_buffer_storage(ctx, suffix, &bytes);
            if (!size || suffixState.position != suffixState.originalSize + (int64_t)size) {
                fz_throw(ctx, FZ_ERROR_GENERIC, "invalid snapshot suffix");
            }
            fz_append_data(ctx, output, bytes, size);
        }
        if (outputPath) {
            fz_save_buffer(ctx, output, outputPath);
        }
        pdf_drop_document(ctx, doc);
        doc = nullptr;
        input = fz_open_buffer(ctx, output);
        doc = pdf_open_document_with_stream(ctx, input);
        for (int i = 0; i < pageCount; i++) {
            page = pdf_load_page(ctx, doc, i);
            pix = !widget ? pdf_new_pixmap_from_page_contents_with_usage(ctx, page, fz_identity, fz_device_rgb(ctx), 0,
                                                                         "View", FZ_CROP_BOX)
                          : pdf_new_pixmap_from_page_with_usage(ctx, page, fz_identity, fz_device_rgb(ctx), 0, "View",
                                                                FZ_CROP_BOX);
            int width = content == ColorContent::Page ? 200 : widget ? 600 : 300;
            int height = widget ? 700 : 100;
            int y = widget ? 350 : 50;
            int glyphX = widget ? 200 : 50;
            int imageX = widget ? 400 : 150;
            if (pix->w != width || pix->h != height || pix->n != 3) {
                result = 1;
            } else {
                unsigned char* glyph = pix->samples + y * pix->stride + glyphX * pix->n;
                unsigned char* image = pix->samples + y * pix->stride + imageX * pix->n;
                fprintf(stderr, "page %d glyph: %u,%u,%u image: %u,%u,%u\n", i + 1, glyph[0], glyph[1], glyph[2],
                        image[0], image[1], image[2]);
                int glyphExpected[] = {255, 255, 255};
                int imageExpected[] = {255, 0, 0};
                if (content == ColorContent::MaskPattern || content == ColorContent::MaskShade ||
                    content == ColorContent::MaskShadeSnapshot) {
                    glyphExpected[0] = 0;
                } else if (content == ColorContent::MaskSoft) {
                    glyphExpected[0] = glyphExpected[1] = glyphExpected[2] = 0;
                } else if (content == ColorContent::MaskDefault) {
                    imageExpected[0] = 0;
                } else if (content == ColorContent::MaskGray) {
                    for (int c = 0; c < 3; c++) {
                        glyphExpected[c] = 191;
                        imageExpected[c] = 64;
                    }
                } else if (content == ColorContent::MaskDynamic || content == ColorContent::MaskShadeDynamic ||
                           content == ColorContent::MaskShadeNoRewrite) {
                    for (int c = 0; c < 3; c++) {
                        glyphExpected[c] =
                            content == ColorContent::MaskShadeNoRewrite ? original[0][c] : 255 - original[0][c];
                        imageExpected[c] = original[1][c];
                    }
                }
                for (int c = 0; c < 3; c++) {
                    if (abs(glyph[c] - glyphExpected[c]) > 3 || abs(image[c] - imageExpected[c]) > 3) {
                        result = 1;
                    }
                }
                if (content == ColorContent::Mask || content == ColorContent::MaskDefault ||
                    content == ColorContent::MaskPattern || content == ColorContent::MaskGray ||
                    content == ColorContent::MaskDynamic || content == ColorContent::MaskShade ||
                    content == ColorContent::MaskShadeSnapshot || content == ColorContent::MaskSoft ||
                    content == ColorContent::MaskShadeDynamic || content == ColorContent::MaskShadeNoRewrite) {
                    unsigned char* blue = pix->samples + y * pix->stride + 250 * pix->n;
                    fprintf(stderr, "second mask: %u,%u,%u\n", blue[0], blue[1], blue[2]);
                    int expectedBlue[] = {0, 0, 255};
                    for (int c = 0; c < 3; c++) {
                        int expected = content == ColorContent::MaskGray ? 191
                                       : content == ColorContent::MaskDynamic ||
                                               content == ColorContent::MaskShadeDynamic ||
                                               content == ColorContent::MaskShadeNoRewrite
                                           ? original[2][c]
                                           : expectedBlue[c];
                        if (abs(blue[c] - expected) > 3) {
                            result = 1;
                        }
                    }
                }
            }
            fz_drop_pixmap(ctx, pix);
            pix = nullptr;
            fz_drop_page(ctx, (fz_page*)page);
            page = nullptr;
        }
    }
    fz_always(ctx) {
        fz_drop_pixmap(ctx, pix);
        fz_drop_page(ctx, (fz_page*)page);
        pdf_drop_document(ctx, doc);
        fz_drop_stream(ctx, input);
        fz_drop_output(ctx, writer);
        fz_drop_buffer(ctx, output);
        fz_drop_buffer(ctx, suffix);
    }
    fz_catch(ctx) {
        fprintf(stderr, "shared color filter: %s\n", fz_caught_message(ctx));
        result = 1;
    }
    fz_flush_warnings(ctx);
    result |= duplicate;
    fz_drop_context(ctx);
    return result;
}

int main(int argc, char** argv) {
    if (argc == 4 && strcmp(argv[1], "-color-widget-snapshot") == 0) {
        return SharedColorTest(argv[2], ColorContent::WidgetSnapshot, argv[3]);
    }
    if (argc == 4 && strcmp(argv[1], "-color-mask-snapshot") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskShadeSnapshot, argv[3]);
    }
    if (argc == 3 && strcmp(argv[1], "-color-shared") == 0) {
        return SharedColorTest(argv[2], ColorContent::Page);
    }
    if (argc == 3 && strcmp(argv[1], "-color-widget") == 0) {
        return SharedColorTest(argv[2], ColorContent::Widget);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask") == 0) {
        return SharedColorTest(argv[2], ColorContent::Mask);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask-default") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskDefault);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask-pattern") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskPattern);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask-gray") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskGray);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask-dynamic") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskDynamic);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask-shade") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskShade);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask-snapshot") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskShadeSnapshot);
    }
    if (argc == 3 && strcmp(argv[1], "-color-mask-shade-dynamic") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskShadeDynamic);
    }
    if (argc == 3 && strcmp(argv[1], "-color-shade-no-rewrite") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskShadeNoRewrite);
    }
    if (argc == 3 && strcmp(argv[1], "-color-soft-mask") == 0) {
        return SharedColorTest(argv[2], ColorContent::MaskSoft);
    }
    if (argc == 2 && strcmp(argv[1], "-color-filter") == 0) {
        int result = ColorFilterTest(ColorResources::Present);
        result |= ColorFilterTest(ColorResources::Missing);
        return result;
    }
    if (argc == 3 && strcmp(argv[1], "-js-throw") == 0) {
        return JsFaultTest(argv[2], JsFault::ConsoleThrows);
    }
    if (argc == 3 && strcmp(argv[1], "-js-oom") == 0) {
        return JsFaultTest(argv[2], JsFault::ValueCopyOom);
    }
    if (argc != 2) {
        fprintf(stderr,
                "usage: test_mupdf [-js-throw | -js-oom | -color-shared | -color-widget | -color-mask | "
                "-color-mask-default] <file> | "
                "-color-filter\n");
        return 2;
    }
    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    if (!ctx) {
        fprintf(stderr, "fz_new_context() failed\n");
        return 1;
    }
    fz_document* doc = nullptr;
    int nPages = 0;
    fz_var(doc);
    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        doc = fz_open_document(ctx, argv[1]);
        nPages = fz_count_pages(ctx, doc);
    }
    fz_always(ctx) {
        fz_drop_document(ctx, doc);
    }
    fz_catch(ctx) {
        fprintf(stderr, "%s: %s\n", argv[1], fz_caught_message(ctx));
        fz_drop_context(ctx);
        return 1;
    }
    printf("%s: %d pages\n", argv[1], nPages);
    fz_drop_context(ctx);
    return 0;
}
