#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
/* Keep alock's hardened DTOB revision. Nab's allocation-free decoder API is
 * adapted to that revision without downgrading the shared codec. */
extern size_t trit_decode_padded(const uint8_t *, size_t, uint8_t **);
static size_t trit_decode_into(const uint8_t *data, size_t size, uint8_t *out) {
    uint8_t *decoded = NULL;
    size_t count = trit_decode_padded(data, size, &decoded);
    if (count) memcpy(out, decoded, count);
    free(decoded);
    return count;
}
#define main alock_nab_main
#include "../nab/src/nab.c"
#undef main

void alock_nab_key(const char *file, char out[65]) {
    uint8_t hash[32];
    sha256_hash((const uint8_t *)file, strlen(file), hash);
    for (int i = 0; i < 32; i++) snprintf(out + i * 2, 3, "%02x", hash[i]);
}
