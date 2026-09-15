#include "daemon.h"
#include "lock.h"
#include "ipc.h"
#include "history.h"
#include "turns.h"
#include "events.h"
#include <dtob.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <poll.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <signal.h>
#include <sys/un.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/file.h>

#define EXPIRE_INTERVAL_MS 30000
#ifndef AWATCH_SOCK
#define AWATCH_SOCK "/tmp/awatch.sock"
#endif

static DtobValue *split_lines_dtob(const char *data, size_t len) {
    DtobValue *arr = dtob_array();
    const char *start = data;
    for (size_t i = 0; i <= len; i++) {
        if (i == len || data[i] == '\n') {
            size_t line_len = &data[i] - start;
            dtob_array_push(arr, dtob_raw((const uint8_t *)start, line_len));
            if (i < len) start = &data[i + 1];
        }
    }
    return arr;
}

static const char *event_agent(DtobValue *req, const char *fallback) {
    static char name[128];
    dtob_kvset_str(req, "display_agent", name, sizeof(name));
    return name[0] ? name : fallback;
}

static void awatch_notify(const char *agent, const char *author, const char *file,
                           uint32_t line_start, uint32_t line_end,
                           const char *old_data, size_t old_len,
                           const char *new_data, size_t new_len) {
    uint32_t changed_lines = 0;
    for (size_t i = 0; i < new_len; i++) changed_lines += new_data[i] == '\n';
    events_change(file, line_start, line_start + (changed_lines ? changed_lines - 1 : 0), agent, author);
    int fd = ipc_connect(AWATCH_SOCK);
    if (fd < 0) return;

    /* strip trailing newline from old/new to avoid empty last element */
    if (old_len > 0 && old_data[old_len - 1] == '\n') old_len--;
    if (new_len > 0 && new_data[new_len - 1] == '\n') new_len--;

    DtobValue *ev = dtob_kvset();
    dtob_kvset_put(ev, "agent", dtob_raw((const uint8_t *)agent, strlen(agent)));
    dtob_kvset_put(ev, "author", dtob_raw((const uint8_t *)author, strlen(author)));
    dtob_kvset_put(ev, "file", dtob_raw((const uint8_t *)file, strlen(file)));
    dtob_kvset_put(ev, "line_start", dtob_uint(line_start));
    dtob_kvset_put(ev, "line_end", dtob_uint(line_end));
    dtob_kvset_put(ev, "old_lines", split_lines_dtob(old_data, old_len));
    dtob_kvset_put(ev, "new_lines", split_lines_dtob(new_data, new_len));
    dtob_kvset_put(ev, "timestamp", dtob_int((int64_t)time(NULL)));

    size_t enc_len;
    uint8_t *enc = dtob_encode(ev, &enc_len);
    dtob_free(ev);

    if (enc) {
        ipc_send(fd, enc, enc_len);
        free(enc);
    }
    close(fd);
}

static const char *lock_display_agent(const char *agent);

static void awatch_lock_notify(const char *agent, const char *file,
                                uint32_t line_start, uint32_t line_end,
                                const char *result, const char *conflict_agent) {
    int fd = ipc_connect(AWATCH_SOCK);
    if (fd < 0) return;

    DtobValue *ev = dtob_kvset();
    dtob_kvset_put(ev, "kind", dtob_raw((const uint8_t *)"lock", 4));
    dtob_kvset_put(ev, "agent", dtob_raw((const uint8_t *)agent, strlen(agent)));
    dtob_kvset_put(ev, "file", dtob_raw((const uint8_t *)file, strlen(file)));
    dtob_kvset_put(ev, "line_start", dtob_uint(line_start));
    dtob_kvset_put(ev, "line_end", dtob_uint(line_end));
    dtob_kvset_put(ev, "result", dtob_raw((const uint8_t *)result, strlen(result)));
    if (conflict_agent) conflict_agent = lock_display_agent(conflict_agent);
    if (conflict_agent)
        dtob_kvset_put(ev, "conflict_agent", dtob_raw((const uint8_t *)conflict_agent, strlen(conflict_agent)));
    dtob_kvset_put(ev, "timestamp", dtob_int((int64_t)time(NULL)));

    size_t enc_len;
    uint8_t *enc = dtob_encode(ev, &enc_len);
    dtob_free(ev);

    if (enc) {
        ipc_send(fd, enc, enc_len);
        free(enc);
    }
    close(fd);
}


static LockTable lt;
static char current_turn[TURN_ID_SIZE];

static int record_history(const char *file, const char *author, const char *operation,
                          const void *before, size_t before_size, const void *after, size_t after_size,
                          char *error, size_t error_size) {
    return history_record_turn(current_turn, turn_defer(current_turn, file), file, author, operation,
                               before, before_size, after, after_size, error, error_size);
}
static char daemon_file[4096];
static char daemon_sock[4096];

static DtobValue *make_ok_lock(const Lock *l) {
    DtobValue *resp = dtob_kvset();
    dtob_kvset_put(resp, "ok", dtob_uint(1));
    dtob_kvset_put(resp, "lock", dtob_int(l->id));
    dtob_kvset_put(resp, "line_start", dtob_uint(l->line_start));
    dtob_kvset_put(resp, "line_end", dtob_uint(l->line_end));
    dtob_kvset_put(resp, "byte_start", dtob_int(l->byte_start));
    dtob_kvset_put(resp, "length", dtob_uint(l->length));
    return resp;
}

static DtobValue *make_ok_edit_response(const Lock *l, uint32_t edit_ls, int new_newlines) {
    DtobValue *resp = make_ok_lock(l);
    dtob_kvset_put(resp, "edit_line_start", dtob_uint(edit_ls));
    uint32_t edit_end = edit_ls + (new_newlines > 0 ? new_newlines - 1 : 0);
    dtob_kvset_put(resp, "edit_line_end", dtob_uint(edit_end));
    return resp;
}

static DtobValue *make_error(const char *msg) {
    DtobValue *resp = dtob_kvset();
    dtob_kvset_put(resp, "ok", dtob_uint(0));
    dtob_kvset_put(resp, "error", dtob_raw((const uint8_t *)msg, strlen(msg)));
    return resp;
}

static Lock *find_covering_lock(const char *agent, uint32_t line_start,
                                uint32_t line_end) {
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt.entries[i];
        if (l->active && strcmp(l->file, daemon_file) == 0 &&
            strcmp(l->agent, agent) == 0 &&
            line_start >= l->line_start && line_end <= l->line_end)
            return l;
    }
    return NULL;
}

static DtobValue *handle_acquire(DtobValue *req) {
    char agent[128];
    dtob_kvset_str(req, "agent", agent, sizeof(agent));
    uint32_t ls = (uint32_t)dtob_kvset_uint(req, "line_start");
    uint32_t le = (uint32_t)dtob_kvset_uint(req, "line_end");

    off_t byte_start;
    size_t length;
    if (lines_to_bytes(daemon_file, ls, le, &byte_start, &length) != 0)
        return make_error("cannot read file");

    lock_expire(&lt);
    if (turn_prepare(current_turn, daemon_file)) return make_error("cannot flush history or join turn before granting lock");
    int id = lock_acquire(&lt, agent, daemon_file, byte_start, length, ls, le);
    if (id < 0) {
        /* find blocking lock to name the conflicting agent */
        const char *blocker = NULL;
        for (int i = 0; i < MAX_LOCKS; i++) {
            const Lock *l = &lt.entries[i];
            if (!l->active) continue;
            if (strcmp(l->file, daemon_file) != 0) continue;
            if (strcmp(l->agent, agent) == 0) continue;
            off_t a0 = byte_start, a1 = byte_start + (off_t)length;
            off_t b0 = l->byte_start, b1 = l->byte_start + (off_t)l->length;
            if (a0 < b1 && b0 < a1) { blocker = l->agent; break; }
        }
        awatch_lock_notify(event_agent(req, agent), daemon_file, ls, le, "conflict", blocker);
        return make_error("conflict — range is locked by another agent");
    }

    /* granted — check if another agent holds a (non-overlapping) lock on the same file */
    const char *coholder = NULL;
    for (int i = 0; i < MAX_LOCKS; i++) {
        const Lock *l = &lt.entries[i];
        if (!l->active) continue;
        if (l->id == id) continue;
        if (strcmp(l->file, daemon_file) != 0) continue;
        if (strcmp(l->agent, agent) == 0) continue;
        coholder = l->agent;
        break;
    }
    awatch_lock_notify(event_agent(req, agent), daemon_file, ls, le,
                       coholder ? "shared" : "granted", coholder);
    Lock *l = lock_find(&lt, id);
    turn_join(current_turn, daemon_file);
    return make_ok_lock(l);
}

static uint8_t *read_regular(const char *path, size_t *size, mode_t *mode);
static int write_all(int fd, const uint8_t *buf, size_t size);

/* All accepted edits use this single atomic splice/notify/adjust path. */
static DtobValue *apply_edit(Lock *lock, const uint8_t *current, size_t size,
                            size_t start, size_t length, const uint8_t *content,
                            size_t content_len, mode_t mode, uint32_t ls, uint32_t le, int create, const char *author, const char *display_agent) {
    if (start > size || length > size - start)
        return make_error("edit range is outside the current file");
    char temp[4096];
    if (snprintf(temp, sizeof(temp), "%s.alock-XXXXXX", daemon_file) >= (int)sizeof(temp))
        return make_error("target path too long");
    int fd = mkstemp(temp);
    if (fd < 0) return make_error("cannot create replacement file");
    int failed = fchmod(fd, mode) || write_all(fd, current, start) ||
        write_all(fd, content, content_len) ||
        write_all(fd, current + start + length, size - start - length) || fsync(fd);
    if (close(fd)) failed = 1;
    if (!failed) {
        if (create) { failed = link(temp, daemon_file); unlink(temp); }
        else failed = rename(temp, daemon_file);
    }
    if (failed) { unlink(temp); return make_error("cannot commit replacement file"); }

    int old_lines = 0, new_lines = 0;
    for (size_t i = 0; i < length; i++) old_lines += current[start + i] == '\n';
    for (size_t i = 0; i < content_len; i++) new_lines += content[i] == '\n';
    awatch_notify(display_agent, author, daemon_file, ls, le,
        (const char *)current + start, length, (const char *)content, content_len);
    lock_adjust(&lt, daemon_file, (off_t)start, (ssize_t)content_len - (ssize_t)length);
    lock_adjust_lines(&lt, daemon_file, le, new_lines - old_lines);
    DtobValue *response = make_ok_edit_response(lock, ls, new_lines);
    char config_error[512];
    if (history_enabled(config_error, sizeof(config_error)) == 0) return response;
    size_t updated_size = size - length + content_len;
    uint8_t *updated = malloc(updated_size ? updated_size : 1);
    char history_error[512] = "File changed but cannot allocate nab snapshot";
    int failed_history = !updated;
    if (updated) {
        memcpy(updated, current, start);
        memcpy(updated + start, content, content_len);
        memcpy(updated + start + content_len, current + start + length, size - start - length);
        failed_history = record_history(daemon_file, author, create ? "create" : "edit", current, size,
                                        updated, updated_size, history_error, sizeof(history_error));
        free(updated);
    }
    if (failed_history) dtob_kvset_put(response, "historyError", dtob_raw((uint8_t *)history_error, strlen(history_error)));
    return response;
}

static DtobValue *handle_write(DtobValue *req) {
    char author[128], error[512] = "Invalid alock.toml";
    dtob_kvset_str(req, "author", author, sizeof(author));
    if (!history_author_valid(author)) return make_error("--author is required (1-32 bytes, no control characters)");
    if (history_enabled(error, sizeof(error)) < 0) return make_error(error);
    char agent[128];
    dtob_kvset_str(req, "agent", agent, sizeof(agent));
    uint32_t ls = (uint32_t)dtob_kvset_uint(req, "line_start");
    uint32_t le = (uint32_t)dtob_kvset_uint(req, "line_end");
    size_t content_len;
    const uint8_t *content = dtob_kvset_raw(req, "content", &content_len);
    if (!content) return make_error("missing content");
    if (!ls || le < ls) return make_error("invalid write range");
    Lock *lock = find_covering_lock(agent, ls, le);
    if (!lock) return make_error("no covering lock for this range");

    off_t start;
    size_t length, size;
    mode_t mode;
    if (lines_to_bytes(daemon_file, ls, le, &start, &length))
        return make_error("cannot read file");
    if (start < lock->byte_start || (size_t)(start - lock->byte_start) > lock->length ||
        length > lock->length - (size_t)(start - lock->byte_start))
        return make_error("write extends outside the locked bytes");
    uint8_t *current = read_regular(daemon_file, &size, &mode);
    if (!current) return make_error("cannot read regular file (maximum 32 MiB)");
    DtobValue *resp = apply_edit(lock, current, size, (size_t)start, length,
                                content, content_len, mode, ls, le, 0, author, event_agent(req, lock->agent));
    free(current);
    return resp;
}

static DtobValue *handle_check(DtobValue *req) {
    char agent[128];
    dtob_kvset_str(req, "agent", agent, sizeof(agent));

    lock_expire(&lt);
    for (int i = 0; i < MAX_LOCKS; i++) {
        const Lock *l = &lt.entries[i];
        if (!l->active) continue;
        if (strcmp(l->file, daemon_file) != 0) continue;
        if (strcmp(l->agent, agent) == 0) {
            DtobValue *resp = dtob_kvset();
            dtob_kvset_put(resp, "ok", dtob_uint(1));
            return resp;
        }
    }
    return make_error("agent has no lock on this file");
}

static DtobValue *handle_release(DtobValue *req) {
    char agent[128];
    dtob_kvset_str(req, "agent", agent, sizeof(agent));

    if (lock_release_agent(&lt, agent, daemon_file) != 0)
        return make_error("no locks found");

    DtobValue *resp = dtob_kvset();
    dtob_kvset_put(resp, "ok", dtob_uint(1));
    return resp;
}

static DtobValue *handle_release_agent(DtobValue *req) {
    char agent[128];
    dtob_kvset_str(req, "agent", agent, sizeof(agent));

    lock_release_all_agent(&lt, agent);

    DtobValue *resp = dtob_kvset();
    dtob_kvset_put(resp, "ok", dtob_uint(1));
    return resp;
}

static DtobValue *handle_status(DtobValue *req) {
    char requested_file[4096] = {0};
    dtob_kvset_str(req, "file", requested_file, sizeof(requested_file));
    lock_expire(&lt);

    DtobValue *resp = dtob_kvset();
    dtob_kvset_put(resp, "ok", dtob_uint(1));
    dtob_kvset_put(resp, "file",
                   dtob_raw((const uint8_t *)requested_file, strlen(requested_file)));

    DtobValue *locks_arr = dtob_array();
    for (int i = 0; i < MAX_LOCKS; i++) {
        Lock *l = &lt.entries[i];
        if (!l->active) continue;
        if (requested_file[0] && strcmp(l->file, requested_file) != 0) continue;

        int remaining = l->ttl_seconds - (int)(time(NULL) - l->acquired_at);
        if (remaining < 0) remaining = 0;

        DtobValue *entry = dtob_kvset();
        dtob_kvset_put(entry, "lock", dtob_int(l->id));
        dtob_kvset_put(entry, "agent",
                       dtob_raw((const uint8_t *)l->agent, strlen(l->agent)));
        dtob_kvset_put(entry, "file",
                       dtob_raw((const uint8_t *)l->file, strlen(l->file)));
        dtob_kvset_put(entry, "line_start", dtob_uint(l->line_start));
        dtob_kvset_put(entry, "line_end", dtob_uint(l->line_end));
        dtob_kvset_put(entry, "byte_start", dtob_int(l->byte_start));
        dtob_kvset_put(entry, "length", dtob_uint(l->length));
        dtob_kvset_put(entry, "ttl", dtob_int(remaining));
        dtob_array_push(locks_arr, entry);
    }
    if (locks_arr->num_elements > 0)
        dtob_kvset_put(resp, "locks", locks_arr);
    else
        dtob_free(locks_arr);

    return resp;
}

/* Staging is kept in the daemon: clients cannot change the approved baseline. */
typedef struct {
    int id, existed, deleting, destination_id;
    int leaf_link, make_link;
    struct stat identity;
    char destination[4096];
    char path[4096];
    char display_agent[128];
    char turn[TURN_ID_SIZE];
    uint8_t *base;
    size_t size, start, length;
    mode_t mode;
} Stage;
static Stage stages[MAX_LOCKS];

static uint8_t *read_symlink(const char *path, size_t *size) {
    uint8_t *data = malloc(4096);
    if (!data) return NULL;
    ssize_t n = readlink(path, (char *)data, 4096);
    if (n < 0 || n == 4096) { free(data); return NULL; }
    *size = (size_t)n;
    return data;
}

static const char *lock_display_agent(const char *agent) {
    for (int i = 0; i < MAX_LOCKS; i++) {
        if (!stages[i].id || !stages[i].display_agent[0]) continue;
        Lock *lock = lock_find(&lt, stages[i].id);
        if (lock && lock->active && !strcmp(lock->agent, agent)) return stages[i].display_agent;
    }
    return agent;
}

static uint8_t *read_regular(const char *path, size_t *size, mode_t *mode) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return NULL;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size > 32 * 1024 * 1024) {
        close(fd); return NULL;
    }
    *size = (size_t)st.st_size;
    *mode = st.st_mode & 0777;
    uint8_t *buf = malloc(*size + 1);
    size_t pos = 0;
    while (buf && pos < *size) {
        ssize_t n = read(fd, buf + pos, *size - pos);
        if (n <= 0) { free(buf); buf = NULL; break; }
        pos += (size_t)n;
    }
    close(fd);
    return buf;
}

static int write_all(int fd, const uint8_t *buf, size_t size) {
    while (size) {
        ssize_t n = write(fd, buf, size);
        if (n <= 0) return -1;
        buf += n; size -= (size_t)n;
    }
    return 0;
}

static void clear_stage(Stage *s) {
    Lock *source = lock_find(&lt, s->id);
    Lock *destination = lock_find(&lt, s->destination_id);
    if (source) { source->active = 0; lt.count--; }
    if (destination) { destination->active = 0; lt.count--; }
    unlink(s->path);
    free(s->base);
    memset(s, 0, sizeof(*s));
}

static void release_turn_locks(const char *id) {
    for (int i = 0; i < MAX_LOCKS; i++)
        if (stages[i].id && !strcmp(stages[i].turn, id)) clear_stage(&stages[i]);
}

static void reap_stages(void) {
    for (int i = 0; i < MAX_LOCKS; i++)
        if (stages[i].id && (!lock_find(&lt, stages[i].id) ||
            (stages[i].destination_id && !lock_find(&lt, stages[i].destination_id)))) clear_stage(&stages[i]);
}

static DtobValue *handle_stage(DtobValue *req) {
    char agent[128] = {0};
    dtob_kvset_str(req, "agent", agent, sizeof(agent));
    uint32_t ls = (uint32_t)dtob_kvset_uint(req, "line_start");
    uint32_t le = (uint32_t)dtob_kvset_uint(req, "line_end");
    if (!agent[0] || !ls || le < ls) return make_error("invalid stage range or agent");
    Stage s = {0};
    strcpy(s.turn, current_turn);
    snprintf(s.display_agent, sizeof(s.display_agent), "%s", event_agent(req, agent));
    s.deleting = dtob_kvset_uint(req, "delete") != 0;
    s.leaf_link = dtob_kvset_uint(req, "replace_symlink") != 0;
    s.make_link = dtob_kvset_uint(req, "make_symlink") != 0;
    dtob_kvset_str(req, "destination", s.destination, sizeof(s.destination));
    int moving = s.destination[0] != 0;
    if ((s.leaf_link && (moving || ls != 1 || le != 2147483647)) ||
        (s.make_link && (!s.leaf_link || s.deleting))) return make_error("invalid symlink operation");
    if ((s.deleting && moving) || ((s.deleting || moving) && (ls != 1 || le != 2147483647)))
        return make_error("delete/rename requires an exclusive whole-file stage");
    if (s.deleting || moving || s.leaf_link) {
        for (int i = 0; i < MAX_LOCKS; i++)
            if (lt.entries[i].active && (!strcmp(lt.entries[i].file, daemon_file) ||
                (moving && !strcmp(lt.entries[i].file, s.destination))))
                return make_error("conflict: source or destination is locked");
        struct stat dst;
        if (moving && (!strcmp(daemon_file, s.destination) ||
            lstat(s.destination, &dst) == 0 || errno != ENOENT))
            return make_error("rename destination must not exist");
    }
    struct stat st;
    s.existed = lstat(daemon_file, &st) == 0;
    if (s.existed) s.identity = st;
    if (s.leaf_link && (!s.existed || !S_ISLNK(st.st_mode))) return make_error("expected existing symlink");
    if (!s.existed && (s.deleting || moving)) return make_error("source must exist");
    if (s.leaf_link) { s.base = read_symlink(daemon_file, &s.size); s.mode = 0644; }
    else if (s.existed) s.base = read_regular(daemon_file, &s.size, &s.mode);
    else if (errno == ENOENT && ls == 1) { s.base = calloc(1, 1); s.mode = 0644; }
    if (!s.base) return make_error("stage requires a regular file (maximum 32 MiB) or new file at line 1");
    /* Use exactly the same line boundaries as write, without a second file read. */
    uint32_t line = 1;
    size_t end = s.size;
    s.start = ls == 1 ? 0 : s.size;
    for (size_t i = 0; i < s.size; i++) {
        if (s.base[i] != '\n') continue;
        if (line == le) { end = i + 1; break; }
        if (++line == ls) s.start = i + 1;
    }
    if (ls > line && s.start == s.size && ls != line) {
        free(s.base); return make_error("stage range starts beyond EOF");
    }
    s.length = end - s.start;
    if (turn_prepare(current_turn, daemon_file) || (moving && turn_prepare(current_turn, s.destination))) {
        free(s.base); return make_error("cannot flush history or join turn before granting lock");
    }
    s.id = lock_acquire(&lt, agent, daemon_file, (off_t)s.start, s.length, ls, le);
    if (s.id < 0) { free(s.base); return make_error("conflict: stage range is locked"); }
    if (moving) {
        s.destination_id = lock_acquire(&lt, agent, s.destination, 0, 0, 1, 2147483647);
        if (s.destination_id < 0) { clear_stage(&s); return make_error("cannot reserve rename destination"); }
    }
    snprintf(s.path, sizeof(s.path), "%s/stage-XXXXXX", ALOCK_SOCK_DIR);
    int fd = mkstemp(s.path);
    int failed = fd < 0 || write_all(fd, s.base, s.size);
    if (fd >= 0 && close(fd)) failed = 1;
    if (failed) {
        Lock *l = lock_find(&lt, s.id); l->active = 0; lt.count--;
        clear_stage(&s); return make_error("cannot create staging file");
    }
    for (int i = 0; i < MAX_LOCKS; i++) if (!stages[i].id) { stages[i] = s; break; }
    turn_join(current_turn, daemon_file);
    if (moving) turn_join(current_turn, s.destination);
    awatch_lock_notify(event_agent(req, agent), daemon_file, ls, le, "granted", NULL);
    DtobValue *resp = make_ok_lock(lock_find(&lt, s.id));
    dtob_kvset_put(resp, "stage", dtob_raw((const uint8_t *)s.path, strlen(s.path)));
    dtob_kvset_put(resp, "operation", dtob_uint(s.deleting ? 1 : moving ? 2 : 0));
    return resp;
}

static DtobValue *handle_stage_finish(DtobValue *req, int aborting) {
    char author[128], history_error[512] = "Invalid alock.toml";
    dtob_kvset_str(req, "author", author, sizeof(author));
    if (!aborting && !history_author_valid(author)) return make_error("--author is required (1-32 bytes, no control characters)");
    if (!aborting && history_enabled(history_error, sizeof(history_error)) < 0) return make_error(history_error);
    char agent[128] = {0}, path[4096] = {0};
    dtob_kvset_str(req, "agent", agent, sizeof(agent));
    dtob_kvset_str(req, "stage", path, sizeof(path));
    Stage *s = NULL;
    for (int i = 0; i < MAX_LOCKS; i++)
        if (stages[i].id && !strcmp(stages[i].path, path)) s = &stages[i];
    Lock *l = s ? lock_find(&lt, s->id) : NULL;
    if (!l || strcmp(l->agent, agent) || strcmp(l->file, daemon_file) || strcmp(s->turn, current_turn))
        return make_error("stage has no live lock belonging to this agent and file");
    DtobValue *resp = NULL;
    uint8_t *edited = NULL, *current = NULL;
    size_t edited_size = 0, current_size = 0;
    mode_t mode;
    if (aborting) { resp = make_ok_lock(l); goto done; }
    if (s->deleting) {
        struct stat st;
        if (lstat(s->path, &st) == 0 || errno != ENOENT) {
            resp = make_error("delete proposal must remove the staging file"); goto done;
        }
        edited = calloc(1, 1);
    } else edited = read_regular(s->path, &edited_size, &mode);
    size_t suffix = s->size - s->start - s->length;
    if (!edited || edited_size < s->start + suffix ||
        memcmp(edited, s->base, s->start) ||
        memcmp(edited + edited_size - suffix, s->base + s->size - suffix, suffix)) {
        resp = make_error("rejected: staged changes extend outside the acquired range"); goto done;
    }
    if (s->leaf_link) {
        struct stat st;
        if (!lstat(daemon_file, &st) && S_ISLNK(st.st_mode) &&
            st.st_dev == s->identity.st_dev && st.st_ino == s->identity.st_ino)
            current = read_symlink(daemon_file, &current_size);
    }
    else if (s->deleting) {
        struct stat st;
        if (!lstat(daemon_file, &st) && S_ISREG(st.st_mode) &&
            st.st_dev == s->identity.st_dev && st.st_ino == s->identity.st_ino)
            current = read_regular(daemon_file, &current_size, &mode);
    }
    else if (s->existed) current = read_regular(daemon_file, &current_size, &mode);
    else {
        struct stat st;
        if (lstat(daemon_file, &st) < 0 && errno == ENOENT) current = calloc(1, 1);
    }
    size_t start = (size_t)l->byte_start;
    if (!current || start > current_size || s->length > current_size - start ||
        l->length != s->length || memcmp(current + start, s->base + s->start, s->length)) {
        resp = make_error("rejected: locked content changed since staging"); goto done;
    }
    if (s->make_link) {
        if (!edited_size || edited_size >= 4096 || memchr(edited, 0, edited_size) || memchr(edited, '\n', edited_size)) {
            resp = make_error("symlink proposal must contain only a nonempty link target, without newline or NUL"); goto done;
        }
        char target[4096], temp[4096];
        memcpy(target, edited, edited_size); target[edited_size] = 0;
        if (snprintf(temp, sizeof(temp), "%s.alock-XXXXXX", daemon_file) >= (int)sizeof(temp)) {
            resp = make_error("symlink path too long"); goto done;
        }
        int fd = mkstemp(temp);
        if (fd < 0) { resp = make_error("cannot create symlink proposal"); goto done; }
        close(fd);
        int failed = unlink(temp) || symlink(target, temp) || rename(temp, daemon_file);
        if (failed) { unlink(temp); resp = make_error("cannot replace symlink"); goto done; }
        awatch_notify(event_agent(req, agent), author, daemon_file, 1, l->line_end, (char *)current, current_size, (char *)edited, edited_size);
        resp = make_ok_edit_response(l, 1, 0);
        if (record_history(daemon_file, author, "symlink", current, current_size, edited, edited_size, history_error, sizeof(history_error)))
            dtob_kvset_put(resp, "historyError", dtob_raw((uint8_t *)history_error, strlen(history_error)));
        lock_release_agent(&lt, agent, daemon_file);
        goto done;
    }
    if (s->deleting || s->destination[0]) {
        if (start || current_size != s->size || l->length != current_size) {
            resp = make_error("rejected: whole-file baseline changed"); goto done;
        }
        if (s->deleting) {
            if (unlink(daemon_file)) { resp = make_error("cannot delete source"); goto done; }
            awatch_notify(event_agent(req, agent), author, daemon_file, 1, l->line_end, (char *)current, current_size, "", 0);
            resp = make_ok_lock(l);
        } else {
            /* Publish without overwriting even an uncooperative concurrent creator.
             * The sibling keeps publication on the destination filesystem. */
            char temp[4096];
            if (snprintf(temp, sizeof(temp), "%s.alock-XXXXXX", s->destination) >= (int)sizeof(temp)) {
                resp = make_error("destination path too long"); goto done;
            }
            int fd = mkstemp(temp);
            if (fd < 0) { resp = make_error("cannot create rename replacement"); goto done; }
            int failed = fchmod(fd, s->mode) || write_all(fd, edited, edited_size) || fsync(fd);
            if (close(fd)) failed = 1;
            if (!failed) failed = link(temp, s->destination);
            if (!failed && unlink(daemon_file)) { unlink(s->destination); failed = 1; }
            unlink(temp);
            if (failed) { resp = make_error("cannot rename source (destination must not exist)"); goto done; }
            awatch_notify(event_agent(req, agent), author, daemon_file, 1, l->line_end, (char *)current, current_size, "", 0);
            awatch_notify(event_agent(req, agent), author, s->destination, 1, l->line_end, "", 0, (char *)edited, edited_size);
            resp = make_ok_edit_response(l, 1, 0);
            dtob_kvset_put(resp, "destination", dtob_raw((uint8_t *)s->destination, strlen(s->destination)));
        }
        /* Invalidate same-agent locks acquired after staging as well. */
        int history_failed = record_history(daemon_file, author, s->deleting ? "delete" : "rename-source",
            current, current_size, "", 0, history_error, sizeof(history_error));
        if (s->destination[0] && record_history(s->destination, author, "rename-destination", "", 0,
            edited, edited_size, history_error, sizeof(history_error))) history_failed = 1;
        if (history_failed) dtob_kvset_put(resp, "historyError", dtob_raw((uint8_t *)history_error, strlen(history_error)));
        lock_release_agent(&lt, agent, daemon_file);
        if (s->destination[0]) lock_release_agent(&lt, agent, s->destination);
        goto done;
    }
    size_t replacement = edited_size - s->start - suffix;
    resp = apply_edit(l, current, current_size, start, s->length,
                      edited + s->start, replacement, s->mode, l->line_start, l->line_end, !s->existed, author, event_agent(req, agent));
done:
    free(edited); free(current);
    clear_stage(s);
    return resp;
}

static DtobValue *handle_mkdir(DtobValue *req) {
    char author[128], error[512];
    dtob_kvset_str(req, "author", author, sizeof(author));
    if (!history_author_valid(author)) return make_error("--author is required");
    if (turn_prepare(current_turn, daemon_file)) return make_error("cannot flush history before directory creation");
    if (mkdir(daemon_file, 0755)) return make_error("cannot create directory (destination must be absent)");
    turn_join(current_turn, daemon_file);
    DtobValue *resp = dtob_kvset();
    dtob_kvset_put(resp, "ok", dtob_uint(1));
    if (record_history(daemon_file, author, "mkdir", "", 0, "directory\n", 10, error, sizeof(error)))
        dtob_kvset_put(resp, "historyError", dtob_raw((uint8_t *)error, strlen(error)));
    return resp;
}

static void handle_client(int client_fd) {
    struct timeval timeout = {1, 0};
    setsockopt(client_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(client_fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    size_t req_len;
    uint8_t *req_data = ipc_recv(client_fd, &req_len);
    if (!req_data) return;

    DtobValue *req = dtob_decode(req_data, req_len);
    free(req_data);
    if (!req) return;

    char cmd[64] = {0};
    dtob_kvset_str(req, "cmd", cmd, sizeof(cmd));
    daemon_file[0] = '\0';
    dtob_kvset_str(req, "file", daemon_file, sizeof(daemon_file));
    current_turn[0] = 0;
    dtob_kvset_str(req, "turn", current_turn, sizeof(current_turn));

    turn_expire(release_turn_locks);
    lock_expire(&lt);
    reap_stages();
    DtobValue *resp = NULL;
    if (strcmp(cmd, "capabilities") == 0) {
        resp = dtob_kvset();
        dtob_kvset_put(resp, "ok", dtob_uint(1));
        dtob_kvset_put(resp, "author_required", dtob_uint(1));
        dtob_kvset_put(resp, "file_operations", dtob_uint(1));
        dtob_kvset_put(resp, "turns", dtob_uint(1));
        dtob_kvset_put(resp, "pid", dtob_uint((uint64_t)getpid()));
        dtob_kvset_put(resp, "nab", dtob_uint(1));
    }
    else if (strcmp(cmd, "turn-heartbeat") == 0 || strcmp(cmd, "turn-end") == 0) {
        int failed;
        if (!strcmp(cmd, "turn-end")) { release_turn_locks(current_turn); failed = turn_end(current_turn); }
        else failed = turn_heartbeat(current_turn);
        resp = failed ? make_error("turn lifecycle failed; pending history retained") : dtob_kvset();
        if (!failed) dtob_kvset_put(resp, "ok", dtob_uint(1));
    }
    else if (strcmp(cmd, "acquire") == 0)       resp = handle_acquire(req);
    else if (strcmp(cmd, "write") == 0)         resp = handle_write(req);
    else if (strcmp(cmd, "check") == 0)         resp = handle_check(req);
    else if (strcmp(cmd, "release") == 0)       resp = handle_release(req);
    else if (strcmp(cmd, "release-agent") == 0) resp = handle_release_agent(req);
    else if (strcmp(cmd, "status") == 0)        resp = handle_status(req);
    else if (strcmp(cmd, "stage") == 0)         resp = handle_stage(req);
    else if (strcmp(cmd, "mkdir") == 0)         resp = handle_mkdir(req);
    else if (strcmp(cmd, "commit") == 0)        resp = handle_stage_finish(req, 0);
    else if (strcmp(cmd, "abort") == 0)         resp = handle_stage_finish(req, 1);
    else                                       resp = make_error("unknown command");

    dtob_free(req);
    reap_stages();

    if (resp) {
        size_t resp_len;
        uint8_t *resp_data = dtob_encode(resp, &resp_len);
        dtob_free(resp);
        if (resp_data) {
            ipc_send(client_fd, resp_data, resp_len);
            free(resp_data);
        }
    }
}

static void daemon_run(int listen_fd) {
    history_recover();
    struct pollfd pfd;
    pfd.fd = listen_fd;
    pfd.events = POLLIN;

    time_t last_activity = time(NULL);
    while (1) {
        int ret = poll(&pfd, 1, 1000);
        turn_expire(release_turn_locks);

        if (ret == 0) {
            lock_expire(&lt);
            reap_stages();
            if (lt.count == 0 && !turns_active() && time(NULL) - last_activity >= EXPIRE_INTERVAL_MS / 1000) break;
            continue;
        }

        if (pfd.revents & POLLIN) {
            int client = accept(listen_fd, NULL, NULL);
            if (client >= 0) {
                last_activity = time(NULL);
                handle_client(client);
                close(client);

                lock_expire(&lt);
            }
        }
    }

    close(listen_fd);
    ipc_cleanup(daemon_sock);
}

static int daemon_capable(const char *sock_path, int needs_turns) {
    int fd = ipc_connect(sock_path);
    if (fd < 0) return -1;
    struct timeval timeout = {3, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    DtobValue *request = dtob_kvset();
    dtob_kvset_put(request, "cmd", dtob_raw((const uint8_t *)"capabilities", 12));
    size_t len;
    uint8_t *bytes = dtob_encode(request, &len);
    dtob_free(request);
    int sent = bytes ? ipc_send(fd, bytes, len) : -1;
    free(bytes);
    bytes = sent ? NULL : ipc_recv(fd, &len);
    close(fd);
    DtobValue *reply = bytes ? dtob_decode(bytes, len) : NULL;
    free(bytes);
    int capable = !reply ? -1 : dtob_kvset_uint(reply, "author_required") == 1 && dtob_kvset_uint(reply, "nab") == 1 && dtob_kvset_uint(reply, "file_operations") == 1 &&
        (!needs_turns || dtob_kvset_uint(reply, "turns") == 1);
    if (reply) dtob_free(reply);
    return capable;
}

int daemon_author_capable(const char *sock_path) { return daemon_capable(sock_path, 0); }
int daemon_turn_capable(const char *sock_path) { return daemon_capable(sock_path, 1); }

int daemon_spawn(const char *file, char *sock_path, size_t pathsz) {
    ipc_socket_path(file, sock_path, pathsz);
    mkdir(ALOCK_SOCK_DIR, 0700);
    int guard = open(ALOCK_SOCK_DIR "/startup.lock", O_CREAT | O_RDWR, 0600);
    if (guard < 0) return -1;
    if (flock(guard, LOCK_EX)) { close(guard); return -1; }

    /* already running? */
    int test = ipc_connect(sock_path);
    if (test >= 0) {
        close(test);
        close(guard);
        return 0;
    }

    int ready_pipe[2];
    if (pipe(ready_pipe) < 0) { close(guard); return -1; }

    pid_t pid = fork();
    if (pid < 0) { close(guard); close(ready_pipe[0]); close(ready_pipe[1]); return -1; }

    if (pid == 0) {
        /* child: become daemon */
        close(guard);
        close(ready_pipe[0]);
        /* The bridge may start us while serving a client. Do not retain its
         * listener/client sockets (or any other caller-owned descriptors). */
        int maxfd = getdtablesize();
        for (int fd = 3; fd < maxfd; fd++)
            if (fd != ready_pipe[1]) close(fd);
        signal(SIGINT, SIG_DFL);
        signal(SIGTERM, SIG_DFL);
        setsid();

        strncpy(daemon_file, file, sizeof(daemon_file) - 1);
        daemon_file[sizeof(daemon_file) - 1] = '\0';
        strncpy(daemon_sock, sock_path, sizeof(daemon_sock) - 1);
        daemon_sock[sizeof(daemon_sock) - 1] = '\0';

        locktable_init(&lt);

        int listen_fd = ipc_listen(sock_path);
        if (listen_fd < 0) {
            write(ready_pipe[1], "E", 1);
            close(ready_pipe[1]);
            _exit(1);
        }

        write(ready_pipe[1], "R", 1);
        close(ready_pipe[1]);

        close(STDIN_FILENO);
        close(STDOUT_FILENO);
        close(STDERR_FILENO);
        signal(SIGPIPE, SIG_IGN);

        daemon_run(listen_fd);
        _exit(0);
    }

    /* parent: wait for ready */
    close(ready_pipe[1]);
    char buf;
    ssize_t n = read(ready_pipe[0], &buf, 1);
    close(ready_pipe[0]);
    close(guard);

    if (n != 1 || buf != 'R') return -1;
    return 0;
}
