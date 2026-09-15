#define _POSIX_C_SOURCE 200809L
#include "dtob_internal.h"

/* --- Parser --- */

typedef struct {
    Lexer           *lexer;
    Token            current;
    int              has_current;
    DtobTypesHeader *types;
    int              has_types;
} Parser;

static Token peek(Parser *p) {
    if (!p->has_current) {
        p->current = lexer_next(p->lexer);
        p->has_current = 1;
    }
    return p->lexer->error ? (Token){0} : p->current;
}

static Token consume(Parser *p) {
    Token t = peek(p); p->has_current = 0; return t;
}

static DtobValue *parse_value(Parser *p);

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

    while (peek(p).type != DTOB_CLOSE) {
        Token open = consume(p);
        int is_struct = (open.type == DTOB_OPEN_ARR);

        if (open.type != DTOB_OPEN_ARR && open.type != DTOB_OPEN_KV) {
            fprintf(stderr, "dtob: expected OPEN_ARR or OPEN_KV for type def\n");
            return -1;
        }

        /* custom code */
        Token code_tok = consume(p);
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

        /* codes until CLOSE */
        uint16_t codes[15];
        size_t n_codes = 0;
        while (peek(p).type != DTOB_CLOSE) {
            Token ot = peek(p);
            uint16_t op = tok_to_code(&ot);
            if (op == 0) break;
            if (n_codes >= 15) {
                fprintf(stderr, "dtob: too many codes in type def\n");
                free(name);
                return -1;
            }
            codes[n_codes++] = op;
            consume(p);
            free(ot.data); /* member codes carry no payload in a types header */
        }

        /* consume CLOSE */
        if (peek(p).type != DTOB_CLOSE) {
            fprintf(stderr, "dtob: expected CLOSE for type def\n");
            free(name);
            return -1;
        }
        consume(p);

        if (p->types && code >= DTOB_CUSTOM_MIN) {
            dtob_types_add(p->types, code, name, codes, n_codes);
            if (is_struct)
                p->types->entries[p->types->count - 1].kind = DTOB_STRUCT;
        }
        free(name);
    }

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

static DtobValue *parse_value(Parser *p)
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

            while (peek(p).type != DTOB_CLOSE) {
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

                while (peek(p).type != DTOB_CLOSE) {
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
    if (!out_types || len < DTOB_MAGIC_LEN) return -1;
    if (memcmp(buf, DTOB_MAGIC, DTOB_MAGIC_LEN) != 0) return -1;

    Lexer lexer;
    lexer_init(&lexer, buf + DTOB_MAGIC_LEN, len - DTOB_MAGIC_LEN);

    Parser p = {
        .lexer = &lexer,
        .has_current = 0,
        .types = out_types,
        .has_types = 0,
    };

    if (peek(&p).type != DTOB_OPEN_TYPES) return -1;
    consume(&p);
    return parse_types_header(&p);
}

DtobValue *dtob_decode_raw(const uint8_t *buf, size_t len,
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

DtobValue *dtob_decode(const uint8_t *buf, size_t len)
{
    return dtob_decode_with_types(buf, len, NULL);
}

DtobValue *dtob_decode_with_types(const uint8_t *buf, size_t len,
                                   DtobTypesHeader *out_types)
{
    if (len < DTOB_MAGIC_LEN) {
        fprintf(stderr, "dtob: input too short for magic number\n");
        return NULL;
    }
    if (memcmp(buf, DTOB_MAGIC, DTOB_MAGIC_LEN) != 0) {
        fprintf(stderr, "dtob: invalid magic number\n");
        return NULL;
    }

    Lexer lexer;
    lexer_init(&lexer, buf + DTOB_MAGIC_LEN, len - DTOB_MAGIC_LEN);

    DtobTypesHeader local_types;
    dtob_types_init(&local_types);

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
