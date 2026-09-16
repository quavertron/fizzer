/* Compose byte-range recipes on the calling thread, materializing only the
 * final version. Decoded literals remain alive until replay finishes. */

typedef struct {
    const uint8_t *data;
    size_t offset, len, end;
} rebuild_span;

typedef struct {
    rebuild_span *spans;
    size_t count, cap, len;
} rebuild_map;

typedef struct rebuild_literal {
    struct rebuild_literal *next;
    uint8_t data[];
} rebuild_literal;

typedef struct { off_t offset; size_t len; } rebuild_patch;

static int map_append(rebuild_map *m, const uint8_t *data, size_t offset, size_t len) {
    if (!len) return 0;
    if (len > SIZE_MAX - m->len) return -1;
    if (m->count) {
        rebuild_span *last = &m->spans[m->count - 1];
        if (last->data == data && last->offset + last->len == offset) {
            last->len += len;
            m->len += len;
            last->end = m->len;
            return 0;
        }
    }
    if (m->count == m->cap) {
        size_t cap = m->cap ? m->cap * 2 : 32;
        if (cap < m->cap || cap > SIZE_MAX / sizeof(rebuild_span)) return -1;
        rebuild_span *p = realloc(m->spans, cap * sizeof(*p));
        if (!p) return -1;
        m->spans = p;
        m->cap = cap;
    }
    m->len += len;
    m->spans[m->count++] = (rebuild_span){data, offset, len, m->len};
    return 0;
}

static int map_slice(rebuild_map *dst, const rebuild_map *src, size_t start, size_t len) {
    if (start > src->len || len > src->len - start) return -1;
    size_t lo = 0, hi = src->count;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (src->spans[mid].end <= start) lo = mid + 1;
        else hi = mid;
    }
    while (len) {
        const rebuild_span *s = &src->spans[lo++];
        size_t skip = start - (s->end - s->len);
        size_t n = s->len - skip;
        if (n > len) n = len;
        if (map_append(dst, s->data, s->offset + skip, n)) return -1;
        start += n;
        len -= n;
    }
    return 0;
}

typedef struct {
    rebuild_literal **literals;
    const rebuild_map *prev;
    rebuild_map *next;
} map_output;

static int map_copy(void *ctx, size_t start, size_t len) {
    map_output *o = ctx;
    return map_slice(o->next, o->prev, start, len);
}

static int map_add(void *ctx, const uint8_t *trits, size_t len) {
    map_output *o = ctx;
    size_t cap = (len / 3) * 2 + 4;
    if (cap > SIZE_MAX - sizeof(rebuild_literal)) return -1;
    rebuild_literal *literal = malloc(sizeof(*literal) + cap);
    if (!literal) return -1;
    literal->next = *o->literals;
    *o->literals = literal;
    size_t written = trit_decode_into(trits, len, literal->data);
    if (!written) return -1;
    return map_append(o->next, literal->data, 0, written);
}

static int read_rebuild_patch(int fd, rebuild_patch p, uint8_t **buf, size_t *cap) {
    if (ensure_cap(buf, cap, p.len)) return -1;
    size_t done = 0;
    while (done < p.len) {
        ssize_t n = pread(fd, *buf + done, p.len - done, p.offset + (off_t)done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

static int replay_compose(int fd, const rebuild_patch *patches, size_t count,
                          uint8_t **out, size_t *out_len) {
    rebuild_map cur = {0}, next = {0};
    rebuild_literal *literals = NULL;
    uint8_t *buf = NULL;
    size_t cap = 0;
    int rc = -1;
    for (size_t i = 0; i < count; i++) {
        next.count = next.len = 0;
        map_output o = {&literals, &cur, &next};
        if (read_rebuild_patch(fd, patches[i], &buf, &cap) ||
            walk_patch(buf, patches[i].len, &o, map_copy, map_add)) goto done;
        rebuild_map swap = cur; cur = next; next = swap;
    }
    uint8_t *result = malloc(cur.len ? cur.len : 1);
    if (!result) goto done;
    for (size_t k = 0; k < cur.count; k++) {
        rebuild_span s = cur.spans[k];
        memcpy(result + s.end - s.len, s.data + s.offset, s.len);
    }
    *out = result; *out_len = cur.len;
    rc = 0;
done:
    free(cur.spans);
    free(next.spans);
    free(buf);
    while (literals) {
        rebuild_literal *next_literal = literals->next;
        free(literals);
        literals = next_literal;
    }
    return rc;
}

static int replay_serial(int fd, const rebuild_patch *patches, size_t count,
                         uint8_t **out, size_t *out_len) {
    uint8_t *cur = NULL, *next = NULL, *buf = NULL;
    size_t cur_cap = 0, next_cap = 0, len = 0, cap = 0;
    int rc = -1;
    for (size_t i = 0; i < count; i++) {
        size_t next_len = 0;
        if (read_rebuild_patch(fd, patches[i], &buf, &cap) ||
            apply_patch_stream_into(cur, len, buf, patches[i].len, &next, &next_cap, &next_len)) goto done;
        uint8_t *swap = cur; cur = next; next = swap;
        size_t swap_cap = cur_cap; cur_cap = next_cap; next_cap = swap_cap;
        len = next_len;
    }
    *out = cur; *out_len = len;
    cur = NULL;
    rc = 0;
done:
    free(cur); free(next); free(buf);
    return rc;
}

static int replay_archive(int fd, uint64_t base, const DtobValue *metadata,
                          DtobTypesHeader *th, size_t first, size_t target,
                          uint8_t **out, size_t *out_len) {
    if (first >= target || target > metadata->num_elements) return -1;
    size_t count = target - first;
    rebuild_patch *patches = calloc(count, sizeof(*patches));
    if (!patches) return -1;
    struct stat st;
    if (fstat(fd, &st) || st.st_size < 0) { free(patches); return -1; }
    for (size_t i = 0; i < count; i++) {
        DtobValue *entry = metadata->elements[first + i].data.val;
        uint64_t off = dtob_extract_u64(dgsvfn(th, entry, "byte_offset"));
        uint64_t len = dtob_extract_u64(dgsvfn(th, entry, "byte_len"));
        uint64_t size = (uint64_t)st.st_size;
        if (base > size || off > size - base || len > size - base - off || len > SIZE_MAX) {
            free(patches); return -1;
        }
        patches[i] = (rebuild_patch){(off_t)(base + off), (size_t)len};
    }
    const char *mode = getenv("NAB_REBUILD_MODE");
    bool compose = true;
    if (mode && *mode && strcmp(mode, "auto") != 0) {
        if (strcmp(mode, "compose") == 0) compose = true;
        else if (strcmp(mode, "serial") == 0) compose = false;
        else {
            fprintf(stderr, "nab: NAB_REBUILD_MODE must be auto, serial, or compose\n");
            free(patches); return -1;
        }
    }
    int rc = compose ? replay_compose(fd, patches, count, out, out_len) :
                       replay_serial(fd, patches, count, out, out_len);
    free(patches);
    return rc;
}
