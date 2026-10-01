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
 *   0  open_types  1  open_arr    2  open_kv      3  close
 *   4  uqt         5  raw         6  float        7  double
 *
 * Integer codes 8-15: bit 2 = unsigned flag, bits 0-1 = width index
 *   (code & 4) => unsigned, (code & 3) => 0=8b 1=16b 2=32b 3=64b
 *
 * Multi-byte integers are stored big-endian, padded to their declared width.
 * Floats/doubles are IEEE 754 binary32/binary64, stored big-endian like integers.
 *
 * Codes 16-8189: custom (defined in types header)
 * Code 8190: rubout — a word overwritten in place; ignored as a non-token,
 *   forbidden for type assignment. Every element spans whole words, so an
 *   element can be rubbed out by overwriting all of its words with rubout.
 * Code 8191: blast — ignored as a non-token; forbidden for type assignment
 *
 * Files and wire messages alike start with a 16-byte header: DTOB_HEADER_MAGIC
 * ("DTOB" + the format's date as days since 1970-01-01 in uppercase hex), then
 * DTOB_STAMP_LEN bytes that belong to the consumer (a version or date stamp,
 * say). Encoders write zero bytes there; dtob_set_stamp replaces them.
 *
 * Older magics are still read and carry no stamp: DTOB_MAGIC_LEGACY_FILE and
 * DTOB_MAGIC_LEGACY_WIRE, and DTOB_MAGIC_PRE_RUBOUT, in which 8190 is not
 * rubout and declaring it is an error.
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
#define DTOB_RUBOUT       8190
#define DTOB_BLAST       8191

#define DTOB_CUSTOM_MIN       16
#define DTOB_CUSTOM_MAX       8189
#define DTOB_CUSTOM_COUNT     (DTOB_CUSTOM_MAX - DTOB_CUSTOM_MIN + 1)

/* Maximum collection/struct nesting the decoder will follow. Guards against
 * stack exhaustion from hostile input; deeper documents are rejected. */
#define DTOB_MAX_DEPTH        256

/* first byte of any ctrl word has top 2 bits = 11 */
#define DTOB_IS_CTRL(b)       (((b) & 0xC0) == 0xC0)

/* open-type helpers */
#define DTOB_IS_OPEN(c)       ((c) <= 2)

#define DTOB_HEADER_MAGIC          "DTOB50F6"  /* day 0x50F6 = 2026-09-30 */
#define DTOB_HEADER_MAGIC_LEN      8
#define DTOB_STAMP_LEN             8
#define DTOB_HEADER_LEN            16
/* still read, never written */
#define DTOB_MAGIC_LEGACY_FILE     "DTOB290926"
#define DTOB_MAGIC_LEGACY_FILE_LEN 10
#define DTOB_MAGIC_LEGACY_WIRE     "290926"
#define DTOB_MAGIC_LEGACY_WIRE_LEN 6
#define DTOB_MAGIC_PRE_RUBOUT      "01052026"  /* 8190 is not rubout */
#define DTOB_MAGIC_PRE_RUBOUT_LEN  8
#define DTOB_MAGIC_MAX_LEN         16

/* magic kinds returned by dtob_magic */
#define DTOB_MAGIC_KIND_NONE        0
#define DTOB_MAGIC_KIND_HEADER      1
#define DTOB_MAGIC_KIND_LEGACY_FILE 2
#define DTOB_MAGIC_KIND_LEGACY_WIRE 3
#define DTOB_MAGIC_KIND_PRE_RUBOUT  4

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
size_t      trit_decode_into(const uint8_t *buf, size_t buf_len, uint8_t *out);
DtobValue  *dtob_decode(const uint8_t *buf, size_t len);
DtobValue  *dtob_decode_chunk(const uint8_t *buf, size_t len,
                              const DtobTypesHeader *types);
/* DO NOT USE dtob_decode_raw IN NEW CODE. IT IS FOR LEGACY SUPPORT ONLY; CALL
 * dtob_decode_chunk INSTEAD. */
#define dtob_decode_raw dtob_decode_chunk
DtobValue  *dtob_decode_with_types(const uint8_t *buf, size_t len,
                                    DtobTypesHeader *out_types);
/* DO NOT USE dtob_decode_types_only IN NEW CODE. IT IS FOR LEGACY SUPPORT ONLY;
 * CALL dtob_decode_magic_and_types INSTEAD, WHICH ALSO REPORTS WHERE THE
 * HEADER ENDS AND ACCEPTS DOCUMENTS WITHOUT ONE. */
int         dtob_decode_types_only(const uint8_t *buf, size_t len,
                                    DtobTypesHeader *out_types);
/* Decode the value at the start of a headerless buffer and set *consumed to
 * the bytes it occupies; what follows it is not read. Returns NULL (and
 * *consumed = 0) if no complete value starts there. */
DtobValue  *dtob_decode_chunk_prefix(const uint8_t *buf, size_t len,
                                     const DtobTypesHeader *types,
                                     size_t *consumed);
/* Identify the magic at the start of buf: returns a DTOB_MAGIC_KIND_* and
 * sets *magic_len (may be NULL) to where the document's content begins
 * (DTOB_HEADER_LEN for a current header, stamp included), or 0 if there is
 * none. A current header cut short of its stamp is no magic. */
int         dtob_magic(const uint8_t *buf, size_t len, size_t *magic_len);
/* The consumer's DTOB_STAMP_LEN bytes in buf's header, or NULL if buf does
 * not start with a current header (older magics carry no stamp). */
const uint8_t *dtob_stamp(const uint8_t *buf, size_t len);
/* Replace the stamp in buf's header with stamp (DTOB_STAMP_LEN bytes).
 * Returns 0, or -1 if buf does not start with a current header. */
int         dtob_set_stamp(uint8_t *buf, size_t len, const uint8_t *stamp);
/* Read a document's magic and, if present, its types header, and set
 * *consumed to where the root value begins. out_types may be NULL.
 * Returns 0, or -1 if the magic or types header is missing or malformed. */
int         dtob_decode_magic_and_types(const uint8_t *buf, size_t len,
                                        DtobTypesHeader *out_types,
                                        size_t *consumed);
typedef void (*DtobTypesBuilder)(DtobTypesHeader *);
/* NOTE: consumes (frees) root */
int         dtob_write_file(const char *path, DtobValue *root,
                            DtobTypesBuilder build_types);


/* encode: every document starts with the header, its stamp zeroed.
 * dtob_encode_wire* are the same functions, kept for callers written when
 * wire messages had their own magic. */
uint8_t    *dtob_encode(const DtobValue *root, size_t *out_len);
uint8_t    *dtob_encode_with_types(const DtobValue *root,
                                    const DtobTypesHeader *types,
                                    int strict_validation,
                                    size_t *out_len);
uint8_t    *dtob_encode_wire(const DtobValue *root, size_t *out_len);
uint8_t    *dtob_encode_wire_with_types(const DtobValue *root,
                                         const DtobTypesHeader *types,
                                         int strict_validation,
                                         size_t *out_len);
/* NOTE: consumes (frees) root and builds/cleans its own types header */
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

/* file-level array append: write entry over the root array's closing word, then
 * close the array again; the rest of the file is not rewritten. The file is
 * checked first, and nothing is written unless it is an intact document whose
 * root array is closed by its last two bytes. Creates the file with a
 * single-element array if it doesn't exist. Does not consume entry.
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
