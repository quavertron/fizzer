#ifndef PURRVECT_H
#define PURRVECT_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define PURRVECT_MAX_BYTES (4u * 1024u * 1024u)
#define PURRVECT_MAX_DIMENSION 4096u
typedef struct PurrvectDocument PurrvectDocument;
typedef enum PurrvectStatus {
    PURRVECT_OK = 0,
    PURRVECT_INVALID_ARGUMENT = 1,
    PURRVECT_RENDER_ERROR = 2,
    PURRVECT_OUT_OF_MEMORY = 3
} PurrvectStatus;
/* ABI version 1. No C++ types or exceptions cross this interface. */
uint32_t purrvect_abi_version(void);
/* Copies SVG data; caller may release it after return. NULL on failure.
 * Each document owns its engine reference and retained vector geometry. */
PurrvectDocument *purrvect_load(const void *svg, size_t length);
void purrvect_free(PurrvectDocument *document);
PurrvectStatus purrvect_size(const PurrvectDocument *document, float *width, float *height);
/* Caller owns output: exactly width*height*4 bytes, straight sRGB RGBA.
 * Aspect ratio is preserved with transparent margins. Dimensions: 1..4096.
 * Calls are internally serialized; do not free a document during another call.
 * Load/free and buffers stay in their respective allocator domains. */
PurrvectStatus purrvect_render(PurrvectDocument *document, uint32_t width,
    uint32_t height, uint8_t *output, size_t length);
#ifdef __cplusplus
}
#endif
#endif
