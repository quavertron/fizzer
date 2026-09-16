#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define BLK_SIZE   16
#define MIN_MATCH  BLK_SIZE

#define HASH_M 31U
#define HASH_C 0xe191dddfU  /* 31^15 mod 2^32 */

static inline uint32_t poly_hash16(const uint8_t *buf) {
    uint32_t h = 0;
    for (int i = 0; i < 16; i++) {
        h = h * HASH_M + buf[i];
    }
    return h;
}

static unsigned hashbits(unsigned n) {
    unsigned val = 1, bits = 0;
    while (val < n) { val <<= 1; bits++; }
    return bits ? bits : 1;
}

static inline uint32_t hash_to_idx(uint32_t h, unsigned bits) {
    /* Multiplicative golden-ratio hash distribution */
    return (uint32_t)((h * 0x9e3779b9U) >> (32 - bits));
}

/*
 * Flat-array cache-aligned block index (zero pointer chasing, zero malloc-per-block)
 */
typedef struct {
    uint32_t *head;   /* size: (1 << bits) */
    uint32_t *chain;  /* size: nblocks + 1 */
    uint32_t *fps;    /* size: nblocks + 1 */
    unsigned bits;
    size_t nblocks;
} diff_index_t;

static diff_index_t *build_index(const uint8_t *old_data, size_t old_len) {
    if (old_len < BLK_SIZE) return NULL;
    diff_index_t *idx = malloc(sizeof(diff_index_t));
    if (!idx) return NULL;

    size_t nblocks = old_len / BLK_SIZE;
    unsigned fphbits = hashbits((unsigned)nblocks + 1);
    if (fphbits < 8) fphbits = 8;
    if (fphbits > 20) fphbits = 20;
    size_t hsize = (size_t)1 << fphbits;

    idx->bits = fphbits;
    idx->nblocks = nblocks;
    idx->head = calloc(hsize, sizeof(uint32_t));
    idx->chain = malloc((nblocks + 1) * sizeof(uint32_t));
    idx->fps = malloc((nblocks + 1) * sizeof(uint32_t));

    if (!idx->head || !idx->chain || !idx->fps) {
        free(idx->head); free(idx->chain); free(idx->fps); free(idx);
        return NULL;
    }

    for (size_t b = 1; b <= nblocks; b++) {
        size_t off = (b - 1) * BLK_SIZE;
        uint32_t fp = poly_hash16(old_data + off);
        idx->fps[b] = fp;
        uint32_t h_idx = hash_to_idx(fp, fphbits);
        idx->chain[b] = idx->head[h_idx];
        idx->head[h_idx] = (uint32_t)b;
    }
    return idx;
}

static void free_index(diff_index_t *idx) {
    if (!idx) return;
    free(idx->fps);
    free(idx->chain);
    free(idx->head);
    free(idx);
}
