#ifndef DTOB_TYPES_H
#define DTOB_TYPES_H

#include "dtob.h"

/*
 * dtob_types.h — macros for defining custom type schemas without boilerplate.
 *
 * Usage:
 *
 *   DTOB_DEFINE_CUSTOM_TYPES(myapp,
 *       DTOB_CUSTOM_TYPE_RAW     (MY_NAME,   "name")
 *       DTOB_CUSTOM_TYPE_NULLABLE(MY_TRUE,   "true")
 *       DTOB_CUSTOM_TYPE_NULLABLE(MY_FALSE,  "false")
 *       DTOB_CUSTOM_TYPE_ENUM    (MY_BOOL,   "bool",   MY_TRUE, MY_FALSE)
 *       DTOB_CUSTOM_TYPE_UINT64  (MY_INODE,  "inode")
 *       DTOB_CUSTOM_TYPE_STRUCT  (MY_FILE,   "file",   MY_NAME, MY_INODE)
 *   )
 *
 * This expands to:
 *
 *   static void build_myapp_custom_types(DtobTypesHeader *_th) {
 *       dtob_types_init(_th);
 *       ...
 *   }
 */

#ifdef __GNUC__
#define _DTOB_MAYBE_UNUSED __attribute__((unused))
#else
#define _DTOB_MAYBE_UNUSED
#endif

/* generates: static void build_custom_types_<name>(DtobTypesHeader *_th) { ... } */
#define DTOB_DEFINE_CUSTOM_TYPES(name, ...)                               \
    _DTOB_MAYBE_UNUSED                                                    \
    static void build_custom_types_##name(DtobTypesHeader *_th) {        \
        dtob_types_init(_th);                                             \
        __VA_ARGS__                                                       \
    }

/* ---- standard macros (use _th implicitly, only inside DTOB_DEFINE_CUSTOM_TYPES) ---- */

#define DTOB_CUSTOM_TYPE_NULLABLE(code, str) \
    dtob_types_add(_th, code, str, NULL, 0);

#define DTOB_CUSTOM_TYPE_RAW(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_RAW}, 1);

#define DTOB_CUSTOM_TYPE_INT8(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_INT8}, 1);
#define DTOB_CUSTOM_TYPE_INT16(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_INT16}, 1);
#define DTOB_CUSTOM_TYPE_INT32(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_INT32}, 1);
#define DTOB_CUSTOM_TYPE_INT64(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_INT64}, 1);

#define DTOB_CUSTOM_TYPE_UINT8(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_UINT8}, 1);
#define DTOB_CUSTOM_TYPE_UINT16(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_UINT16}, 1);
#define DTOB_CUSTOM_TYPE_UINT32(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_UINT32}, 1);
#define DTOB_CUSTOM_TYPE_UINT64(code, str) \
    dtob_types_add(_th, code, str, (uint16_t[]){DTOB_UINT64}, 1);

#define DTOB_CUSTOM_TYPE_ENUM(code, str, ...) \
    dtob_types_add(_th, code, str,            \
        (uint16_t[]){__VA_ARGS__},            \
        sizeof((uint16_t[]){__VA_ARGS__}) / sizeof(uint16_t));

#define DTOB_CUSTOM_TYPE_STRUCT(code, str, ...)                                            \
    do {                                                                                   \
        uint16_t _ops[] = {__VA_ARGS__};                                                   \
        if (dtob_types_add(_th, code, str, _ops, sizeof(_ops) / sizeof(uint16_t)) == 0)   \
            (_th)->entries[(_th)->count - 1].kind = DTOB_STRUCT;                            \
    } while (0);

/* ---- _WITH variants (explicit DtobTypesHeader pointer) ---- */

#define DTOB_CUSTOM_TYPE_NULLABLE_WITH(th, code, str) \
    dtob_types_add(th, code, str, NULL, 0);

#define DTOB_CUSTOM_TYPE_RAW_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_RAW}, 1);

#define DTOB_CUSTOM_TYPE_INT8_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_INT8}, 1);
#define DTOB_CUSTOM_TYPE_INT16_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_INT16}, 1);
#define DTOB_CUSTOM_TYPE_INT32_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_INT32}, 1);
#define DTOB_CUSTOM_TYPE_INT64_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_INT64}, 1);

#define DTOB_CUSTOM_TYPE_UINT8_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_UINT8}, 1);
#define DTOB_CUSTOM_TYPE_UINT16_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_UINT16}, 1);
#define DTOB_CUSTOM_TYPE_UINT32_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_UINT32}, 1);
#define DTOB_CUSTOM_TYPE_UINT64_WITH(th, code, str) \
    dtob_types_add(th, code, str, (uint16_t[]){DTOB_UINT64}, 1);

#define DTOB_CUSTOM_TYPE_ENUM_WITH(th, code, str, ...) \
    dtob_types_add(th, code, str,                      \
        (uint16_t[]){__VA_ARGS__},                     \
        sizeof((uint16_t[]){__VA_ARGS__}) / sizeof(uint16_t));

#define DTOB_CUSTOM_TYPE_STRUCT_WITH(th, code, str, ...)                                   \
    do {                                                                                   \
        uint16_t _ops[] = {__VA_ARGS__};                                                   \
        if (dtob_types_add(th, code, str, _ops, sizeof(_ops) / sizeof(uint16_t)) == 0)    \
            (th)->entries[(th)->count - 1].kind = DTOB_STRUCT;                              \
    } while (0);

#endif /* DTOB_TYPES_H */
