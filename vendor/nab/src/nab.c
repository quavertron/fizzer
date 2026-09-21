#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <libgen.h>
#include <limits.h>
#include <errno.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/file.h>

#include "nab.h"
#include "util.c"
#include "xbdiff.c"

#define dgsvfn dtob_get_struct_val_from_name

/* metadata_result defined in util.c */

static inline DtobValue *nab_u64_node(uint16_t code, uint64_t val) {
    uint8_t bytes[8];
    for (int i = 7; i >= 0; i--) { bytes[i] = val & 0xFF; val >>= 8; }
    return dtob_custom(code, bytes, 8);
}

static inline DtobValue *nab_copy(uint64_t s, uint64_t e) {
    DtobValue *op = dtob_custom_nullable(NAB_OP);
    op->member_code = NAB_COPY;
    dtob_array_push(op, nab_u64_node(NAB_START, s));
    dtob_array_push(op, nab_u64_node(NAB_END, e));
    return op;
}

static inline DtobValue *nab_add(const uint8_t *data, size_t len) {
    DtobValue *op = dtob_custom(NAB_OP, data, len);
    op->member_code = NAB_ADD;
    return op;
}

static inline DtobValue *nab_i64_node(uint16_t code, int64_t val) {
    uint8_t bytes[8];
    uint64_t uval = (uint64_t)val;
    for (int i = 7; i >= 0; i--) { bytes[i] = uval & 0xFF; uval >>= 8; }
    return dtob_custom(code, bytes, 8);
}

static uint64_t compute_simhash(const uint8_t *data, size_t len) {
    if (len < 3) return 0;
    size_t n = len - 2;
    uint32_t counts[64] = {0};

    uint64_t b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    size_t batch = 0;

    for (size_t i = 0; i + 3 <= len; i++) {
        uint64_t h = 14695981039346656037ULL;
        h ^= data[i];   h *= 1099511628211ULL;
        h ^= data[i+1]; h *= 1099511628211ULL;
        h ^= data[i+2]; h *= 1099511628211ULL;

        uint64_t c0 = b0 & h;  b0 ^= h;
        uint64_t c1 = b1 & c0; b1 ^= c0;
        uint64_t c2 = b2 & c1; b2 ^= c1;
        uint64_t c3 = b3 & c2; b3 ^= c2;
        uint64_t c4 = b4 & c3; b4 ^= c3;
        uint64_t c5 = b5 & c4; b5 ^= c4;
        b6 ^= c5;

        if (++batch == 127) {
            for (int b = 0; b < 64; b++) {
                counts[b] += ((b0 >> b) & 1) |
                             (((b1 >> b) & 1) << 1) |
                             (((b2 >> b) & 1) << 2) |
                             (((b3 >> b) & 1) << 3) |
                             (((b4 >> b) & 1) << 4) |
                             (((b5 >> b) & 1) << 5) |
                             (((b6 >> b) & 1) << 6);
            }
            b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0;
            batch = 0;
        }
    }

    for (int b = 0; b < 64; b++) {
        counts[b] += ((b0 >> b) & 1) |
                     (((b1 >> b) & 1) << 1) |
                     (((b2 >> b) & 1) << 2) |
                     (((b3 >> b) & 1) << 3) |
                     (((b4 >> b) & 1) << 4) |
                     (((b5 >> b) & 1) << 5) |
                     (((b6 >> b) & 1) << 6);
    }

    uint64_t hash = 0;
    for (int b = 0; b < 64; b++) {
        if (2 * (size_t)counts[b] > n) {
            hash |= (1ULL << b);
        }
    }
    return hash;
}

static int nab_author_validate(const uint8_t *author, size_t author_len) {
    if (author_len > NAB_AUTHOR_MAX_BYTES || (author_len && !author)) {
        fprintf(stderr, "nab: author must be at most %d bytes\n", NAB_AUTHOR_MAX_BYTES);
        return -1;
    }
    return 0;
}

static inline DtobValue *nab_metadata_construct(const uint64_t idx, const uint8_t sha256[32], uint64_t byte_length, uint64_t byte_offset, uint64_t last_full, uint64_t timestamp, uint64_t simhash, const uint8_t *author, size_t author_len) {
    if (nab_author_validate(author, author_len)) return NULL;

    DtobValue *metadata = dtob_custom_nullable(NAB_METADATA);

    dtob_array_push(metadata, nab_u64_node(NAB_PATCH_INDEX, idx));
    dtob_array_push(metadata, dtob_custom(NAB_PATCH_ID, sha256, 32));
    dtob_array_push(metadata, nab_u64_node(NAB_BYTE_LENGTH, byte_length));
    dtob_array_push(metadata, nab_u64_node(NAB_BYTE_OFFSET, byte_offset));
    dtob_array_push(metadata, nab_i64_node(NAB_LAST_FULL_PATCH, last_full));
    dtob_array_push(metadata, nab_u64_node(NAB_TIMESTAMP, timestamp));
    dtob_array_push(metadata, nab_u64_node(NAB_SIMHASH, simhash));
    dtob_array_push(metadata, dtob_custom(NAB_AUTHOR, author, author_len));
    return metadata;
}

static void diff_build(const uint8_t *old_data, size_t old_len,
                       const uint8_t *new_data, size_t new_len,
                       DtobValue *diff) {
    if (new_len == 0) return;
    if (old_len < BLK_SIZE || new_len < BLK_SIZE) {
        dtob_array_push(diff, nab_add(new_data, new_len));
        return;
    }

    diff_index_t *idx = build_index(old_data, old_len);
    if (!idx) {
        dtob_array_push(diff, nab_add(new_data, new_len));
        return;
    }

    size_t ni = 0;
    const uint8_t *base = new_data;
    uint32_t cur_hash = poly_hash16(new_data);

    while (ni + BLK_SIZE <= new_len) {
        uint32_t h_idx = hash_to_idx(cur_hash, idx->bits);
        size_t best_off = 0, best_len = 0;
        int candidates = 0;

        for (uint32_t b = idx->head[h_idx]; b != 0; b = idx->chain[b]) {
            if (++candidates > 32) break;
            if (idx->fps[b] != cur_hash) continue;

            size_t off = (size_t)(b - 1) * BLK_SIZE;
            size_t cmax = (new_len - ni < old_len - off) ? (new_len - ni) : (old_len - off);
            if (cmax < BLK_SIZE) continue;

            size_t ml = 0;
            while (ml + 8 <= cmax) {
                uint64_t v1, v2;
                memcpy(&v1, old_data + off + ml, 8);
                memcpy(&v2, new_data + ni + ml, 8);
                if (v1 != v2) {
                    uint64_t diff_bits = v1 ^ v2;
                    #if defined(__ARM_FEATURE_UNALIGNED) || defined(__aarch64__) || __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
                    ml += (size_t)__builtin_ctzll(diff_bits) >> 3;
                    #else
                    ml += (size_t)__builtin_clzll(diff_bits) >> 3;
                    #endif
                    goto match_extended;
                }
                ml += 8;
            }
            while (ml < cmax && old_data[off + ml] == new_data[ni + ml]) ml++;

match_extended:
            if (ml > best_len) {
                best_off = off;
                best_len = ml;
            }
        }

        if (best_len >= MIN_MATCH) {
            size_t uncommitted = (size_t)(new_data + ni - base);
            size_t back = 0;
            while (back < uncommitted && best_off > back &&
                   old_data[best_off - 1 - back] == new_data[ni - 1 - back]) {
                back++;
            }
            best_off -= back;
            best_len += back;
            ni -= back;

            if (new_data + ni > base) {
                dtob_array_push(diff, nab_add(base, (size_t)(new_data + ni - base)));
            }
            dtob_array_push(diff, nab_copy(best_off, best_off + best_len - 1));

            ni += best_len;
            base = new_data + ni;

            if (ni + BLK_SIZE <= new_len) {
                cur_hash = poly_hash16(new_data + ni);
            }
        } else {
            uint8_t out = new_data[ni];
            uint8_t in  = new_data[ni + BLK_SIZE];
            cur_hash = (uint32_t)((cur_hash - (uint32_t)(out * HASH_C)) * HASH_M + in);
            ni++;
        }
    }

    if (new_data + new_len > base) {
        dtob_array_push(diff, nab_add(base, (size_t)(new_data + new_len - base)));
    }

    free_index(idx);
}

static inline size_t scan_next_ctrl(const uint8_t *buf, size_t len, size_t pos) {
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
                if (DTOB_IS_CTRL(buf[pos + i])) return pos + i;
            }
        }
        pos += 16;
    }
#endif
    while (pos + 1 < len && !DTOB_IS_CTRL(buf[pos])) {
        pos += 2;
    }
    return pos;
}

static inline int get_ctrl_code(const uint8_t *buf, size_t len, size_t pos, uint16_t *out_code) {
    if (pos + 1 >= len) return -1;
    uint8_t b1 = buf[pos];
    uint8_t b2 = buf[pos + 1];
    if (!DTOB_IS_CTRL(b1) || (b1 & 0x20)) return -1;
    *out_code = (uint16_t)(((b1 & 0x1F) << 8) | b2);
    return 0;
}

static inline int ensure_cap(uint8_t **buf, size_t *cap, size_t needed) {
    if (needed <= *cap) return 0;
    size_t new_cap = *cap > 0 ? *cap : 4096;
    while (new_cap < needed) {
        if (new_cap > SIZE_MAX / 2) return -1;
        new_cap *= 2;
    }
    uint8_t *tmp = realloc(*buf, new_cap);
    if (!tmp) return -1;
    *buf = tmp;
    *cap = new_cap;
    return 0;
}

/*
 * Shared streaming parser for byte replay and recipe composition.
 * Callbacks consume copies and encoded literals without constructing a DTOB DOM.
 */
typedef int (*patch_copy_fn)(void *, size_t, size_t);
typedef int (*patch_add_fn)(void *, const uint8_t *, size_t);

static int walk_patch(const uint8_t *patch_buf, size_t patch_len, void *ctx,
                      patch_copy_fn copy, patch_add_fn add) {
    if (!patch_buf || patch_len < 4) return -1;

    size_t pos = 0;

    /* Patch chunk begins with DTOB_OPEN_ARR */
    uint16_t code = 0;
    if (get_ctrl_code(patch_buf, patch_len, pos, &code) != 0 || code != DTOB_OPEN_ARR) {
        return -1;
    }
    pos += 2;

    while (pos < patch_len) {
        /* Skip blast codes if any */
        while (pos + 1 < patch_len) {
            if (get_ctrl_code(patch_buf, patch_len, pos, &code) != 0) return -1;
            if (code == DTOB_BLAST) { pos += 2; continue; }
            break;
        }
        if (pos >= patch_len) return -1;

        if (code == DTOB_CLOSE) {
            return 0;
        }

        if (code != NAB_OP) return -1;
        pos += 2;

        /* Skip blast codes if any */
        while (pos + 1 < patch_len) {
            if (get_ctrl_code(patch_buf, patch_len, pos, &code) != 0) return -1;
            if (code == DTOB_BLAST) { pos += 2; continue; }
            break;
        }

        if (code == NAB_COPY) {
            pos += 2;
            if (get_ctrl_code(patch_buf, patch_len, pos, &code) != 0 || code != DTOB_OPEN_ARR) return -1;
            pos += 2;

            if (get_ctrl_code(patch_buf, patch_len, pos, &code) != 0 || code != NAB_START) return -1;
            pos += 2;

            size_t s_trit_start = pos;
            size_t next_ctrl = scan_next_ctrl(patch_buf, patch_len, pos);
            size_t s_trit_len = next_ctrl - s_trit_start;
            pos = next_ctrl;

            uint8_t s_dec[16];
            if (s_trit_len > 12) return -1;
            size_t s_len = trit_decode_into(patch_buf + s_trit_start, s_trit_len, s_dec);
            if (s_len == 0 && s_trit_len > 0) return -1;
            uint64_t s = 0;
            for (size_t k = 0; k < s_len && k < 8; k++) s = (s << 8) | s_dec[k];

            if (get_ctrl_code(patch_buf, patch_len, pos, &code) != 0 || code != NAB_END) return -1;
            pos += 2;

            size_t e_trit_start = pos;
            next_ctrl = scan_next_ctrl(patch_buf, patch_len, pos);
            size_t e_trit_len = next_ctrl - e_trit_start;
            pos = next_ctrl;

            uint8_t e_dec[16];
            if (e_trit_len > 12) return -1;
            size_t e_len = trit_decode_into(patch_buf + e_trit_start, e_trit_len, e_dec);
            if (e_len == 0 && e_trit_len > 0) return -1;
            uint64_t e = 0;
            for (size_t k = 0; k < e_len && k < 8; k++) e = (e << 8) | e_dec[k];

            if (get_ctrl_code(patch_buf, patch_len, pos, &code) != 0 || code != DTOB_CLOSE) return -1;
            pos += 2;

            if (e < s || e == UINT64_MAX || e >= SIZE_MAX) return -1;
            if (copy(ctx, (size_t)s, (size_t)(e - s + 1)) != 0) return -1;
        } else if (code == NAB_ADD) {
            pos += 2;
            size_t add_trit_start = pos;
            size_t next_ctrl = scan_next_ctrl(patch_buf, patch_len, pos);
            size_t add_trit_len = next_ctrl - add_trit_start;
            pos = next_ctrl;

            if (add_trit_len > 0) {
                if (add(ctx, patch_buf + add_trit_start, add_trit_len) != 0) return -1;
            }
        } else {
            return -1;
        }
    }

    return -1;
}

typedef struct {
    const uint8_t *prev;
    size_t prev_len;
    uint8_t **buf;
    size_t *cap, len;
} stream_output;

static int stream_copy(void *ctx, size_t start, size_t len) {
    stream_output *o = ctx;
    if (!o->prev || start > o->prev_len || len > o->prev_len - start ||
        len > SIZE_MAX - o->len || ensure_cap(o->buf, o->cap, o->len + len)) return -1;
    memcpy(*o->buf + o->len, o->prev + start, len);
    o->len += len;
    return 0;
}

static int stream_add(void *ctx, const uint8_t *trits, size_t len) {
    stream_output *o = ctx;
    size_t max_out = (len / 3) * 2 + 4;
    if (max_out > SIZE_MAX - o->len || ensure_cap(o->buf, o->cap, o->len + max_out)) return -1;
    size_t written = trit_decode_into(trits, len, *o->buf + o->len);
    if (!written) return -1;
    o->len += written;
    return 0;
}

static int apply_patch_stream_into(const uint8_t *prev, size_t prev_len,
                                   const uint8_t *patch_buf, size_t patch_len,
                                   uint8_t **dest_buf, size_t *dest_cap, size_t *dest_len) {
    stream_output o = {prev, prev_len, dest_buf, dest_cap, 0};
    if (walk_patch(patch_buf, patch_len, &o, stream_copy, stream_add)) return -1;
    *dest_len = o.len;
    return 0;
}

#include "rebuild.c"

/* pad a metadata entry so it has a value for every code in meta_type.
 * unknown uint64 fields get 0, unknown raw fields get empty. */
static void pad_metadata_entry(DtobValue *entry, const DtobTypesHeader *th, const DtobCustomType *meta_type) {
    for (size_t j = 0; j < meta_type->num_codes; j++) {
        uint16_t code = meta_type->codes[j];
        bool has_field = false;
        for (size_t k = 0; k < entry->num_elements; k++) {
            if (entry->elements[k].data.val->code == code) { has_field = true; break; }
        }
        if (!has_field) {
            DtobCustomType *ft = dtob_types_get(th, code);
            if (ft && ft->num_codes == 1 && ft->codes[0] == DTOB_RAW) {
                dtob_array_push(entry, dtob_custom(code, NULL, 0));
            } else {
                dtob_array_push(entry, nab_u64_node(code, 0));
            }
        }
    }
}

/* merge file's types header into th: add unknown types and extend metadata struct */
static void merge_types_header(DtobTypesHeader *th, const DtobTypesHeader *file_th) {
    for (size_t i = 0; i < file_th->count; i++) {
        if (!dtob_types_get(th, file_th->entries[i].code)) {
            dtob_types_add(th, file_th->entries[i].code, file_th->entries[i].name,
                          file_th->entries[i].codes, file_th->entries[i].num_codes);
            if (file_th->entries[i].kind == DTOB_STRUCT)
                th->entries[th->count - 1].kind = DTOB_STRUCT;
        }
    }

    DtobCustomType *th_meta = dtob_types_get(th, NAB_METADATA);
    const DtobCustomType *file_meta = dtob_types_get(file_th, NAB_METADATA);
    if (!th_meta || !file_meta) return;

    for (size_t j = 0; j < file_meta->num_codes; j++) {
        uint16_t code = file_meta->codes[j];
        bool found = false;
        for (size_t k = 0; k < th_meta->num_codes; k++) {
            if (th_meta->codes[k] == code) { found = true; break; }
        }
        if (!found) {
            th_meta->codes = realloc(th_meta->codes, (th_meta->num_codes + 1) * sizeof(uint16_t));
            th_meta->codes[th_meta->num_codes++] = code;
        }
    }
}

#include <stdarg.h>

static int g_debug = 0;

static inline double get_time_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e6 + (double)ts.tv_nsec * 1e-3;
}

static void debug_print_time(double t_start, const char *label, const char *extra_fmt, ...) {
    if (!g_debug) return;
    double elapsed_us = get_time_us() - t_start;
    char detail[128] = {0};
    if (extra_fmt && extra_fmt[0]) {
        va_list ap;
        va_start(ap, extra_fmt);
        vsnprintf(detail, sizeof(detail), extra_fmt, ap);
        va_end(ap);
    }
    if (elapsed_us >= 1000.0) {
        fprintf(stderr, "[debug] %-24s %7.2f ms%s\n", label, elapsed_us / 1000.0, detail);
    } else {
        fprintf(stderr, "[debug] %-24s %7.1f µs%s\n", label, elapsed_us, detail);
    }
}

#define DEBUG_TIME_START(name) double t_##name = g_debug ? get_time_us() : 0.0;
#define DEBUG_TIME_PRINT(name, label, ...) debug_print_time(t_##name, label, __VA_ARGS__)

#include "cmd.c"

//====================
// MAIN
//====================

#ifndef NAB_NO_MAIN
/* All CLI archive access holds this inode open and locked. Writers must keep
 * updating that inode in place; replacing/unlinking it requires a different
 * locking protocol. O_CREAT does not truncate a concurrent creator's file. */
static int lock_archive(const char *path, int operation) {
    int flags = operation == LOCK_EX ? O_RDWR | O_CREAT : O_RDONLY;
    int fd = open(path, flags | O_CLOEXEC, 0644);
    if (fd < 0) {
        fprintf(stderr, "nab: cannot open archive '%s': %s\n", path, strerror(errno));
        return -1;
    }
    while (flock(fd, operation) != 0) {
        if (errno == EINTR) continue;
        fprintf(stderr, "nab: cannot lock '%s': %s\n", path, strerror(errno));
        close(fd);
        return -1;
    }
    return fd;
}

static int patch_locked(const char *archive, const char *source, const char *author) {
    if (nab_author_validate((const uint8_t *)author, author ? strlen(author) : 0)) return 1;
    int fd = lock_archive(archive, LOCK_EX);
    if (fd < 0) return 1;
    struct stat st;
    if (fstat(fd, &st) != 0) {
        fprintf(stderr, "nab: cannot access archive '%s': %s\n", archive, strerror(errno));
        close(fd);
        return 1;
    }
    int rc = cmd_patch(archive, source, st.st_size == 0, author);
    close(fd);
    return rc;
}

static int parse_version(const char *text, int *version) {
    if (!text[0] || strspn(text, "0123456789") != strlen(text)) return -1;
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno != 0 || !end || *end != '\0' || value < 0 || value > INT_MAX) {
        return -1;
    }
    *version = (int)value;
    return 0;
}

int main(int argc, char **argv) {
    const char *author = NULL;
    int filtered_argc = 0;
    char *filtered_argv[argc + 1];
    for (int i = 0; i < argc; i++) {
        if (strcmp(argv[i], "--debug") == 0 || strcmp(argv[i], "-d") == 0) {
            g_debug = 1;
        } else if (strcmp(argv[i], "--author") == 0) {
            if (author || i + 1 >= argc) {
                fprintf(stderr, "nab: --author requires one value and may only be passed once\n");
                return 1;
            }
            author = argv[++i];
        } else {
            filtered_argv[filtered_argc++] = argv[i];
        }
    }
    filtered_argv[filtered_argc] = NULL;
    argc = filtered_argc;
    argv = filtered_argv;

    if (argc < 2) {
        fprintf(stderr, "usage: nab [--debug] <command> [args]\n\n");
        fprintf(stderr, "commands:\n");
        fprintf(stderr, "  patch <file> [nab_file]  — create or update .nab\n");
        fprintf(stderr, "  rebuild <file.nab> [v]   — reconstruct content (default: latest)\n");
        fprintf(stderr, "  diff <file.nab> [a] [b]  — compare versions or current file\n");
        fprintf(stderr, "  log <file.nab>           — show version history\n\n");
        fprintf(stderr, "options:\n");
        fprintf(stderr, "  --author <author>        — patch author (maximum 32 bytes)\n");
        fprintf(stderr, "  --debug, -d              — print microsecond step-by-step timings\n");
        return 1;
    }

    const char *cmd = argv[1];
    if (author && strcmp(cmd, "patch") != 0) {
        fprintf(stderr, "nab: --author is only supported by patch\n");
        return 1;
    }

    if (strcmp(cmd, "patch") == 0) {
        if (argc < 3 || argc > 4) {
            fprintf(stderr, "usage: nab [--debug] patch <file> [nab_file] [--author <author>]\n");
            return 1;
        }
        if (argc == 4) {
            if (strlen(argv[3]) > PATH_MAX - 6) {
                fprintf(stderr, "input file name is too big\n");
                return 1;
            }
            return patch_locked(argv[3], argv[2], author);
        } else {
            int fin_len = strlen(argv[2]) + 8;
            char dest[fin_len];
            format_dotfile(argv[2], fin_len, dest);
            return patch_locked(dest, argv[2], author);
        }
    }
    if (strcmp(cmd, "rebuild") == 0) {
        if (argc < 3 || argc > 4) { fprintf(stderr, "usage: nab [--debug] rebuild <file.nab> [zero-based version]\n"); return 1; }
        int version = -1;
        if (argc == 4 && parse_version(argv[3], &version) != 0) {
            fprintf(stderr, "nab: rebuild version must be a non-negative integer\n");
            return 1;
        }
        int fd = lock_archive(argv[2], LOCK_SH);
        if (fd < 0) return 1;
        int rc = cmd_rebuild(argv[2], version);
        close(fd);
        return rc;
    }
    if (strcmp(cmd, "diff") == 0) {
        int from_ver = 0, to_ver = 0;
        int version_count = argc - 3;
        if (argc < 3 || argc > 5) {
            fprintf(stderr, "usage: nab [--debug] diff <file.nab> [<version-a>] [<version-b>]\n");
            return 1;
        }
        if ((version_count >= 1 && parse_version(argv[3], &from_ver) != 0) ||
            (version_count == 2 && parse_version(argv[4], &to_ver) != 0)) {
            fprintf(stderr, "nab: diff versions must be non-negative integers\n");
            return 1;
        }
        int fd = lock_archive(argv[2], LOCK_SH);
        if (fd < 0) return 1;
        int rc = cmd_diff(argv[2], version_count, from_ver, to_ver);
        close(fd);
        return rc;
    }
    if (strcmp(cmd, "log") == 0) {
        if (argc < 3) { fprintf(stderr, "usage: nab [--debug] log <file.nab>\n"); return 1; }
        int fd = lock_archive(argv[2], LOCK_SH);
        if (fd < 0) return 1;
        int rc = cmd_log(argv[2]);
        close(fd);
        return rc;
    }

    fprintf(stderr, "error: unknown command '%s'\n", cmd);
    return 1;
}
#endif
