#include <stdbool.h>
#include "dtob_internal.h"

const char *dtob_types_get_name(const DtobTypesHeader *th, uint16_t code)
{
    if (!th) return NULL;
    for (size_t i = 0; i < th->count; i++) {
        if (th->entries[i].code == code)
            return th->entries[i].name;
    }
    return NULL;
}

#define is_struct if(chosen_struct->kind != DTOB_STRUCT) return NULL; \
                  DtobCustomType *get_struct = dtob_types_get(th,chosen_struct->code); \
		  if (!get_struct) return NULL; /* you didn't give a valid struct */ \

#define dgsvfc(search_code) \
    if (!dtob_types_get(th, search_code)) return NULL; \
    bool in_schema = false; \
    for (size_t i = 0; i < get_struct->num_codes; i++) { \
        if (get_struct->codes[i] == search_code) { in_schema = true; break; } \
    } \
    if (!in_schema) return NULL; \
    for (size_t i = 0; i < chosen_struct->num_elements; i++) { \
        if (chosen_struct->elements[i].data.val->code == search_code) { \
            return chosen_struct->elements[i].data.val; \
        } \
    } \
    return NULL;

DtobValue * dtob_get_struct_val_from_code(const DtobTypesHeader *th,
		const DtobValue *chosen_struct, uint16_t code) {
	is_struct;
	dgsvfc(code);
}

DtobValue * dtob_get_struct_val_from_name(const DtobTypesHeader *th,
		const DtobValue *chosen_struct, const char *name) {
        is_struct;
	uint16_t code;
	bool name_flag = true;
	for (size_t i=0;i<th->count;i++) {
	    if (strncmp(th->entries[i].name, name,129) == 0) {
                code = th->entries[i].code;
		name_flag=false;
		break;
	    }
	}
	if (name_flag) return NULL;
	dgsvfc(code);
	//return dtob_get_struct_val_from_code(th,chosen_struct,mod_in_place,code);
}

DtobValue *dtob_deep_copy(const DtobValue *v)
{
    if (!v) return NULL;
    DtobValue *c = ast_make(v->code);
    if (!c) return NULL;
    c->member_code = v->member_code;
    if (v->data && v->data_len > 0) {
        c->data = malloc(v->data_len);
        if (!c->data) { free(c); return NULL; }
        memcpy(c->data, v->data, v->data_len);
        c->data_len = v->data_len;
    }
    c->kind = v->kind;
    for (size_t i = 0; i < v->num_elements; i++) {
        if (v->elements[i].kind == DTOB_KV) {
            DtobValue *vc = dtob_deep_copy(v->elements[i].data.kv.value);
            ast_add_pair(c, v->elements[i].data.kv.key,
                         v->elements[i].data.kv.key_len, vc);
        } else {
            ast_add_element(c, dtob_deep_copy(v->elements[i].data.val));
        }
    }
    return c;
}

/* Returns the byte position of the first token matching opcode, or 0 on failure.
 * 0 is a safe sentinel because byte 0 is always part of the DTOB magic header. */
__attribute__((unused))
static uint64_t find_opcode_pos(const uint8_t *buf, size_t len, uint16_t opcode)
{
    Lexer l;
    lexer_init(&l, buf, len);
    while (!lexer_done(&l)) {
        size_t pos = l.pos;
        Token t = lexer_next(&l);
        if (t.type == opcode) {
            free(t.data);
            return (uint64_t)pos;
        }
        free(t.data);
    }
    return 0;
}

/* Walks the buffer from start_pos tracking nesting depth via SIMD-accelerated
 * control-word scanning. start_pos must be the high byte of a control-code word
 * (exception: position 8 may be open_types, right after magic).
 * depth_offset sets the initial depth. Returns byte position of the CLOSE that
 * brings depth to 0, or 0 on error/not found.
 * 0 is safe as a sentinel because byte 0 is always part of the DTOB magic. */
__attribute__((unused))
static uint64_t track_close(const uint8_t *buf, size_t len, size_t start_pos, int depth_offset)
{
    if (start_pos >= len || !DTOB_IS_CTRL(buf[start_pos]))
        return 0;

    int depth = depth_offset;
    size_t pos = start_pos;

#if USE_NEON_OPTIMIZATION
    static const uint8_t emask[16] = {
        0xFF,0,0xFF,0,0xFF,0,0xFF,0,
        0xFF,0,0xFF,0,0xFF,0,0xFF,0
    };
    uint8x16_t even_mask = vld1q_u8(emask);
    uint8x16_t ctrl_bits = vdupq_n_u8(0xC0);

    while (pos + 15 < len) {
        uint8x16_t data = vld1q_u8(&buf[pos]);
        uint8x16_t masked = vandq_u8(data, ctrl_bits);
        uint8x16_t hits = vceqq_u8(masked, ctrl_bits);
        hits = vandq_u8(hits, even_mask);

        uint64_t lo = vgetq_lane_u64(vreinterpretq_u64_u8(hits), 0);
        uint64_t hi = vgetq_lane_u64(vreinterpretq_u64_u8(hits), 1);

        if (__builtin_expect((lo | hi) != 0, 0)) {
            for (size_t i = 0; i < 16 && pos + i + 1 < len; i += 2) {
                if ((buf[pos + i] & 0xC0) == 0xC0) {
                    uint16_t code = ((buf[pos+i] & 0x1F) << 8) | buf[pos+i+1];
                    if (DTOB_IS_OPEN(code))
                        depth++;
                    else if (code == DTOB_CLOSE) {
                        if (--depth == 0) return (uint64_t)(pos + i);
                    }
                }
            }
        }
        pos += 16;
    }
#endif
    /* scalar tail */
    while (pos + 1 < len) {
        if (DTOB_IS_CTRL(buf[pos])) {
            uint16_t code = ((buf[pos] & 0x1F) << 8) | buf[pos + 1];
            if (DTOB_IS_OPEN(code))
                depth++;
            else if (code == DTOB_CLOSE) {
                if (--depth == 0) return (uint64_t)pos;
            }
        }
        pos += 2;
    }
    return 0;
}

// file handling

int dtob_array_append_to_file(const char *path, DtobValue *entry) {
    size_t el_len;
    uint8_t *el_buf = dtob_encode_chunk(entry, NULL, 0, &el_len);
    if (!el_buf) return 1;

    FILE *f = fopen(path, "rb+");
    if (!f) {
        f = fopen(path, "wb");
        if (!f) { free(el_buf); return 1; }
        uint8_t head[10] = {0};
        memcpy(head, DTOB_MAGIC, 8);
        head[8] = 0xC0; head[9] = DTOB_OPEN_ARR;
        fwrite(head, 1, 10, f);
        fwrite(el_buf, 1, el_len, f);
        uint8_t tail[2] = {0xC0, DTOB_CLOSE};
        fwrite(tail, 1, 2, f);
        fclose(f);
        free(el_buf);
        return 0;
    }

    fseek(f, -2, SEEK_END);
    fwrite(el_buf, 1, el_len, f);
    uint8_t tail[2] = {0xC0, DTOB_CLOSE};
    fwrite(tail, 1, 2, f);
    fclose(f);
    free(el_buf);
    return 0;
}

int dtob_write_file(const char *path, DtobValue *root,
                    DtobTypesBuilder build_types)
{
    DtobTypesHeader types;
    build_types(&types);

    size_t out_len = 0;
    uint8_t *enc = dtob_encode_with_types(root, &types, 1, &out_len);
    dtob_types_cleanup(&types);
    dtob_free(root);

    if (!enc || out_len == 0) { free(enc); return -1; }

    FILE *fp = fopen(path, "wb");
    if (!fp) { free(enc); return -1; }
    fwrite(enc, 1, out_len, fp);
    fclose(fp);
    free(enc);
    return 0;
}


#include <stdint.h>

// Internal helpers to keep the macro clean
static uint64_t _dtob_to_u64(const uint8_t *b, size_t l) {
    uint64_t v = 0;
    for (size_t i = 0; i < l && i < 8; i++) v = (v << 8) | b[i];
    return v;
}

static int64_t _dtob_to_i64(const uint8_t *b, size_t l) {
    uint64_t v = _dtob_to_u64(b, l);
    if (l < 8 && l > 0 && (v >> (l * 8 - 1)) & 1) v |= (~0ULL << (l * 8));
    return (int64_t)v;
}

/* The Generator Macro */
#define DEFINE_DTOB_GETTER(type, prefix, dtob_enum, conv_func) \
type dtob_get_##prefix(const DtobValue *v) {                   \
    if (!v || v->code != dtob_enum) return 0;                  \
    return (type)conv_func(v->data, v->data_len);              \
}

// Generate Unsigned Getters
DEFINE_DTOB_GETTER(uint8_t,  u8,  DTOB_UINT8,  _dtob_to_u64)
DEFINE_DTOB_GETTER(uint16_t, u16, DTOB_UINT16, _dtob_to_u64)
DEFINE_DTOB_GETTER(uint32_t, u32, DTOB_UINT32, _dtob_to_u64)
DEFINE_DTOB_GETTER(uint64_t, u64, DTOB_UINT64, _dtob_to_u64)

// Generate Signed Getters
DEFINE_DTOB_GETTER(int8_t,   i8,  DTOB_INT8,   _dtob_to_i64)
DEFINE_DTOB_GETTER(int16_t,  i16, DTOB_INT16,  _dtob_to_i64)
DEFINE_DTOB_GETTER(int32_t,  i32, DTOB_INT32,  _dtob_to_i64)
DEFINE_DTOB_GETTER(int64_t,  i64, DTOB_INT64,  _dtob_to_i64)

#undef DEFINE_DTOB_GETTER
