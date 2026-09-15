#include "purrvect.h"
#include <thorvg_capi.h>
#include <algorithm>
#include <cmath>
#include <memory>
#include <mutex>
#include <new>
#include <vector>

namespace { std::mutex engine_mutex; }
struct PurrvectDocument {
    Tvg_Paint picture = nullptr;
    Tvg_Canvas canvas = nullptr;
    float width = 0, height = 0;
    bool initialized = false;
    ~PurrvectDocument() {
        if (canvas) tvg_canvas_destroy(canvas);
        else if (picture) tvg_paint_unref(picture, true);
        if (initialized) tvg_engine_term();
    }
};
extern "C" uint32_t purrvect_abi_version(void) { return 1; }
extern "C" PurrvectDocument *purrvect_load(const void *data, size_t length) {
    if (!data || !length || length > PURRVECT_MAX_BYTES) return nullptr;
    try {
        std::lock_guard<std::mutex> lock(engine_mutex);
        auto doc = std::make_unique<PurrvectDocument>();
        if (tvg_engine_init(0) != TVG_RESULT_SUCCESS) return nullptr;
        doc->initialized = true;
        doc->picture = tvg_picture_new();
        if (!doc->picture) return nullptr;
        if (tvg_picture_load_data(doc->picture, static_cast<const char *>(data),
                static_cast<uint32_t>(length), "svg", nullptr, true) != TVG_RESULT_SUCCESS) return nullptr;
        if (tvg_picture_get_size(doc->picture, &doc->width, &doc->height) != TVG_RESULT_SUCCESS) return nullptr;
        if (!std::isfinite(doc->width) || !std::isfinite(doc->height) || doc->width <= 0 || doc->height <= 0) return nullptr;
        auto canvas = tvg_swcanvas_create(TVG_ENGINE_OPTION_DEFAULT);
        if (!canvas) return nullptr;
        if (tvg_canvas_add(canvas, doc->picture) != TVG_RESULT_SUCCESS) {
            tvg_canvas_destroy(canvas);
            return nullptr;
        }
        doc->canvas = canvas;
        return doc.release();
    } catch (...) { return nullptr; }
}
extern "C" void purrvect_free(PurrvectDocument *doc) {
    if (!doc) return;
    try { std::lock_guard<std::mutex> lock(engine_mutex); delete doc; } catch (...) {}
}
extern "C" PurrvectStatus purrvect_size(const PurrvectDocument *doc, float *w, float *h) {
    if (!doc || !w || !h) return PURRVECT_INVALID_ARGUMENT;
    *w = doc->width; *h = doc->height;
    return PURRVECT_OK;
}
extern "C" PurrvectStatus purrvect_render(PurrvectDocument *doc, uint32_t w, uint32_t h, uint8_t *out, size_t length) {
    if (!doc || !out || !w || !h || w > PURRVECT_MAX_DIMENSION || h > PURRVECT_MAX_DIMENSION ||
        length != static_cast<size_t>(w) * h * 4) return PURRVECT_INVALID_ARGUMENT;
    try {
        std::lock_guard<std::mutex> lock(engine_mutex);
        std::vector<uint32_t> pixels(static_cast<size_t>(w) * h, 0);
        float scale = std::min(w / doc->width, h / doc->height);
        Tvg_Matrix matrix{scale, 0, (w-doc->width*scale)/2, 0, scale, (h-doc->height*scale)/2, 0, 0, 1};
        if (tvg_swcanvas_set_target(doc->canvas, pixels.data(), w, w, h, TVG_COLORSPACE_ABGR8888S) != TVG_RESULT_SUCCESS ||
            tvg_paint_set_transform(doc->picture, &matrix) != TVG_RESULT_SUCCESS ||
            tvg_canvas_update(doc->canvas) != TVG_RESULT_SUCCESS ||
            tvg_canvas_draw(doc->canvas, true) != TVG_RESULT_SUCCESS ||
            tvg_canvas_sync(doc->canvas) != TVG_RESULT_SUCCESS) return PURRVECT_RENDER_ERROR;
        for (size_t i = 0; i < pixels.size(); ++i) {
            out[i*4] = static_cast<uint8_t>(pixels[i]);
            out[i*4+1] = static_cast<uint8_t>(pixels[i] >> 8);
            out[i*4+2] = static_cast<uint8_t>(pixels[i] >> 16);
            out[i*4+3] = static_cast<uint8_t>(pixels[i] >> 24);
        }
        return PURRVECT_OK;
    } catch (const std::bad_alloc &) { return PURRVECT_OUT_OF_MEMORY; }
      catch (...) { return PURRVECT_RENDER_ERROR; }
}
