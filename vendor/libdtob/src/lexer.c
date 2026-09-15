#include "dtob_internal.h"

void lexer_init(Lexer *l, const uint8_t *buf, size_t len)
{
    l->buf = buf;
    l->len = len;
    l->pos = 0;
    l->error = 0;
}

#if USE_NEON_OPTIMIZATION
static inline void dtob_advance_gen(Lexer *l, uint8_t applied_mask) {
    DTOB_SIMD_SCAN(l,
        vceqq_u8(vandq_u8(data, vdupq_n_u8(applied_mask)), vdupq_n_u8(applied_mask)),
        ((l->buf[l->pos] & applied_mask) == applied_mask)
    );
}
#endif

/*
// 2. Nibble Prefix Function
static inline void dtob_advance_nibble(Lexer *l, uint8_t prefix) {
    DTOB_SIMD_SCAN(l,
        vceqq_u8(vandq_u8(data, vdupq_n_u8(0xF0)), vdupq_n_u8(prefix)),
        ((l->buf[l->pos] & 0xF0) == prefix)
    );
}

// 3. Exact 16-bit Match Function
static inline void dtob_advance_word(Lexer *l, uint16_t target) {
    DTOB_SIMD_SCAN(l,
        vceqq_u16(vreinterpretq_u16_u8(data), vdupq_n_u16(target)),
        (*(uint16_t*)&l->buf[l->pos] == target)
    );
}
*/

/* Read trit-encoded data starting at current position.
 * Stream is word-aligned: only check DTOB_IS_CTRL at even positions.
 * Padding detection is handled by trit_decode_padded. */
static void read_data(Lexer *l, uint8_t **out, size_t *out_len)
{
    size_t start = l->pos;

    /* advance in 2-byte words; stop when next word is a control word */

    #if USE_NEON_OPTIMIZATION
    dtob_advance_gen(l, 0xC0);
    #else
    while (l->pos + 1 < l->len && !DTOB_IS_CTRL(l->buf[l->pos])) {
        l->pos += 2;
    }
    #endif

    size_t raw_len = l->pos - start;
    if (raw_len == 0) {
        *out = NULL;
        *out_len = 0;
        return;
    }

    uint8_t *decoded = NULL;
    size_t decoded_len = trit_decode_padded(l->buf + start, raw_len, &decoded);

    if (!decoded) {
        fprintf(stderr, "dtob: trit decode error\n");
        l->error = 1;
        *out = NULL; *out_len = 0;
        return;
    }

    *out = decoded;
    *out_len = decoded_len;
}

int lexer_done(Lexer *l)
{
    return l->pos >= l->len;
}

Token lexer_next(Lexer *l)
{
    Token tok = { 0, NULL, 0 };

top:
    if (l->pos >= l->len) {
        fprintf(stderr, "dtob: unexpected end of input\n");
        l->error = 1;
        return tok;
    }

    uint8_t b = l->buf[l->pos];

    /* control word: top two bits of first byte are 11 */
    if (DTOB_IS_CTRL(b)) {
        l->pos++;
        if (l->pos >= l->len) {
            fprintf(stderr, "dtob: truncated control word\n");
            l->error = 1;
            return tok;
        }
        uint8_t b2 = l->buf[l->pos];
        l->pos++;
        /* bit 5 of the high byte is the reserved 0 of the "110" prefix */
        if (b & 0x20) {
            fprintf(stderr, "dtob: reserved control bit set\n");
            l->error = 1;
            return tok;
        }
        uint16_t code = ((uint16_t)(b & 0x1F) << 8) | b2;

        /* blast: silently skip */
        if (code == DTOB_BLAST) goto top;

        tok.type = code;

        /* codes that carry a data payload: read it now */
        if (code == DTOB_RAW || code == DTOB_FLOAT || code == DTOB_DOUBLE ||
            DTOB_IS_INT(code) || code >= DTOB_CUSTOM_MIN) {
            read_data(l, &tok.data, &tok.data_len);
        }

        return tok;
    }

    /* bare data without a preceding code */
    fprintf(stderr, "dtob: unexpected data without code\n");
    l->error = 1;
    return tok;
}
