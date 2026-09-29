#define _POSIX_C_SOURCE 200809L
#include "dtob_internal.h"

/* --- Parser --- */

typedef struct {
    Lexer           *lexer;
    Token            current;
    int              has_current;
    DtobTypesHeader *types;
    int              has_types;
    int              depth;      /* current parse_value recursion depth */
} Parser;

static Token peek(Parser *p) {
    if (!p->has_current) {
        p->current = lexer_next(p->lexer);
        p->has_current = 1;
    }
    return p->lexer->error ? (Token){ DTOB_TOK_ERR, NULL, 0 } : p->current;
}

static Token consume(Parser *p) {
    Token t = peek(p); p->has_current = 0; return t;
}

static DtobValue *parse_value(Parser *p);
static DtobValue *parse_value_inner(Parser *p);

/* Convert a token to its code (5-15 primitives, 16+ custom).
 * Returns 0 if not a valid code token. */
static uint16_t tok_to_code(const Token *t)
{
    if (t->type >= DTOB_RAW && t->type <= DTOB_CUSTOM_MAX) return t->type;
    return 0;
}

/* --- Parse types header ---
 * Called after consuming OPEN_TYPES. Reads type defs until CLOSE. */

static int parse_types_header(Parser *p)
{
    p->has_types = 1;

    while (!p->lexer->error && peek(p).type != DTOB_CLOSE) {
        Token open = consume(p);
        int is_struct = (open.type == DTOB_OPEN_ARR);

        if (open.type != DTOB_OPEN_ARR && open.type != DTOB_OPEN_KV) {
            fprintf(stderr, "dtob: expected OPEN_ARR or OPEN_KV for type def\n");
            return -1;
        }

        /* custom code */
        Token code_tok = consume(p);
        if (code_tok.type == DTOB_RUBOUT) {
            fprintf(stderr, "dtob: code 8190 is rubout and cannot be a custom type\n");
            return -1;
        }
        if (code_tok.type < DTOB_CUSTOM_MIN || code_tok.type > DTOB_CUSTOM_MAX) {
            fprintf(stderr, "dtob: expected custom code in type def\n");
            return -1;
        }
        uint16_t code = code_tok.type;

        /* name (data payload on the custom code token) */
        if (!code_tok.data || code_tok.data_len == 0) {
            fprintf(stderr, "dtob: expected type name after custom code %d\n", code);
            return -1;
        }
        char *name = malloc(code_tok.data_len + 1);
        memcpy(name, code_tok.data, code_tok.data_len);
        name[code_tok.data_len] = '\0';
        free(code_tok.data);

        /* codes until CLOSE; the grammar sets no limit, so accept as many
         * as dtob_types_add does */
        uint16_t *codes = NULL;
        size_t n_codes = 0, cap = 0;
        while (!p->lexer->error && peek(p).type != DTOB_CLOSE) {
            Token ot = peek(p);
            uint16_t op = tok_to_code(&ot);
            if (op == 0) break;
            if (n_codes >= DTOB_CUSTOM_COUNT) {
                fprintf(stderr, "dtob: too many codes in type def\n");
                free(codes); free(name);
                return -1;
            }
            if (n_codes == cap) {
                cap = cap ? cap * 2 : 16;
                uint16_t *grown = realloc(codes, cap * sizeof(uint16_t));
                if (!grown) { free(codes); free(name); return -1; }
                codes = grown;
            }
            codes[n_codes++] = op;
            consume(p);
            free(ot.data); /* member codes carry no payload in a types header */
        }

        /* consume CLOSE */
        if (peek(p).type != DTOB_CLOSE) {
            fprintf(stderr, "dtob: expected CLOSE for type def\n");
            free(codes); free(name);
            return -1;
        }
        consume(p);

        if (p->types && code >= DTOB_CUSTOM_MIN) {
            if (dtob_types_add(p->types, code, name, codes, n_codes) != 0) {
                fprintf(stderr, "dtob: could not register custom type %u\n", code);
                free(codes); free(name);
                return -1;
            }
            if (is_struct)
                p->types->entries[p->types->count - 1].kind = DTOB_STRUCT;
        }
        free(codes);
        free(name);
    }

    if (p->lexer->error) return -1;

    /* consume outer CLOSE of types header */
    consume(p);
    return 0;
}

/* --- Parse collection ---
 * Called after consuming OPEN_ARR or OPEN_KV. open_type tells us which. */

static DtobValue *parse_collection(Parser *p, uint16_t open_type)
{
    DtobValue *coll = ast_make(open_type);

    while (!p->lexer->error && peek(p).type != DTOB_CLOSE) {
        if (open_type == DTOB_OPEN_KV) {
            /* kv_set: expect raw key then value */
            Token kt = peek(p);
            if (kt.type == DTOB_RAW) {
                consume(p);
                uint8_t *key = kt.data;
                size_t key_len = kt.data_len;
                DtobValue *val = parse_value(p);
                if (!val) { free(key); dtob_free(coll); return NULL; }
                ast_add_pair(coll, key, key_len, val);
                free(key); /* ast_add_pair copies */
            } else {
                /* non-key element in kv_set */
                DtobValue *val = parse_value(p);
                if (!val) { dtob_free(coll); return NULL; }
                ast_add_element(coll, val);
            }
        } else {
            /* array */
            DtobValue *val = parse_value(p);
            if (!val) { dtob_free(coll); return NULL; }
            ast_add_element(coll, val);
        }
    }

    /* consume CLOSE */
    consume(p);
    return coll;
}

#define consume_value { \
        consume(p);      \
        v = ast_make(t.type); \
        v->data = t.data;     \
        v->data_len = t.data_len; \
        return v; }

/* Depth-limited wrapper around parse_value_inner. Collections recurse
 * (parse_value -> parse_collection -> parse_value), so hostile input made of
 * thousands of nested open words would otherwise exhaust the stack. */
static DtobValue *parse_value(Parser *p)
{
    if (p->depth >= DTOB_MAX_DEPTH) {
        fprintf(stderr, "dtob: nesting deeper than %d levels\n", DTOB_MAX_DEPTH);
        p->lexer->error = 1;
        return NULL;
    }
    p->depth++;
    DtobValue *v = parse_value_inner(p);
    p->depth--;
    return v;
}

static DtobValue *parse_value_inner(Parser *p)
{
    Token t = peek(p);
    DtobValue *v = NULL;

    /* open: enter collection */
    if (t.type == DTOB_OPEN_ARR || t.type == DTOB_OPEN_KV) {
        consume(p);
        return parse_collection(p, t.type);
    }

    if (t.type == DTOB_RAW) consume_value;
    if (DTOB_IS_INT(t.type)) consume_value;
    if (t.type == DTOB_FLOAT || t.type == DTOB_DOUBLE) consume_value;

    /* custom types (16+) */
    if (t.type >= DTOB_CUSTOM_MIN && t.type <= DTOB_CUSTOM_MAX) {
        uint16_t code = t.type;
        consume(p);

        if (!p->has_types) {
            fprintf(stderr, "dtob: custom code %d used without types header\n", code);
            return NULL;
        }
        DtobCustomType *ct = p->types ? dtob_types_get(p->types, code) : NULL;
        if (!ct) {
            fprintf(stderr, "dtob: undefined custom type %d\n", code);
            return NULL;
        }

        DtobValue *v = ast_make(code);
        /* data payload from the token itself */
        v->data = t.data;
        v->data_len = t.data_len;
	v->kind = ct->kind;

        if (ct->kind == DTOB_STRUCT) {
            /* struct: OPEN_ARR members CLOSE */
            Token open_tok = peek(p);
            if (open_tok.type != DTOB_OPEN_ARR) {
                fprintf(stderr, "dtob: struct type %d: expected OPEN_ARR\n", code);
                dtob_free(v);
                return NULL;
            }
            consume(p);

            while (!p->lexer->error && peek(p).type != DTOB_CLOSE) {
                DtobValue *member = parse_value(p);
                if (!member) { dtob_free(v); return NULL; }
                ast_add_element(v, member);
            }
            consume(p); /* CLOSE */

            /* validate member count */
            if (v->num_elements != ct->num_codes) {
                fprintf(stderr, "dtob: struct type %d: expected %zu members, got %zu\n",
                        code, ct->num_codes, v->num_elements);
                dtob_free(v);
                return NULL;
            }
        } else if (ct->num_codes == 0) {
            /* nullable */
            v->member_code = 0;
        } else if (ct->num_codes == 1) {
            /* one-type enum: no inner code prefix, data already on token */
            v->member_code = ct->codes[0];
        } else {
            /* multi-type enum: read inner code */
            Token inner = peek(p);
            uint16_t iop = tok_to_code(&inner);
            if (iop == 0) {
                fprintf(stderr, "dtob: custom type %d: expected inner code\n", code);
                dtob_free(v);
                return NULL;
            }
            consume(p);
            v->member_code = iop;

            /* check if inner code is a struct type */
            DtobCustomType *inner_ct = p->types ? dtob_types_get(p->types, iop) : NULL;
            if (inner_ct && inner_ct->kind == DTOB_STRUCT) {
                Token open_tok = peek(p);
                if (open_tok.type != DTOB_OPEN_ARR) {
                    fprintf(stderr, "dtob: enum type %d inner struct %d: expected OPEN_ARR\n", code, iop);
                    dtob_free(v);
                    return NULL;
                }
                consume(p);

                while (!p->lexer->error && peek(p).type != DTOB_CLOSE) {
                    DtobValue *member = parse_value(p);
                    if (!member) { dtob_free(v); return NULL; }
                    ast_add_element(v, member);
                }
                consume(p); /* CLOSE */
            } else {
                /* flat data — inner token may have data payload */
                if (inner.data && inner.data_len > 0) {
                    /* data came with the inner code token */
                    free(v->data); /* discard outer data if any */
                    v->data = inner.data;
                    v->data_len = inner.data_len;
                }
            }
        }

        return v;
    }

    fprintf(stderr, "dtob: unexpected token %d where value expected\n", t.type);
    return NULL;
}

/* --- Public decode API --- */

int dtob_decode_types_only(const uint8_t *buf, size_t len, DtobTypesHeader *out_types)
{
    size_t consumed;
    if (!out_types || dtob_decode_magic_and_types(buf, len, out_types, &consumed) != 0) return -1;
    size_t magic_len;
    dtob_magic(buf, len, &magic_len);
    return consumed > magic_len ? 0 : -1; /* the types header is required */
}

DtobValue *dtob_decode_chunk(const uint8_t *buf, size_t len,
                             const DtobTypesHeader *types)
{
    Lexer lexer;
    lexer_init(&lexer, buf, len);

    DtobTypesHeader local_types;
    if (!types) dtob_types_init(&local_types);

    Parser p = {
        .lexer = &lexer,
        .has_current = 0,
        .types = types ? (DtobTypesHeader *)types : &local_types,
        .has_types = types ? 1 : 0,
    };

    Token t = peek(&p);
    if (t.type != DTOB_OPEN_ARR && t.type != DTOB_OPEN_KV) {
        DtobValue *v = parse_value(&p);
        if (!types) dtob_types_cleanup(&local_types);
        return v;
    }
    consume(&p);
    DtobValue *root = parse_collection(&p, t.type);
    if (p.lexer->error) { dtob_free(root); root = NULL; }
    if (!types) dtob_types_cleanup(&local_types);
    return root;
}

DtobValue *dtob_decode_chunk_prefix(const uint8_t *buf, size_t len,
                                    const DtobTypesHeader *types, size_t *consumed)
{
    if (consumed) *consumed = 0;
    if (!buf || !consumed) return NULL;

    Lexer lexer;
    lexer_init(&lexer, buf, len);

    DtobTypesHeader local_types;
    if (!types) dtob_types_init(&local_types);

    Parser p = {
        .lexer = &lexer,
        .has_current = 0,
        .types = types ? (DtobTypesHeader *)types : &local_types,
        .has_types = types ? 1 : 0,
    };

    DtobValue *v = parse_value(&p);
    /* A value ends on a consumed token, so the lexer stops right after it.
     * A token still held for lookahead would put the position past the
     * value; that never happens for a complete value, so treat it as an
     * error rather than report a wrong length. */
    if (v && (p.lexer->error || p.has_current)) { dtob_free(v); v = NULL; }
    if (v) *consumed = lexer.pos;
    if (!types) dtob_types_cleanup(&local_types);
    return v;
}

int dtob_magic(const uint8_t *buf, size_t len, size_t *magic_len)
{
    static const struct { const char *magic; size_t len; int kind; } kinds[] = {
        { DTOB_MAGIC_FILE,      DTOB_MAGIC_FILE_LEN,      DTOB_MAGIC_KIND_FILE },
        { DTOB_MAGIC_PRE_RUBOUT, DTOB_MAGIC_PRE_RUBOUT_LEN, DTOB_MAGIC_KIND_PRE_RUBOUT },
        { DTOB_MAGIC_WIRE,      DTOB_MAGIC_WIRE_LEN,      DTOB_MAGIC_KIND_WIRE },
    };
    if (magic_len) *magic_len = 0;
    if (!buf) return DTOB_MAGIC_KIND_NONE;
    for (size_t i = 0; i < sizeof kinds / sizeof kinds[0]; i++) {
        if (len >= kinds[i].len && memcmp(buf, kinds[i].magic, kinds[i].len) == 0) {
            if (magic_len) *magic_len = kinds[i].len;
            return kinds[i].kind;
        }
    }
    return DTOB_MAGIC_KIND_NONE;
}

int dtob_decode_magic_and_types(const uint8_t *buf, size_t len,
                                DtobTypesHeader *out_types, size_t *consumed)
{
    if (consumed) *consumed = 0;
    if (!buf || !consumed) return -1;
    size_t magic_len;
    int magic = dtob_magic(buf, len, &magic_len);
    if (!magic) return -1;

    /* No types header: the root starts right after the magic. Checked on
     * the raw bytes so that nothing past the header is lexed. */
    const uint8_t *rest = buf + magic_len;
    size_t rest_len = len - magic_len;
    if (rest_len < 2 || !DTOB_IS_CTRL(rest[0]) || (rest[0] & 0x20) ||
        (((uint16_t)(rest[0] & 0x1F) << 8) | rest[1]) != DTOB_OPEN_TYPES) {
        *consumed = magic_len;
        return 0;
    }

    Lexer lexer;
    lexer_init(&lexer, rest, rest_len);
    lexer.pre_rubout = magic == DTOB_MAGIC_KIND_PRE_RUBOUT;

    DtobTypesHeader local_types;
    if (!out_types) dtob_types_init(&local_types);

    Parser p = {
        .lexer = &lexer,
        .has_current = 0,
        .types = out_types ? out_types : &local_types,
        .has_types = 0,
    };

    consume(&p); /* OPEN_TYPES */
    int rc = parse_types_header(&p);
    /* The header ends on its consumed CLOSE, so the lexer stops right after it. */
    if (rc == 0 && (p.lexer->error || p.has_current)) rc = -1;
    if (rc == 0) *consumed = magic_len + lexer.pos;
    if (!out_types) dtob_types_cleanup(&local_types);
    return rc;
}

DtobValue *dtob_decode(const uint8_t *buf, size_t len)
{
    return dtob_decode_with_types(buf, len, NULL);
}

DtobValue *dtob_decode_with_types(const uint8_t *buf, size_t len,
                                   DtobTypesHeader *out_types)
{
    size_t magic_len;
    int magic = dtob_magic(buf, len, &magic_len);
    if (!magic) {
        fprintf(stderr, "dtob: invalid magic number\n");
        return NULL;
    }

    Lexer lexer;
    lexer_init(&lexer, buf + magic_len, len - magic_len);
    lexer.pre_rubout = magic == DTOB_MAGIC_KIND_PRE_RUBOUT;

    DtobTypesHeader local_types;
    if (!out_types) dtob_types_init(&local_types);

    Parser p = {
        .lexer = &lexer,
        .has_current = 0,
        .types = out_types ? out_types : &local_types,
        .has_types = 0,
    };

    /* types header may appear before the root open */
    if (peek(&p).type == DTOB_OPEN_TYPES) {
        consume(&p);
        if (parse_types_header(&p) != 0) {
            if (!out_types) dtob_types_cleanup(&local_types);
            return NULL;
        }
    }

    Token t = peek(&p);
    if (t.type != DTOB_OPEN_ARR && t.type != DTOB_OPEN_KV) {
        /* single value document */
        DtobValue *v = parse_value(&p);
        if (!out_types) dtob_types_cleanup(&local_types);
        return v;
    }

    consume(&p);
    DtobValue *root = parse_collection(&p, t.type);

    if (p.lexer->error) {
        dtob_free(root);
        root = NULL;
    }
    if (!out_types) dtob_types_cleanup(&local_types);
    return root;
}
