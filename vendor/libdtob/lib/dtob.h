#ifndef DTOB_H
#define DTOB_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * DTOB — Delineated Trinary Over Binary (byte-aligned)
 *
 * Control words: 2 bytes — 110XXXXX XXXXXXXX (0xC0 | code>>8, code&0xFF)
 * Bit 5 of high byte is reserved (must be 0).
 * 13-bit code space = 8192 codes.
 * Data trit pairs: 00, 01, 10 — padded to byte boundary with 11 pairs
 * Every element starts on a byte boundary.
 *
 * Codes 0-7 (core):
 *   0  open_arr    1  open_kv     2  open_types   3  close
 *   4  uqt         5  raw         6  float        7  double
 *
 * Integer codes 8-15: bit 2 = unsigned flag, bits 0-1 = width index
 *   (code & 4) => unsigned, (code & 3) => 0=8b 1=16b 2=32b 3=64b
 *
 * Multi-byte integers and floats are stored little-endian.
 *
 * Codes 16-8190: custom (defined in types header)
 * Code 8191: blast — ignored as a non-token; forbidden for type assignment
 */

/* logical code constants (passed to bw_write_ctrl / dtob_writer_ctrl) */
#define DTOB_OPEN_TYPES  0
#define DTOB_OPEN_ARR    1
#define DTOB_OPEN_KV     2
#define DTOB_CLOSE       3
#define DTOB_UQT         4
#define DTOB_RAW         5
#define DTOB_FLOAT       6
#define DTOB_DOUBLE      7
#define DTOB_INT8        8
#define DTOB_INT16       9
#define DTOB_INT32       10
#define DTOB_INT64       11
#define DTOB_UINT8       12
#define DTOB_UINT16      13
#define DTOB_UINT32      14
#define DTOB_UINT64      15
#define DTOB_BLAST       8191

#define DTOB_CUSTOM_MIN       16
#define DTOB_CUSTOM_MAX       8190
#define DTOB_CUSTOM_COUNT     (DTOB_CUSTOM_MAX - DTOB_CUSTOM_MIN)

/* first byte of any ctrl word has top 2 bits = 11 */
#define DTOB_IS_CTRL(b)       (((b) & 0xC0) == 0xC0)

/* open-type helpers */
#define DTOB_IS_OPEN(c)       ((c) <= 2)

#define DTOB_MAGIC            "01052026"
#define DTOB_MAGIC_LEN        8

/* integer code helpers: code must be in range 8-15 */
#define DTOB_IS_INT(c)       ((c) >= 8 && (c) <= 15)
#define DTOB_INT_UNSIGNED(c) (((c) - 8) & 4)
#define DTOB_INT_WIDTH(c)    (1 << (((c) - 8) & 3))  /* bytes: 1,2,4,8 */

enum {
	DTOB_ENUM,
	DTOB_STRUCT,
	DTOB_KV
};

typedef struct DtobValue  DtobValue;
typedef struct DtobKVPair DtobKVPair;

typedef struct {
    uint16_t code;
    char     name[129];
    uint16_t *codes;   /* allowed inner codes (5-15 or custom), 0 = nullable */
    size_t   num_codes;
    uint8_t  kind;     /* 0=enum, 1=struct */
} DtobCustomType;

typedef struct {
    DtobCustomType *entries;
    size_t count;
    size_t cap;
} DtobTypesHeader;

struct DtobKVPair {
    uint8_t    *key;
    size_t     key_len;
    DtobValue  *value;
};

typedef union {
    DtobKVPair kv;
    DtobValue  *val;
} DtobData;

struct DtobDataTagged {
    DtobData data;
    uint8_t  kind;
};

struct DtobValue {
    uint16_t              code;
    uint16_t              member_code;
    uint8_t              *data;
    size_t                data_len;
    struct DtobDataTagged *elements;
    size_t                num_elements;
    uint8_t               kind;           /* DTOB_ENUM, DTOB_STRUCT, DTOB_KV */
};

typedef struct {
    uint8_t *buf;
    size_t   cap;
    size_t   pos;
    int      error;
    int      strict_validation;
} DtobWriter;

void dtob_writer_init(DtobWriter *w, int strict_validation);
void dtob_writer_byte(DtobWriter *w, uint8_t b);
void dtob_writer_ctrl(DtobWriter *w, uint16_t code);
void dtob_writer_data(DtobWriter *w, const uint8_t *bytes, size_t len);


/* decode */
DtobValue  *dtob_decode(const uint8_t *buf, size_t len);
DtobValue  *dtob_decode_raw(const uint8_t *buf, size_t len,
                            const DtobTypesHeader *types);
DtobValue  *dtob_decode_with_types(const uint8_t *buf, size_t len,
                                    DtobTypesHeader *out_types);
int         dtob_decode_types_only(const uint8_t *buf, size_t len,
                                    DtobTypesHeader *out_types);
typedef void (*DtobTypesBuilder)(DtobTypesHeader *);
int         dtob_write_file(const char *path, DtobValue *root,
                            DtobTypesBuilder build_types);


/* encode */
uint8_t    *dtob_encode(const DtobValue *root, size_t *out_len);
uint8_t    *dtob_encode_with_types(const DtobValue *root,
                                    const DtobTypesHeader *types,
                                    int strict_validation,
                                    size_t *out_len);
uint8_t    *dtob_encode_typed(DtobValue *root, DtobTypesBuilder build_types, size_t *out_len);
uint8_t    *dtob_encode_chunk(const DtobValue *v,
                              const DtobTypesHeader *types,
                              int strict_validation,
                              size_t *out_len);

/* AST construction */
DtobValue  *dtob_int(int64_t val);
DtobValue  *dtob_uint(uint64_t val);
DtobValue  *dtob_float(float val);
DtobValue  *dtob_double(double val);
DtobValue  *dtob_raw(const uint8_t *data, size_t len);
DtobValue  *dtob_array(void);
DtobValue  *dtob_kvset(void);
DtobValue  *dtob_custom(uint16_t code, const uint8_t *data, size_t len);
DtobValue  *dtob_custom_nullable(uint16_t code);

void        dtob_array_push(DtobValue *arr, DtobValue *val);
void        dtob_kvset_put(DtobValue *kvs, const char *key, DtobValue *val);

/* types header */
void              dtob_types_init(DtobTypesHeader *th);
void              dtob_types_cleanup(DtobTypesHeader *th);
int               dtob_types_add(DtobTypesHeader *th, uint16_t code, const char *name,
                                  const uint16_t *codes, size_t num_codes);
const char       *dtob_types_get_name(const DtobTypesHeader *th, uint16_t code);
DtobCustomType   *dtob_types_get(const DtobTypesHeader *th, uint16_t code);
int               dtob_code_data_size(uint16_t code); /* -1 = variable */

/* format parsers */
typedef struct DtobSchema DtobSchema;

/* memory */
void        dtob_free(DtobValue *val);
DtobValue  *dtob_deep_copy(const DtobValue *val);

/* value accessors */
int64_t     dtob_val_to_i64(const DtobValue *v);
uint64_t    dtob_val_to_u64(const DtobValue *v);
size_t      dtob_val_to_str(const DtobValue *v, char *out, size_t outsz);

/* KV-set accessors */
DtobValue  *dtob_kvset_get(const DtobValue *kvs, const char *key);
int64_t     dtob_kvset_int(const DtobValue *kvs, const char *key);
uint64_t    dtob_kvset_uint(const DtobValue *kvs, const char *key);
double      dtob_kvset_float(const DtobValue *kvs, const char *key);
size_t      dtob_kvset_str(const DtobValue *kvs, const char *key,
                           char *out, size_t outsz);
const uint8_t *dtob_kvset_raw(const DtobValue *kvs, const char *key,
                              size_t *out_len);

/* file-level array append: read dtob file, decode root array, push entry, re-encode, write back.
 * Creates the file with a single-element array if it doesn't exist.
 * Returns 0 on success, nonzero on failure. */
int         dtob_array_append_to_file(const char *path, DtobValue *entry);

size_t dtob_types_encoded_size(const DtobTypesHeader *th);
size_t dtob_value_encoded_size(DtobValue *dv, DtobTypesHeader *th);

uint8_t  dtob_get_u8(const DtobValue *v);
uint16_t dtob_get_u16(const DtobValue *v);
uint32_t dtob_get_u32(const DtobValue *v);
uint64_t dtob_get_u64(const DtobValue *v);
int8_t   dtob_get_i8(const DtobValue *v);
int16_t  dtob_get_i16(const DtobValue *v);
int32_t  dtob_get_i32(const DtobValue *v);
int64_t  dtob_get_i64(const DtobValue *v);

DtobValue * dtob_get_struct_val_from_name(const DtobTypesHeader *th,
		const DtobValue *chosen_struct, const char *name);

DtobValue * dtob_get_struct_val_from_code(const DtobTypesHeader *th,
		const DtobValue *chosen_struct, uint16_t code);


#ifdef __cplusplus
}
#endif
#endif
