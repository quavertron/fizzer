#ifndef DTOB_INTERNAL_H
#define DTOB_INTERNAL_H

#include "dtob.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

/* ------------------------------------------------------------------ */
/*  Trit codec                                                        */
/* ------------------------------------------------------------------ */

/* Encode bytes to trit pairs (each byte → 6 trits as 00/01/10).
 * Output is padded to byte boundary with 11 pairs.
 * Returns total output BYTES (not trits). Caller frees. */
size_t trit_encode_padded(const uint8_t *bytes, size_t byte_len,
                          uint8_t **out_buf);

/* Decode trit-encoded, byte-padded buffer back to bytes.
 * Stops reading trit pairs when it hits a 11 pair (padding).
 * Returns number of decoded bytes. Caller frees. */
size_t trit_decode_padded(const uint8_t *buf, size_t buf_len,
                          uint8_t **out_bytes);

/* ------------------------------------------------------------------ */
/*  Lexer (byte-aligned)                                              */
/* ------------------------------------------------------------------ */

typedef struct {
    uint16_t   type;          /* DTOB_* code */
    uint8_t   *data;          /* decoded payload (RAW, INT*, FLOAT, DOUBLE, custom) */
    size_t     data_len;
} Token;

typedef struct {
    const uint8_t *buf;
    size_t         len;
    size_t         pos;       /* byte position */
    int            error;
} Lexer;

void  lexer_init(Lexer *l, const uint8_t *buf, size_t len);
int   lexer_done(Lexer *l);
Token lexer_next(Lexer *l);

/* ------------------------------------------------------------------ */
/*  AST helpers                                                       */
/* ------------------------------------------------------------------ */

DtobValue *ast_make(uint16_t type);
void       ast_add_element(DtobValue *arr, DtobValue *el);
void       ast_add_pair(DtobValue *kvs, uint8_t *key, size_t key_len,
                        DtobValue *val);



/* ------------------------------------------------------------------ */
/*  SIMD / NEON                                                       */
/* ------------------------------------------------------------------ */

#ifdef __APPLE__
#include <TargetConditionals.h>
#if TARGET_OS_OSX && defined(__arm64__)
#include <arm_neon.h>
#define USE_NEON_OPTIMIZATION 1
#endif
#endif

#if USE_NEON_OPTIMIZATION

#define DTOB_SIMD_SCAN(l, COND_EXPR, SCALAR_COND) do {                         \
    while ((l)->pos + 15 < (l)->len) {                                         \
        uint8x16_t data = vld1q_u8(&(l)->buf[(l)->pos]);                       \
        uint8x16_t mask_vec = (uint8x16_t)(COND_EXPR);                         \
        uint64_t low = vgetq_lane_u64(vreinterpretq_u64_u8(mask_vec), 0);      \
        uint64_t high = vgetq_lane_u64(vreinterpretq_u64_u8(mask_vec), 1);     \
        low &= 0x00FF00FF00FF00FFULL;                                          \
        high &= 0x00FF00FF00FF00FFULL;                                         \
        if (low) {                                                             \
            (l)->pos += (__builtin_ctzll(low) >> 3);                           \
            return;                                                            \
        }                                                                      \
        if (high) {                                                            \
            (l)->pos += 8 + (__builtin_ctzll(high) >> 3);                      \
            return;                                                            \
        }                                                                      \
        (l)->pos += 16;                                                        \
    }                                                                          \
    while ((l)->pos + 1 < (l)->len && !(SCALAR_COND)) {                        \
        (l)->pos += 2;                                                         \
    }                                                                          \
} while (0)

#endif /* USE_NEON_OPTIMIZATION */

#endif
