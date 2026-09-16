#include "dtob_internal.h"

DtobValue *ast_make(uint16_t code)
{
    DtobValue *v = calloc(1, sizeof(DtobValue));
    if (v) v->code = code;
    return v;
}

void ast_add_element(DtobValue *arr, DtobValue *element)
{
    arr->elements = realloc(arr->elements,
                            (arr->num_elements + 1) * sizeof(struct DtobDataTagged));
    arr->elements[arr->num_elements].data.val = element;
    arr->elements[arr->num_elements].kind = 0;
    arr->num_elements++;
}

void ast_add_pair(DtobValue *kvs, uint8_t *key, size_t key_len,
                  DtobValue *val)
{
    if (key_len > 128) return;
    kvs->elements = realloc(kvs->elements,
                            (kvs->num_elements + 1) * sizeof(struct DtobDataTagged));
    struct DtobDataTagged *t = &kvs->elements[kvs->num_elements];
    t->kind = DTOB_KV;
    t->data.kv.key = malloc(key_len + 1);
    memcpy(t->data.kv.key, key, key_len);
    t->data.kv.key[key_len] = '\0';
    t->data.kv.key_len = key_len;
    t->data.kv.value = val;
    kvs->num_elements++;
}

/* --- Public constructors --- */

DtobValue *dtob_int(int64_t val)
{
    DtobValue *v = ast_make(DTOB_INT64);
    if (!v) return NULL;
    /* store as big-endian bytes, trimmed to minimum width */
    uint8_t buf[8];
    uint64_t uval = (uint64_t)val;
    for (int i = 7; i >= 0; i--) {
        buf[i] = uval & 0xFF;
        uval >>= 8;
    }
    /* find first significant byte (keep at least 1) */
    int start = 0;
    if (val >= 0) {
        while (start < 7 && buf[start] == 0x00) start++;
    } else {
        while (start < 7 && buf[start] == 0xFF
               && (buf[start + 1] & 0x80)) start++;
    }
    size_t len = 8 - start;
    v->data = malloc(len);
    memcpy(v->data, buf + start, len);
    v->data_len = len;
    return v;
}

DtobValue *dtob_uint(uint64_t val)
{
    DtobValue *v = ast_make(DTOB_UINT64);
    if (!v) return NULL;
    /* store as big-endian bytes, trimmed, with leading 0x00 if top bit set */
    uint8_t buf[9];
    buf[0] = 0x00;
    for (int i = 8; i >= 1; i--) {
        buf[i] = val & 0xFF;
        val >>= 8;
    }
    int start = 0;
    while (start < 8 && buf[start] == 0x00 && !(buf[start + 1] & 0x80))
        start++;
    size_t len = 9 - start;
    v->data = malloc(len);
    memcpy(v->data, buf + start, len);
    v->data_len = len;
    return v;
}

DtobValue *dtob_float(float val)
{
    DtobValue *v = ast_make(DTOB_FLOAT);
    if (!v) return NULL;
    v->data = malloc(4);
    memcpy(v->data, &val, 4);
    v->data_len = 4;
    return v;
}

DtobValue *dtob_double(double val)
{
    DtobValue *v = ast_make(DTOB_DOUBLE);
    if (!v) return NULL;
    v->data = malloc(8);
    memcpy(v->data, &val, 8);
    v->data_len = 8;
    return v;
}

DtobValue *dtob_raw(const uint8_t *data, size_t len)
{
    DtobValue *v = ast_make(DTOB_RAW);
    if (!v) return NULL;
    v->data = malloc(len);
    memcpy(v->data, data, len);
    v->data_len = len;
    return v;
}

DtobValue *dtob_array(void) { return ast_make(DTOB_OPEN_ARR); }
DtobValue *dtob_kvset(void) { return ast_make(DTOB_OPEN_KV); }

void dtob_array_push(DtobValue *arr, DtobValue *val) { ast_add_element(arr, val); }
void dtob_kvset_put(DtobValue *kvs, const char *key, DtobValue *val) { ast_add_pair(kvs, (uint8_t *)key, strlen(key), val); }

/* --- value accessors --- */

int64_t dtob_val_to_i64(const DtobValue *v)
{
    if (!v || !DTOB_IS_INT(v->code) || !v->data || v->data_len == 0) return 0;
    int64_t val = (v->data[0] & 0x80) ? -1 : 0;
    for (size_t i = 0; i < v->data_len; i++)
        val = (val << 8) | v->data[i];
    return val;
}

uint64_t dtob_val_to_u64(const DtobValue *v)
{
    if (!v || !DTOB_IS_INT(v->code) || !v->data || v->data_len == 0) return 0;
    uint64_t val = 0;
    for (size_t i = 0; i < v->data_len; i++)
        val = (val << 8) | v->data[i];
    return val;
}

size_t dtob_val_to_str(const DtobValue *v, char *out, size_t outsz)
{
    if (!v || !v->data || outsz == 0) { if (outsz) out[0] = '\0'; return 0; }
    size_t copy = v->data_len < outsz - 1 ? v->data_len : outsz - 1;
    memcpy(out, v->data, copy);
    out[copy] = '\0';
    return copy;
}

/* --- KV-set accessors --- */

DtobValue *dtob_kvset_get(const DtobValue *kvs, const char *key)
{
    if (!kvs || kvs->num_elements == 0) return NULL;
    size_t klen = strlen(key);
    for (size_t i = 0; i < kvs->num_elements; i++) {
        struct DtobDataTagged *el = &kvs->elements[i];
        if (el->kind == DTOB_KV && el->data.kv.key_len == klen &&
            memcmp(el->data.kv.key, key, klen) == 0)
            return el->data.kv.value;
    }
    return NULL;
}

int64_t dtob_kvset_int(const DtobValue *kvs, const char *key)
{
    DtobValue *v = dtob_kvset_get(kvs, key);
    return dtob_val_to_i64(v);
}

uint64_t dtob_kvset_uint(const DtobValue *kvs, const char *key)
{
    DtobValue *v = dtob_kvset_get(kvs, key);
    return dtob_val_to_u64(v);
}

double dtob_kvset_float(const DtobValue *kvs, const char *key)
{
    DtobValue *v = dtob_kvset_get(kvs, key);
    if (!v || (v->code != DTOB_FLOAT && v->code != DTOB_DOUBLE) || !v->data) return 0.0;
    if (v->data_len == 4) {
        float f; memcpy(&f, v->data, 4); return (double)f;
    }
    if (v->data_len == 8) {
        double d; memcpy(&d, v->data, 8); return d;
    }
    return 0.0;
}

size_t dtob_kvset_str(const DtobValue *kvs, const char *key,
                      char *out, size_t outsz)
{
    DtobValue *v = dtob_kvset_get(kvs, key);
    if (!v || v->code != DTOB_RAW || !v->data) { if (outsz) out[0] = '\0'; return 0; }
    size_t copy = v->data_len < outsz - 1 ? v->data_len : outsz - 1;
    memcpy(out, v->data, copy);
    out[copy] = '\0';
    return copy;
}

const uint8_t *dtob_kvset_raw(const DtobValue *kvs, const char *key,
                              size_t *out_len)
{
    DtobValue *v = dtob_kvset_get(kvs, key);
    if (!v || v->code != DTOB_RAW || !v->data) { if (out_len) *out_len = 0; return NULL; }
    if (out_len) *out_len = v->data_len;
    return v->data;
}

/* --- Free --- */

void dtob_free(DtobValue *v)
{
    if (!v) return;
    free(v->data);
    for (size_t i = 0; i < v->num_elements; i++) {
        if (v->elements[i].kind == DTOB_KV) {
            free(v->elements[i].data.kv.key);
            dtob_free(v->elements[i].data.kv.value);
        } else {
            dtob_free(v->elements[i].data.val);
        }
    }
    free(v->elements);
    free(v);
}

/* --- Custom type constructor --- */

DtobValue *dtob_custom(uint16_t code, const uint8_t *data, size_t len)
{
    DtobValue *v = ast_make(code);
    if (!v) return NULL;
    if (data && len > 0) {
        v->data = malloc(len);
        memcpy(v->data, data, len);
        v->data_len = len;
    }
    return v;
}

DtobValue *dtob_custom_nullable(uint16_t code)
{
    return dtob_custom(code, NULL, 0);
}

/* --- Types header --- */

void dtob_types_init(DtobTypesHeader *th)
{
    th->cap = 16;
    th->entries = calloc(th->cap, sizeof(DtobCustomType));
    th->count = 0;
}

void dtob_types_cleanup(DtobTypesHeader *th)
{
    for (size_t i = 0; i < th->count; i++) {
        free(th->entries[i].codes);
    }
    free(th->entries);
    th->entries = NULL;
    th->count = th->cap = 0;
}

int dtob_types_add(DtobTypesHeader *th, uint16_t code, const char *name,
                    const uint16_t *codes, size_t n_codes)
{
    if (n_codes + 1 > DTOB_CUSTOM_COUNT) {
        fprintf(stderr, "Error: too many member codes (%zu)\n", n_codes);
        return -1;
    }

    if (th->count >= th->cap) {
        th->cap = (th->cap * 2 < DTOB_CUSTOM_COUNT) ? th->cap * 2 : DTOB_CUSTOM_COUNT;
        th->entries = realloc(th->entries, th->cap * sizeof(DtobCustomType));
    }
    DtobCustomType *e = &th->entries[th->count];
    e->code = code;
    strncpy(e->name, name, 129);
    e->name[128] = '\0';
    e->num_codes = n_codes;
    e->kind = DTOB_ENUM;
    if (codes && n_codes > 0) {
        e->codes = malloc(n_codes * sizeof(uint16_t));
        memcpy(e->codes, codes, n_codes * sizeof(uint16_t));
    } else {
        e->codes = NULL;
    }
    th->count++;
    return 0;
}

DtobCustomType *dtob_types_get(const DtobTypesHeader *th, uint16_t code)
{
    if (!th) return NULL;
    for (size_t i = 0; i < th->count; i++) {
        if (th->entries[i].code == code)
            return (DtobCustomType *)&th->entries[i];
    }
    return NULL;
}

int dtob_code_data_size(uint16_t code)
{
    if (code >= 8 && code <= 15)
        return 1 << (code & 3); /* 1, 2, 4, 8 */
    if (code == DTOB_FLOAT) return 4;
    if (code == DTOB_DOUBLE) return 8;
    if (code >= DTOB_CUSTOM_MIN) return -2; /* custom: caller must check types */
    return -1; /* raw, string = variable */
}
