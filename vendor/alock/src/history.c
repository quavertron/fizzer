#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "history.h"
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static char *trim(char *s) {
    while (isspace((unsigned char)*s)) s++;
    size_t n = strlen(s);
    while (n && isspace((unsigned char)s[n - 1])) s[--n] = 0;
    return s;
}

int history_author_valid(const char *author) {
    if (!author || !*author || strlen(author) > 32) return 0;
    int nonspace = 0;
    for (const unsigned char *p = (const unsigned char *)author; *p; p++) {
        if (*p < 32 || *p == 127) return 0;
        if (!isspace(*p)) nonspace = 1;
    }
    return nonspace;
}

int history_enabled(char *error, size_t size) {
    char file[PATH_MAX], base[PATH_MAX];
    const char *xdg = getenv("XDG_CONFIG_HOME"), *home = getenv("HOME");
    if (xdg && *xdg) snprintf(base, sizeof(base), "%s", xdg);
    else if (home) snprintf(base, sizeof(base), "%s/.config", home);
    else { snprintf(error, size, "Cannot locate alock.toml: HOME is unset"); return -1; }
    if (snprintf(file, sizeof(file), "%s/alock.toml", base) >= (int)sizeof(file)) return -1;
    FILE *f = fopen(file, "r");
    if (!f) {
        if (errno == ENOENT) return 0;
        snprintf(error, size, "Cannot read %s", file); return -1;
    }
    char line[4096];
    int enabled = 0, seen = 0, section = 0, valid = 1;
    while (fgets(line, sizeof(line), f)) {
        if (!strchr(line, '\n') && !feof(f)) { valid = 0; break; }
        char *s = trim(line), *comment = strchr(s, '#');
        if (comment) *comment = 0;
        s = trim(s);
        if (!*s) continue;
        if (*s == '[') { section = 1; continue; }
        if (section) continue;
        char *equals = strchr(s, '=');
        if (!equals) { valid = 0; break; }
        *equals = 0;
        if (strcmp(trim(s), "nab")) continue;
        char *value = trim(equals + 1);
        if (seen++ || (strcmp(value, "true") && strcmp(value, "false"))) { valid = 0; break; }
        enabled = !strcmp(value, "true");
    }
    if (ferror(f)) valid = 0;
    fclose(f);
    if (!valid) { snprintf(error, size, "Invalid %s: nab must be a single TOML boolean", file); return -1; }
    return enabled;
}

static int put(const char *file, const void *bytes, size_t size) {
    int fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) return -1;
    const char *p = bytes;
    int failed = 0;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { failed = 1; break; }
        p += n; size -= (size_t)n;
    }
    if (fsync(fd)) failed = 1;
    if (close(fd)) failed = 1;
    return failed ? -1 : 0;
}

static int sync_directory(const char *path) {
    int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) return -1;
    int result = fsync(fd);
    close(fd);
    return result;
}

static int directory(const char *name) {
    if (mkdir(name, 0700) && errno != EEXIST) return -1;
    struct stat st;
    return lstat(name, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077) ? -1 : 0;
}

static int location(const char *file, char out[PATH_MAX]) {
    char base[PATH_MAX], state[PATH_MAX], key[65];
    const char *xdg = getenv("XDG_STATE_HOME"), *home = getenv("HOME");
    if (xdg && *xdg) snprintf(base, sizeof(base), "%s", xdg);
    else if (home) snprintf(base, sizeof(base), "%s/.local/state", home);
    else return -1;
    /* Create only missing base components; existing permissions are untouched. */
    for (char *p = base + 1; *p; p++) if (*p == '/') {
        *p = 0; int result = mkdir(base, 0700); *p = '/';
        if (result && errno != EEXIST) return -1;
    }
    if (mkdir(base, 0700) && errno != EEXIST) return -1;
    if (snprintf(state, sizeof(state), "%s/alock", base) >= (int)sizeof(state) || directory(state)) return -1;
    alock_nab_key(file, key);
    if (snprintf(out, PATH_MAX, "%s/%s", state, key) >= PATH_MAX || directory(out)) return -1;
    return 0;
}

static int copy(const char *source, const char *destination) {
    int fd = open(source, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return errno == ENOENT ? 0 : -1;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid()) { close(fd); return -1; }
    FILE *out = fopen(destination, "wx");
    if (!out) { close(fd); return -1; }
    fchmod(fileno(out), 0600);
    char buf[65536];
    ssize_t n;
    int failed = 0;
    while ((n = read(fd, buf, sizeof(buf))) != 0) {
        if (n < 0) { if (errno == EINTR) continue; failed = 1; break; }
        if (fwrite(buf, 1, (size_t)n, out) != (size_t)n) { failed = 1; break; }
    }
    close(fd);
    if (fflush(out) || fsync(fileno(out))) failed = 1;
    if (fclose(out)) failed = 1;
    return failed ? -1 : 0;
}

static int patch(const char *source, const char *archive, const char *author) {
    char *argv[] = {"nab", "patch", (char *)source, (char *)archive, "--author", (char *)author, NULL};
    return alock_nab_main(6, argv);
}

/* Caller holds the per-history lock. Retry durable snapshots oldest-first. */
static int archive_path(const char *file, char out[PATH_MAX]) {
    const char *name = strrchr(file, '/');
    if (!name || !name[1]) return -1;
    return snprintf(out, PATH_MAX, "%.*s/.%s.nab", (int)(name - file), file, name + 1) >= PATH_MAX ? -1 : 0;
}

/* Copy beside the destination before renaming: state may be on another volume. */
static int publish(const char *source, const char *archive) {
    char temp[PATH_MAX];
    if (snprintf(temp, sizeof(temp), "%s.XXXXXX", archive) >= (int)sizeof(temp)) return -1;
    int fd = mkstemp(temp);
    if (fd < 0) return -1;
    close(fd);
    unlink(temp);
    int failed = copy(source, temp) || rename(temp, archive);
    if (failed) unlink(temp);
    else {
        char *slash = strrchr(temp, '/');
        if (slash) { *slash = 0; failed = sync_directory(temp[0] ? temp : "/"); }
    }
    return failed ? -1 : 0;
}

static int pending_entry(const struct dirent *entry) {
    return !strncmp(entry->d_name, "pending-", 8);
}

static int event_metadata(const char *dir, const char *name, char author[64], char batch[128]) {
    char path[PATH_MAX], operation[128];
    if (snprintf(path, sizeof(path), "%s/%s/meta", dir, name) >= (int)sizeof(path)) return -1;
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    batch[0] = 0;
    int valid = fgets(author, 64, f) && fgets(operation, sizeof(operation), f);
    if (valid && fgets(batch, 128, f)) trim(batch);
    fclose(f);
    return valid && history_author_valid(trim(author)) ? 0 : -1;
}

static int replay(const char *dir, const char *file) {
    struct dirent **entries = NULL;
    int count = scandir(dir, &entries, pending_entry, alphasort), failed = count < 0;
    for (int i = 0; i < count; i++) {
        if (!failed) {
            char author[64], batch[128];
            int last = i;
            if (event_metadata(dir, entries[i]->d_name, author, batch)) { failed = 1; continue; }
            while (batch[0] && last + 1 < count) {
                char next_author[64], next_batch[128];
                if (event_metadata(dir, entries[last + 1]->d_name, next_author, next_batch) ||
                    strcmp(author, next_author) || strcmp(batch, next_batch)) break;
                last++;
            }
            char event[PATH_MAX], before[PATH_MAX], after[PATH_MAX], meta[PATH_MAX], temp[PATH_MAX], archive[PATH_MAX];
            if (snprintf(event, sizeof(event), "%s/%s", dir, entries[i]->d_name) >= (int)sizeof(event) ||
                snprintf(before, sizeof(before), "%s/before", event) >= (int)sizeof(before) ||
                snprintf(after, sizeof(after), "%s/%s/after", dir, entries[last]->d_name) >= (int)sizeof(after) ||
                snprintf(meta, sizeof(meta), "%s/meta", event) >= (int)sizeof(meta) ||
                snprintf(temp, sizeof(temp), "%s/archive", event) >= (int)sizeof(temp) ||
                archive_path(file, archive)) { failed = 1; }
            else {
                unlink(temp);
                char legacy[PATH_MAX];
                struct stat st;
                const char *source = archive;
                if (lstat(archive, &st) && errno == ENOENT) {
                    if (snprintf(legacy, sizeof(legacy), "%s/history.nab", dir) >= (int)sizeof(legacy)) failed = 1;
                    source = legacy;
                }
                if (!failed && (copy(source, temp) ||
                    (access(temp, F_OK) && patch(before, temp, "alock:baseline")) ||
                    patch(after, temp, trim(author)) || publish(temp, archive))) failed = 1;
                if (!failed) unlink(temp);
                for (int k = i; !failed && k <= last; k++) {
                    char audit[PATH_MAX], item[PATH_MAX], retired[PATH_MAX];
                    if (snprintf(event, sizeof(event), "%s/%s", dir, entries[k]->d_name) >= (int)sizeof(event) ||
                        snprintf(retired, sizeof(retired), "%s/recorded-%s", dir, entries[k]->d_name + 8) >= (int)sizeof(retired) ||
                        rename(event, retired)) { failed = 1; break; }
                    strcpy(event, retired);
                    if (
                        snprintf(meta, sizeof(meta), "%s/meta", event) >= (int)sizeof(meta) ||
                        snprintf(audit, sizeof(audit), "%s/event-%s", dir, entries[k]->d_name + 8) >= (int)sizeof(audit) || rename(meta, audit)) { failed = 1; break; }
                    if (snprintf(item, sizeof(item), "%s/before", event) < (int)sizeof(item)) unlink(item);
                    if (snprintf(item, sizeof(item), "%s/after", event) < (int)sizeof(item)) unlink(item);
                    rmdir(event);
                }
                i = last;
                if (!failed && sync_directory(dir)) failed = 1;
            }
        }
    }
    for (int i = 0; i < count; i++) free(entries[i]);
    free(entries);
    return failed ? -1 : 0;
}

/* Reserve a durable sequence while holding the history lock. Bootstrap above
 * legacy timestamp names so old pending snapshots always replay first. */
static int next_sequence(const char *dir, unsigned long long *next) {
    char path[PATH_MAX], temp[PATH_MAX];
    if (snprintf(path, sizeof(path), "%s/sequence", dir) >= (int)sizeof(path) ||
        snprintf(temp, sizeof(temp), "%s/.sequence-XXXXXX", dir) >= (int)sizeof(temp)) return -1;
    unsigned long long last = 0;
    FILE *in = fopen(path, "r");
    if (in) {
        int valid = fscanf(in, "%llu", &last) == 1;
        fclose(in);
        if (!valid) return -1;
    } else {
        if (errno != ENOENT) return -1;
        DIR *listing = opendir(dir);
        if (!listing) return -1;
        struct dirent *entry;
        while ((entry = readdir(listing))) {
            const char *dash = strchr(entry->d_name, '-');
            unsigned long long value;
            if (dash && sscanf(dash + 1, "%llu", &value) == 1 && value > last) last = value;
        }
        closedir(listing);
    }
    if (last == ULLONG_MAX) return -1;
    *next = last + 1;
    int fd = mkstemp(temp);
    if (fd < 0) return -1;
    FILE *out = fdopen(fd, "w");
    if (!out) { close(fd); unlink(temp); return -1; }
    int failed = fprintf(out, "%llu\n", *next) < 0 || fflush(out) || fsync(fd);
    if (fclose(out)) failed = 1;
    if (!failed) failed = rename(temp, path) || sync_directory(dir);
    if (failed) unlink(temp);
    return failed ? -1 : 0;
}

static int history_record_impl(const char *turn, int defer, const char *file, const char *author, const char *operation,
                   const void *before, size_t before_size, const void *after, size_t after_size,
                   char *error, size_t error_size, int required) {
    int enabled = required ? 1 : history_enabled(error, error_size);
    if (enabled <= 0) return enabled;
    if (!history_author_valid(author)) { snprintf(error, error_size, "--author is required (1-32 bytes, no control characters)"); return -1; }
    char dir[PATH_MAX], lock[PATH_MAX], event[PATH_MAX], ready[PATH_MAX], item[PATH_MAX], meta[256];
    int fd = -1, failed = 1;
    if (location(file, dir) || snprintf(lock, sizeof(lock), "%s/lock", dir) >= (int)sizeof(lock)) goto done;
    fd = open(lock, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (fd < 0 || flock(fd, LOCK_EX)) goto done;
    unsigned long long sequence;
    if (next_sequence(dir, &sequence) ||
        snprintf(event, sizeof(event), "%s/building-%020llu-000000000-XXXXXX", dir, sequence) >= (int)sizeof(event) || !mkdtemp(event)) goto done;
    if (snprintf(item, sizeof(item), "%s/before", event) >= (int)sizeof(item) || put(item, before, before_size)) goto done;
    if (snprintf(item, sizeof(item), "%s/after", event) >= (int)sizeof(item) || put(item, after, after_size)) goto done;
    snprintf(meta, sizeof(meta), "%s\n%s\n%s\n", author, operation, defer ? turn : "");
    if (snprintf(item, sizeof(item), "%s/meta", event) >= (int)sizeof(item) || put(item, meta, strlen(meta))) goto done;
    if (snprintf(item, sizeof(item), "%s/path", dir) >= (int)sizeof(item)) goto done;
    if (access(item, F_OK) && put(item, file, strlen(file))) goto done;
    /* Incomplete snapshots must not block later replay after a storage failure. */
    if (sync_directory(event) || snprintf(ready, sizeof(ready), "%s/pending-%s", dir, strrchr(event, '/') + 1 + strlen("building-")) >= (int)sizeof(ready) || rename(event, ready) || sync_directory(dir)) goto done;
    failed = defer ? 0 : replay(dir, file);
done:
    if (fd >= 0) close(fd);
    if (failed) snprintf(error, error_size, "File changed but nab history failed; saved snapshots (if written) remain in the alock state directory for retry");
    return failed ? -1 : 0;
}

int history_record_turn(const char *turn, int defer, const char *file, const char *author, const char *operation,
                   const void *before, size_t before_size, const void *after, size_t after_size,
                   char *error, size_t error_size) {
    return history_record_impl(turn, defer, file, author, operation, before, before_size, after, after_size, error, error_size, 0);
}

int history_record_account(const char *file, const char *author, const char *operation,
                   const void *before, size_t before_size, const void *after, size_t after_size,
                   char *error, size_t error_size) {
    return history_record_impl("", 0, file, author, operation, before, before_size, after, after_size, error, error_size, 1);
}

int history_record(const char *file, const char *author, const char *operation,
                   const void *before, size_t before_size, const void *after, size_t after_size,
                   char *error, size_t error_size) {
    return history_record_turn("", 0, file, author, operation, before, before_size, after, after_size, error, error_size);
}

int history_flush(const char *file) {
    char error[512], dir[PATH_MAX], lock[PATH_MAX];
    int enabled = history_enabled(error, sizeof(error));
    if (enabled <= 0) return enabled;
    if (location(file, dir) || snprintf(lock, sizeof(lock), "%s/lock", dir) >= (int)sizeof(lock)) return -1;
    int fd = open(lock, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (fd < 0) return -1;
    int failed = flock(fd, LOCK_EX) || replay(dir, file);
    close(fd);
    return failed ? -1 : 0;
}

void history_recover(void) {
    char state[PATH_MAX], path[PATH_MAX], file[PATH_MAX];
    const char *xdg = getenv("XDG_STATE_HOME"), *home = getenv("HOME");
    int n = xdg && *xdg ? snprintf(state, sizeof(state), "%s/alock", xdg) :
        home ? snprintf(state, sizeof(state), "%s/.local/state/alock", home) : -1;
    if (n < 0 || n >= (int)sizeof(state)) return;
    DIR *dir = opendir(state);
    if (!dir) return;
    struct dirent *entry;
    while ((entry = readdir(dir))) {
        if (strlen(entry->d_name) != 64 || strspn(entry->d_name, "0123456789abcdef") != 64 ||
            snprintf(path, sizeof(path), "%s/%s/path", state, entry->d_name) >= (int)sizeof(path)) continue;
        int fd = open(path, O_RDONLY | O_NOFOLLOW);
        if (fd < 0) continue;
        ssize_t size = read(fd, file, sizeof(file) - 1);
        close(fd);
        if (size <= 0) continue;
        file[size] = 0;
        if (history_flush(file)) fprintf(stderr, "alock: pending history recovery failed for %s\n", file);
    }
    closedir(dir);
}

int history_command(const char *file, int retry) {
    char dir[PATH_MAX], archive[PATH_MAX], lock[PATH_MAX];
    if (location(file, dir) || snprintf(lock, sizeof(lock), "%s/lock", dir) >= (int)sizeof(lock) ||
        archive_path(file, archive)) return 1;
    int fd = open(lock, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (fd < 0 || flock(fd, LOCK_EX)) { if (fd >= 0) close(fd); return 1; }
    int result = retry ? replay(dir, file) : 0;
    if (result) fprintf(stderr, "alock: pending nab snapshots could not be replayed in %s\n", dir);
    else {
        struct stat st;
        if (lstat(archive, &st) && errno == ENOENT &&
            snprintf(archive, sizeof(archive), "%s/history.nab", dir) >= (int)sizeof(archive)) { close(fd); return 1; }
        char *args[] = {"nab", "log", archive, NULL};
        result = alock_nab_main(3, args);
    }
    close(fd);
    return result ? 1 : 0;
}
