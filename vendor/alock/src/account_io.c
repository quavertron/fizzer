#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700
#include "account_io.h"
#include "daemon.h"
#include "ipc.h"
#include <dtob.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
#include <pwd.h>
#include <string.h>
#include <signal.h>
#include <poll.h>

static volatile sig_atomic_t account_stopping;
static void account_signal(int signo) { (void)signo; account_stopping = 1; }
void account_signals(void) { signal(SIGINT, account_signal); signal(SIGTERM, account_signal); signal(SIGPIPE, SIG_IGN); }
int account_stopped(void) { return account_stopping != 0; }
int account_control(void) {
    static char line[64];
    static size_t length;
    struct pollfd fd = {STDIN_FILENO, POLLIN, 0};
    while (poll(&fd, 1, 0) > 0 && (fd.revents & (POLLIN | POLLHUP))) {
        char byte;
        if (read(STDIN_FILENO, &byte, 1) != 1) return 2;
        if (byte == '\n') {
            line[length] = 0; length = 0;
            if (!strcmp(line, "conclude")) return 1;
        } else if (length < sizeof(line)-1) line[length++] = byte;
    }
    return 0;
}

extern int account_safe(const char *path);

unsigned char *account_read(const char *path, size_t *size, unsigned *mode, int *exists) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    *size = 0; *mode = 0644; *exists = 0;
    if (fd < 0) return errno == ENOENT ? calloc(1, 1) : NULL;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || st.st_size > 4 * 1024 * 1024) { close(fd); return NULL; }
    *size = (size_t)st.st_size; *mode = st.st_mode & 0777; *exists = 1;
    unsigned char *bytes = malloc(*size + 1);
    size_t pos = 0;
    while (bytes && pos < *size) {
        ssize_t n = read(fd, bytes + pos, *size - pos);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { free(bytes); bytes = NULL; break; }
        pos += (size_t)n;
    }
    close(fd);
    return bytes;
}
static int write_bytes(int fd, const unsigned char *bytes, size_t size) {
    while (size) {
        ssize_t n = write(fd, bytes, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        bytes += n; size -= (size_t)n;
    }
    return 0;
}
int account_publish(const char *path, const void *bytes, size_t size, unsigned mode, int exists) {
    char tmp[4096];
    if (snprintf(tmp, sizeof(tmp), "%s.alock-XXXXXX", path) >= (int)sizeof(tmp)) return -1;
    int fd = mkstemp(tmp);
    if (fd < 0) return -1;
    int failed = fchmod(fd, (mode_t)mode) || write_bytes(fd, bytes, size) || fsync(fd);
    if (close(fd)) failed = 1;
    if (!failed) failed = exists ? rename(tmp, path) : link(tmp, path);
    unlink(tmp);
    return failed ? -1 : 0;
}

int account_user(const char *name) {
    struct passwd *user = getpwnam(name);
    return !user || !user->pw_uid || user->pw_uid == getuid() || !getuid() ? -1 : (int)user->pw_uid;
}
int account_root(const char *path, char out[4096]) {
    if (!realpath(path, out)) return -1;
    char probe[4096];
    if (snprintf(probe, sizeof(probe), "%s/.alock-path-check", out) >= (int)sizeof(probe)) return -1;
    return account_safe(probe) ? 0 : -1;
}
int account_temp(const void *bytes, size_t size, char out[4096]) {
    strcpy(out, "/tmp/alock-proposal-XXXXXX");
    int fd = mkstemp(out);
    if (fd < 0) return -1;
    int failed = write_bytes(fd, bytes, size);
    if (close(fd)) failed = 1;
    if (failed) unlink(out);
    return failed ? -1 : 0;
}
unsigned char *account_load(const char *path, size_t *size) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    struct stat st;
    if (fd < 0) return NULL;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || st.st_size > 16 * 1024 * 1024) { close(fd); return NULL; }
    *size = (size_t)st.st_size;
    unsigned char *data = malloc(*size + 1);
    size_t pos = 0;
    while (data && pos < *size) {
        ssize_t n = read(fd, data + pos, *size - pos);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { free(data); data = NULL; break; }
        pos += (size_t)n;
    }
    close(fd); return data;
}
DtobValue *account_daemon(DtobValue *request) {
    char socket[4096];
    if (daemon_spawn("", socket, sizeof(socket))) return NULL;
    int fd = ipc_connect(socket);
    if (fd < 0) return NULL;
    size_t size;
    uint8_t *data = dtob_encode(request, &size);
    int failed = !data || ipc_send(fd, data, size);
    free(data);
    data = failed ? NULL : ipc_recv(fd, &size);
    close(fd);
    DtobValue *result = data ? dtob_decode(data, size) : NULL;
    free(data); return result;
}

int account_envelope_valid(const DtobValue *value) {
    if (!value || value->code != DTOB_OPEN_KV || value->num_elements > 24) return 0;
    for (size_t i = 0; i < value->num_elements; i++) {
        if (value->elements[i].kind != DTOB_KV) return 0;
        const DtobKVPair *pair = &value->elements[i].data.kv;
        if (memchr(pair->key, 0, pair->key_len)) return 0;
        for (size_t j = 0; j < i; j++) {
            const DtobKVPair *other = &value->elements[j].data.kv;
            if (pair->key_len == other->key_len && !memcmp(pair->key, other->key, pair->key_len)) return 0;
        }
    }
    return 1;
}
void account_put(DtobValue *value, const char *key, DtobValue *replacement) {
    for (size_t i = 0; i < value->num_elements; i++) {
        DtobKVPair *pair = &value->elements[i].data.kv;
        if (value->elements[i].kind == DTOB_KV && pair->key_len == strlen(key) && !memcmp(pair->key, key, pair->key_len)) {
            dtob_free(pair->value); pair->value = replacement; return;
        }
    }
    dtob_kvset_put(value, key, replacement);
}
int account_lock(LockTable *lt, const char *agent, const char *path, AccountRange *range) {
    int id = lock_acquire(lt, agent, path, (off_t)range->start, (size_t)range->length, range->line_start, range->line_end);
    Lock *lock = lock_find(lt, id);
    if (lock) lock->ttl_seconds = 0; /* Rust owns turn and monotonic lease policy. */
    return id;
}
int account_lock_get(LockTable *lt, int id, AccountRange *range) {
    Lock *lock = lock_find(lt, id);
    if (!lock) return 0;
    *range = (AccountRange){(uint64_t)lock->byte_start, lock->length, lock->line_start, lock->line_end};
    return 1;
}
void account_unlock(LockTable *lt, int id) {
    Lock *lock = lock_find(lt, id);
    if (lock) { lock->active = 0; lt->count--; }
}
void account_adjust(LockTable *lt, int id, const char *path, size_t size, int64_t lines) {
    Lock *lock = lock_find(lt, id);
    if (!lock) return;
    uint32_t end = lock->line_end;
    lock_adjust(lt, path, lock->byte_start, (ssize_t)size - (ssize_t)lock->length);
    lock_adjust_lines(lt, path, end, (ssize_t)lines);
    lock->length = size;
    if (lock->line_end < lock->line_start) lock->line_end = lock->line_start;
}
int account_random(unsigned char *bytes, size_t size) {
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return -1;
    size_t pos = 0;
    while (pos < size) {
        ssize_t n = read(fd, bytes + pos, size - pos);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        pos += (size_t)n;
    }
    close(fd);
    return pos == size ? 0 : -1;
}
