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

/* ---- Base forms. Each takes an explicit DtobTypesHeader *. ---- */

#define DTOB_CUSTOM_TYPE_NULLABLE_WITH(th, code, str) \
    dtob_types_add(th, code, str, NULL, 0);

/* exactly one built-in payload code: DTOB_RAW, DTOB_INT8 ... DTOB_UINT64 */
#define DTOB_CUSTOM_TYPE_PRIM_WITH(th, code, str, prim) \
    dtob_types_add(th, code, str, (uint16_t[]){prim}, 1);

#define DTOB_CUSTOM_TYPE_ENUM_WITH(th, code, str, ...) \
    dtob_types_add(th, code, str,                      \
        (uint16_t[]){__VA_ARGS__},                     \
        sizeof((uint16_t[]){__VA_ARGS__}) / sizeof(uint16_t));

#define DTOB_CUSTOM_TYPE_STRUCT_WITH(th, code, str, ...)          \
    do {                                                          \
        uint16_t _ops[] = {__VA_ARGS__};                          \
        if (dtob_types_add(th, code, str, _ops,                   \
                           sizeof(_ops) / sizeof(uint16_t)) == 0) \
            (th)->entries[(th)->count - 1].kind = DTOB_STRUCT;    \
    } while (0);

/* ---- Named shorthands for the built-in payload types ---- */

#define DTOB_CUSTOM_TYPE_RAW_WITH(th, c, s)    DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_RAW)
#define DTOB_CUSTOM_TYPE_INT8_WITH(th, c, s)   DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_INT8)
#define DTOB_CUSTOM_TYPE_INT16_WITH(th, c, s)  DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_INT16)
#define DTOB_CUSTOM_TYPE_INT32_WITH(th, c, s)  DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_INT32)
#define DTOB_CUSTOM_TYPE_INT64_WITH(th, c, s)  DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_INT64)
#define DTOB_CUSTOM_TYPE_UINT8_WITH(th, c, s)  DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_UINT8)
#define DTOB_CUSTOM_TYPE_UINT16_WITH(th, c, s) DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_UINT16)
#define DTOB_CUSTOM_TYPE_UINT32_WITH(th, c, s) DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_UINT32)
#define DTOB_CUSTOM_TYPE_UINT64_WITH(th, c, s) DTOB_CUSTOM_TYPE_PRIM_WITH(th, c, s, DTOB_UINT64)

/* ---- Bare forms, valid only inside DTOB_DEFINE_CUSTOM_TYPES, where they
 *      target the _th it declares ---- */

#define DTOB_CUSTOM_TYPE_NULLABLE(c, s)    DTOB_CUSTOM_TYPE_NULLABLE_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_PRIM(c, s, prim)  DTOB_CUSTOM_TYPE_PRIM_WITH(_th, c, s, prim)
#define DTOB_CUSTOM_TYPE_ENUM(c, s, ...)   DTOB_CUSTOM_TYPE_ENUM_WITH(_th, c, s, __VA_ARGS__)
#define DTOB_CUSTOM_TYPE_STRUCT(c, s, ...) DTOB_CUSTOM_TYPE_STRUCT_WITH(_th, c, s, __VA_ARGS__)
#define DTOB_CUSTOM_TYPE_RAW(c, s)         DTOB_CUSTOM_TYPE_RAW_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_INT8(c, s)        DTOB_CUSTOM_TYPE_INT8_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_INT16(c, s)       DTOB_CUSTOM_TYPE_INT16_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_INT32(c, s)       DTOB_CUSTOM_TYPE_INT32_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_INT64(c, s)       DTOB_CUSTOM_TYPE_INT64_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_UINT8(c, s)       DTOB_CUSTOM_TYPE_UINT8_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_UINT16(c, s)      DTOB_CUSTOM_TYPE_UINT16_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_UINT32(c, s)      DTOB_CUSTOM_TYPE_UINT32_WITH(_th, c, s)
#define DTOB_CUSTOM_TYPE_UINT64(c, s)      DTOB_CUSTOM_TYPE_UINT64_WITH(_th, c, s)

#endif /* DTOB_TYPES_H */
