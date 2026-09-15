#ifndef NAB_H
#define NAB_H

#include "dtob.h"
#include "dtob_types.h"

/* custom type codes */
#define NAB_OP              (DTOB_CUSTOM_MIN + 0)   /* 16 — enum(copy,add) */
#define NAB_COPY            (DTOB_CUSTOM_MIN + 1)   /* 17 — struct(start,end) */
#define NAB_START           (DTOB_CUSTOM_MIN + 2)   /* 18 — uint64 */
#define NAB_END             (DTOB_CUSTOM_MIN + 3)   /* 19 — uint64 */
#define NAB_ADD             (DTOB_CUSTOM_MIN + 4)   /* 20 — raw */
#define NAB_METADATA        (DTOB_CUSTOM_MIN + 5)   /* 21 — struct(patch_index,patch_id,byte_len,byte_offset,last_full_patch,timestamp) */
#define NAB_PATCH_INDEX     (DTOB_CUSTOM_MIN + 6)   /* 22 — uint64 */
#define NAB_PATCH_ID        (DTOB_CUSTOM_MIN + 7)   /* 23 — raw (sha256) */
#define NAB_BYTE_LENGTH     (DTOB_CUSTOM_MIN + 8)   /* 24 — uint64 */
#define NAB_BYTE_OFFSET     (DTOB_CUSTOM_MIN + 9)   /* 25 — uint64 */
#define NAB_LAST_FULL_PATCH (DTOB_CUSTOM_MIN + 11)  /* 26 — uint64 */
#define NAB_TIMESTAMP       (DTOB_CUSTOM_MIN + 12)  /* 27 — uint64 */
#define NAB_SIMHASH         (DTOB_CUSTOM_MIN + 14)  /* 29 — uint64 */
#define NAB_AUTHOR          (DTOB_CUSTOM_MIN + 15)  /* 31 — raw */
#define NAB_AUTHOR_MAX_BYTES 32

// these are not actually necessary
//#define NAB_CONSTRUCTION    (DTOB_CUSTOM_MIN + 11)   /* 27 — enum(full,iter) */
//#define NAB_FULL            (DTOB_CUSTOM_MIN + 12)   /* 28 — nullable */
//#define NAB_ITER            (DTOB_CUSTOM_MIN + 13)   /* 29 — nullable */

DTOB_DEFINE_CUSTOM_TYPES(nab,
    DTOB_CUSTOM_TYPE_ENUM     (NAB_OP,              "op",              NAB_COPY, NAB_ADD)
    DTOB_CUSTOM_TYPE_STRUCT   (NAB_COPY,            "copy",            NAB_START, NAB_END)
    DTOB_CUSTOM_TYPE_UINT64   (NAB_START,           "start")
    DTOB_CUSTOM_TYPE_UINT64   (NAB_END,             "end")
    DTOB_CUSTOM_TYPE_RAW      (NAB_ADD,             "add")
    DTOB_CUSTOM_TYPE_STRUCT   (NAB_METADATA,        "metadata",        NAB_PATCH_INDEX, NAB_PATCH_ID, NAB_BYTE_LENGTH,\
	    NAB_BYTE_OFFSET, NAB_LAST_FULL_PATCH, NAB_TIMESTAMP, NAB_SIMHASH, NAB_AUTHOR)
    DTOB_CUSTOM_TYPE_UINT64   (NAB_PATCH_INDEX,     "patch_index")
    DTOB_CUSTOM_TYPE_RAW      (NAB_PATCH_ID,        "patch_id")
    DTOB_CUSTOM_TYPE_UINT64   (NAB_BYTE_LENGTH,        "byte_len")
    DTOB_CUSTOM_TYPE_UINT64   (NAB_BYTE_OFFSET,     "byte_offset")
    DTOB_CUSTOM_TYPE_UINT64   (NAB_LAST_FULL_PATCH, "last_full_patch")
    DTOB_CUSTOM_TYPE_UINT64   (NAB_TIMESTAMP,       "timestamp")
    DTOB_CUSTOM_TYPE_UINT64   (NAB_SIMHASH,         "simhash")
    DTOB_CUSTOM_TYPE_RAW      (NAB_AUTHOR,          "author")
)


#endif /* NAB_H */
