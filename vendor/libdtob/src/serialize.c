#include "dtob_internal.h"
#include <string.h>
#include <stdio.h>

/* ------------------------------------------------------------------ */
/*  Byte writer                                                       */
/* ------------------------------------------------------------------ */

void dtob_writer_init(DtobWriter *w, int strict_validation)
{
    w->cap = 256;
    w->buf = malloc(w->cap);
    if (!w->buf) { w->cap = 0; }
    w->pos = 0;
    w->error = 0;
    w->strict_validation = strict_validation;
}

static void dw_realloc(DtobWriter *w, size_t needed);

void dtob_writer_byte(DtobWriter *w, uint8_t b) {
    dw_realloc(w, w->pos + 1);
    if (!w->error) w->buf[w->pos++] = b;
}

static void dw_realloc(DtobWriter *w, size_t needed) {
    if (needed > w->cap) {
        size_t new_cap = w->cap == 0 ? 256 : w->cap;
        while (new_cap < needed) {
            new_cap *= 2;
        }

        uint8_t *tmp = realloc(w->buf, new_cap);
        if (!tmp) {
            w->error = 1;
            return;
        }
        w->buf = tmp;
        w->cap = new_cap;
    }
}

void dtob_writer_ctrl(DtobWriter *w, uint16_t code)
{
    dtob_writer_byte(w, 0xC0 | ((code >> 8) & 0x1F));
    dtob_writer_byte(w, code & 0xFF);
}

void dtob_writer_data(DtobWriter *w, const uint8_t *bytes, size_t len)
{
    if (len == 0) return;

    uint8_t *encoded = NULL;
    size_t enc_len = trit_encode_padded(bytes, len, &encoded);

    if (!encoded) {
        w->error = 1;
        return;
    }

    dw_realloc(w, w->pos + enc_len);

    if (w->error) { free(encoded); return; }
    memcpy(w->buf + w->pos, encoded, enc_len);
    w->pos += enc_len;
    free(encoded);
}

/* ------------------------------------------------------------------ */
/*  Encode types header                                               */
/* ------------------------------------------------------------------ */

static void encode_types_header(DtobWriter *w, const DtobTypesHeader *th)
{
    if (!th || th->count == 0) return;

    dtob_writer_ctrl(w, DTOB_OPEN_TYPES);
    for (size_t i = 0; i < th->count; i++) {
        dtob_writer_ctrl(w, th->entries[i].kind == DTOB_STRUCT ? DTOB_OPEN_ARR : DTOB_OPEN_KV);
        dtob_writer_ctrl(w, th->entries[i].code);
        dtob_writer_data(w, (const uint8_t *)th->entries[i].name,
                      strlen(th->entries[i].name));
        for (size_t j = 0; j < th->entries[i].num_codes; j++)
            dtob_writer_ctrl(w, th->entries[i].codes[j]);
        dtob_writer_ctrl(w, DTOB_CLOSE);
    }
    dtob_writer_ctrl(w, DTOB_CLOSE);
}

/* ------------------------------------------------------------------ */
/*  Encode value                                                      */
/* ------------------------------------------------------------------ */

static void encode_value_t(DtobWriter *w, const DtobValue *v,
                            const DtobTypesHeader *types)
{
    if (!v) return;
    uint16_t code = v->code;

    /* collection: kv_set or array */
    if (code == DTOB_OPEN_KV) {
        dtob_writer_ctrl(w, DTOB_OPEN_KV);
        for (size_t i = 0; i < v->num_elements; i++) {
            struct DtobDataTagged *el = &v->elements[i];
            if (el->kind == DTOB_KV) {
                dtob_writer_ctrl(w, DTOB_RAW);
                dtob_writer_data(w, el->data.kv.key, el->data.kv.key_len);
                encode_value_t(w, el->data.kv.value, types);
            } else {
                encode_value_t(w, el->data.val, types);
            }
        }
        dtob_writer_ctrl(w, DTOB_CLOSE);
        return;
    }

    if (code == DTOB_OPEN_ARR) {
        dtob_writer_ctrl(w, DTOB_OPEN_ARR);
        for (size_t i = 0; i < v->num_elements; i++)
            encode_value_t(w, v->elements[i].data.val, types);
        dtob_writer_ctrl(w, DTOB_CLOSE);
        return;
    }

    /* integer types */
    if (DTOB_IS_INT(code)) {
        int width = DTOB_INT_WIDTH(code);

        int is_unsigned = DTOB_INT_UNSIGNED(code);
        uint8_t fill = (!is_unsigned && v->data_len > 0 && (v->data[0] & 0x80)) ? 0xFF : 0x00;

        uint8_t buf[8];
        int pad = width - (int)v->data_len;
        if (pad > 0) { memset(buf, fill, pad); memcpy(buf + pad, v->data, v->data_len); }
        else memcpy(buf, v->data, width);

        dtob_writer_ctrl(w, code);
        dtob_writer_data(w, buf, width);
        return;
    }

    /* primitive data (raw, float, double) */
    if (code == DTOB_RAW || code == DTOB_FLOAT || code == DTOB_DOUBLE) {
        dtob_writer_ctrl(w, code);
        dtob_writer_data(w, v->data, v->data_len);
        return;
    }

    /* custom types (16+) */
    if (code >= DTOB_CUSTOM_MIN) {
        DtobCustomType *ct = types ? dtob_types_get(types, code) : NULL;
        if (types && !ct) {
            if (w->strict_validation) {
                fprintf(stderr, "dtob FATAL: Custom type code %u is not registered in the provided Types Header!\n", code);
                w->error = 1;
                return;
            }
        }
        if (ct && w->strict_validation) {
            if (ct->kind == DTOB_STRUCT && v->num_elements != ct->num_codes) {
                fprintf(stderr, "dtob FATAL: Struct type %u expects %zu elements but got %zu!\n", code, ct->num_codes, v->num_elements);
                w->error = 1;
                return;
            } else if (ct->kind != DTOB_STRUCT && ct->num_codes > 1) {
                int valid_enum = 0;
                for (size_t i = 0; i < ct->num_codes; i++) {
                    if (v->member_code == ct->codes[i]) { valid_enum = 1; break; }
                }
                if (!valid_enum) {
                    fprintf(stderr, "dtob FATAL: Enum inner code %u is invalid for custom type %u!\n", v->member_code, code);
                    w->error = 1;
                    return;
                }
            }
        }
        dtob_writer_ctrl(w, code);
        if (ct && ct->kind == DTOB_STRUCT) {
            dtob_writer_ctrl(w, DTOB_OPEN_ARR);
            for (size_t i = 0; i < v->num_elements; i++)
                encode_value_t(w, v->elements[i].data.val, types);
            dtob_writer_ctrl(w, DTOB_CLOSE);
        } else if (ct && ct->num_codes == 0) {
            /* nullable */
        } else if (ct && ct->num_codes == 1) {
            if (v->data && v->data_len > 0)
                dtob_writer_data(w, v->data, v->data_len);
        } else if (ct && ct->num_codes > 1) {
            if (v->member_code) {
                dtob_writer_ctrl(w, v->member_code);
                DtobCustomType *inner_ct = types ? dtob_types_get(types, v->member_code) : NULL;
                if (inner_ct && inner_ct->kind == DTOB_STRUCT && v->num_elements > 0) {
                    dtob_writer_ctrl(w, DTOB_OPEN_ARR);
                    for (size_t i = 0; i < v->num_elements; i++)
                        encode_value_t(w, v->elements[i].data.val, types);
                    dtob_writer_ctrl(w, DTOB_CLOSE);
                } else if (v->data && v->data_len > 0) {
                    dtob_writer_data(w, v->data, v->data_len);
                }
            } else if (v->data && v->data_len > 0) {
                dtob_writer_data(w, v->data, v->data_len);
            }
        } else {
            if (v->data && v->data_len > 0)
                dtob_writer_data(w, v->data, v->data_len);
        }
        return;
    }
}

/* --- Public encode API --- */

uint8_t *dtob_encode(const DtobValue *root, size_t *out_len)
{
    return dtob_encode_with_types(root, NULL, 0, out_len);
}

uint8_t *dtob_encode_with_types(const DtobValue *root,
                                 const DtobTypesHeader *types,
                                 int strict_validation,
                                 size_t *out_len)
{
    DtobWriter w;
    dtob_writer_init(&w, strict_validation);

    /* magic number */
    for (int i = 0; i < DTOB_MAGIC_LEN; i++)
        dtob_writer_byte(&w, (uint8_t)DTOB_MAGIC[i]);

    if (types && types->count > 0)
        encode_types_header(&w, types);
    encode_value_t(&w, root, types);

    if (w.error) {
        free(w.buf);
        *out_len = 0;
        return NULL;
    }

    *out_len = w.pos;
    return w.buf;
}

uint8_t *dtob_encode_chunk(const DtobValue *v,
                           const DtobTypesHeader *types,
                           int strict_validation,
                           size_t *out_len)
{
    DtobWriter w;
    dtob_writer_init(&w, strict_validation);
    encode_value_t(&w, v, types);

    if (w.error) {
        free(w.buf);
        *out_len = 0;
        return NULL;
    }

    *out_len = w.pos;
    return w.buf;
}

uint8_t *dtob_encode_typed(DtobValue *root, DtobTypesBuilder build_types, size_t *out_len) {
    DtobTypesHeader types;
    build_types(&types);

    // Call the internal encoder (strict validation = 1)
    uint8_t *enc = dtob_encode_with_types(root, &types, 1, out_len);

    dtob_types_cleanup(&types);
    dtob_free(root); // Auto-consume the AST
    return enc;
}

size_t dtob_types_encoded_size(const DtobTypesHeader *th) {
    DtobWriter w;
    dtob_writer_init(&w, 0);
    encode_types_header(&w, th);
    size_t sz = w.pos;
    free(w.buf);
    return sz;
}
size_t dtob_value_encoded_size(DtobValue *dv, DtobTypesHeader *th) {
    DtobWriter w;
    dtob_writer_init(&w, 0);
    /* static void encode_value_t(DtobWriter *w, const DtobValue *v,
                            const DtobTypesHeader *types) */
    encode_value_t(&w, dv, th);
    size_t sz = w.pos;
    free(w.buf);
    return sz;
}
