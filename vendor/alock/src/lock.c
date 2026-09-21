/*
 * lock.c — lock table management
 *
 * rules implemented:
 *   2. locks identified by byte_start + length
 *   4. writes adjust all locks below edit point
 *   5. agents can only write within their own locked ranges
 *   6. (corollary) relative ordering of any agent's locks is invariant
 *   7. locks expire after TTL
 */
#include "lock.h"
#include <string.h>
#include <stdio.h>
#include <sys/stat.h>

void locktable_init(LockTable *lt) {
    memset(lt, 0, sizeof(*lt));
    lt->next_id = 1;
}

int lock_matches_file(const Lock *l, const char *file) {
    if (strcmp(l->file, file) == 0) return 1;
    if (l->ino > 0) {
        struct stat st;
        if (stat(file, &st) == 0 && st.st_ino > 0) {
            return (l->dev == st.st_dev && l->ino == st.st_ino);
        }
    }
    return 0;
}

int lines_to_bytes(const char *file, uint32_t line_start, uint32_t line_end,
                   off_t *byte_start, size_t *length) {
    if (line_start == 0 || line_end == 0 || line_end < line_start) return -1;
    FILE *f = fopen(file, "r");
    if (!f) return -1;

    uint32_t line = 1;
    off_t offset = 0;
    off_t start = -1;
    off_t end = 0;
    int c;
    int last_c = -1;

    while ((c = fgetc(f)) != EOF) {
        if (line == line_start && start < 0)
            start = offset;
        if (c == '\n') {
            if (line == line_end) {
                end = offset + 1;
                last_c = c;
                break;
            }
            line++;
        }
        offset++;
        last_c = c;
    }

    if (start < 0) {
        int valid_insert = 0;
        if (offset == 0 && line_start == 1)
            valid_insert = 1;
        else if (offset > 0 && last_c == '\n' && line_start == line)
            valid_insert = 1;
        else if (offset > 0 && last_c != '\n' && line_start == line + 1)
            valid_insert = 1;

        if (!valid_insert) {
            fclose(f);
            return -1;
        }
        start = offset;
    }

    if (end == 0) end = offset;

    *byte_start = start;
    *length = (size_t)(end - start);

    fclose(f);
    return 0;
}

/* check if two byte ranges overlap */
static int ranges_overlap(off_t a_start, size_t a_len, off_t b_start, size_t b_len) {
    /* Empty files and insertion points still need mutual exclusion. */
    if (!a_len && !b_len) return a_start == b_start;
    if (!a_len) return a_start >= b_start && a_start <= b_start + (off_t)b_len;
    if (!b_len) return b_start >= a_start && b_start <= a_start + (off_t)a_len;
    off_t a_end = a_start + (off_t)a_len;
    off_t b_end = b_start + (off_t)b_len;
    return a_start < b_end && b_start < a_end;
}

Lock *lock_blocker(LockTable *lt, const char *agent, const char *file, off_t start, size_t length) {
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt->entries[i];
        if (l->active && lock_matches_file(l, file) && strcmp(l->agent, agent) &&
            ranges_overlap(start, length, l->byte_start, l->length)) return l;
    }
    return NULL;
}

int lock_acquire(LockTable *lt, const char *agent, const char *file,
                 off_t byte_start, size_t length,
                 uint32_t line_start, uint32_t line_end) {
    if (lt->count >= MAX_LOCKS) return -1;

    /* check for overlapping locks from other agents */
    for (int i = 0; i < MAX_LOCKS; i++) {
        const Lock *l = &lt->entries[i];
        if (!l->active) continue;
        if (!lock_matches_file(l, file)) continue;
        if (strcmp(l->agent, agent) == 0) continue;
        if (ranges_overlap(byte_start, length, l->byte_start, l->length))
            return -1;
    }

    int slot = -1;
    for (int i = 0; i < MAX_LOCKS; i++) {
        if (!lt->entries[i].active) { slot = i; break; }
    }
    if (slot < 0) return -1;

    Lock *l = &lt->entries[slot];
    l->id = lt->next_id++;
    strncpy(l->agent, agent, sizeof(l->agent) - 1);
    l->agent[sizeof(l->agent) - 1] = '\0';
    snprintf(l->display_agent, sizeof(l->display_agent), "%s", agent);
    strncpy(l->file, file, sizeof(l->file) - 1);
    l->file[sizeof(l->file) - 1] = '\0';
    struct stat st;
    if (stat(file, &st) == 0) {
        l->dev = st.st_dev;
        l->ino = st.st_ino;
    } else {
        l->dev = 0;
        l->ino = 0;
    }
    l->byte_start = byte_start;
    l->length = length;
    l->line_start = line_start;
    l->line_end = line_end;
    l->active = 1;
    l->acquired_at = time(NULL);
    l->ttl_seconds = DEFAULT_TTL;
    lt->count++;

    return l->id;
}

void lock_release_id(LockTable *lt, int id) {
    Lock *l = lock_find(lt, id);
    if (!l) return;
    l->active = 0;
    lt->count--;
    if (lt->on_release) lt->on_release(l);
}

int lock_release_agent(LockTable *lt, const char *agent, const char *file) {
    int released = 0;
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt->entries[i];
        if (!l->active) continue;
        if (!lock_matches_file(l, file)) continue;
        if (strcmp(l->agent, agent) != 0) continue;
        lock_release_id(lt, l->id);
        released++;
    }
    return released > 0 ? 0 : -1;
}

int lock_release_all_agent(LockTable *lt, const char *agent) {
    int released = 0;
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt->entries[i];
        if (!l->active) continue;
        if (strcmp(l->agent, agent) != 0) continue;
        lock_release_id(lt, l->id);
        released++;
    }
    return released > 0 ? 0 : -1;
}


/* rule 4: adjust locks below edit point */
void lock_adjust(LockTable *lt, const char *file,
                 off_t edit_offset, ssize_t delta) {
    struct stat st;
    int has_st = (stat(file, &st) == 0);
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt->entries[i];
        if (!l->active) continue;
        if (!lock_matches_file(l, file)) continue;

        if (has_st) {
            l->dev = st.st_dev;
            l->ino = st.st_ino;
        }

        /* lock starts after edit point — shift it */
        if (l->byte_start > edit_offset) {
            l->byte_start += delta;
        }
        /* edit is inside the lock — grow/shrink the lock */
        else if (edit_offset >= l->byte_start &&
                 edit_offset < l->byte_start + (off_t)l->length) {
            l->length = (size_t)((ssize_t)l->length + delta);
        }
    }
}

void lock_adjust_lines(LockTable *lt, const char *file,
                       uint32_t after_line, ssize_t delta) {
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt->entries[i];
        if (!l->active) continue;
        if (!lock_matches_file(l, file)) continue;

        if (l->line_start > after_line) {
            l->line_start = (uint32_t)((ssize_t)l->line_start + delta);
            l->line_end   = (uint32_t)((ssize_t)l->line_end + delta);
        }
        else if (after_line >= l->line_start && after_line <= l->line_end) {
            l->line_end = (uint32_t)((ssize_t)l->line_end + delta);
        }
    }
}

/* rule 7 */
void lock_expire(LockTable *lt) {
    time_t now = time(NULL);
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt->entries[i];
        if (!l->active || l->ttl_seconds == 0) continue;
        if (now - l->acquired_at > l->ttl_seconds) {
            lock_release_id(lt, l->id);
        }
    }
}

Lock *lock_find(LockTable *lt, int lock_id) {
    for (int i = 0; i < MAX_LOCKS; i++) {
        if (lt->entries[i].active && lt->entries[i].id == lock_id)
            return &lt->entries[i];
    }
    return NULL;
}
