#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "syntax.h"
#include "ipc.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long long syntax_now(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/* Human-owned configuration: extension TAB shell command, one per line.
 * Commands receive proposal as $1 and original path as $2. Paths are never
 * interpolated into shell code. There is no automatic checker discovery. */
int syntax_check(const char *target, const void *content, size_t size) {
    const char *name = strrchr(target, '/');
    name = name ? name + 1 : target;
    const char *ext = strrchr(name, '.');
    if (!ext) ext = name;
    char config[4096], command[8192] = {0};
    const char *xdg = getenv("XDG_CONFIG_HOME"), *home = getenv("HOME");
    int n = xdg && *xdg ? snprintf(config, sizeof(config), "%s/alock/syntax.tsv", xdg)
        : home ? snprintf(config, sizeof(config), "%s/.config/alock/syntax.tsv", home) : -1;
    if (n < 0 || n >= (int)sizeof(config)) return -1;
    int config_fd = open(config, O_RDONLY | O_NOFOLLOW);
    if (config_fd < 0) return errno == ENOENT ? 1 : -1;
    struct stat st;
    if (fstat(config_fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 022)) {
        close(config_fd); return -1;
    }
    FILE *in = fdopen(config_fd, "r");
    if (!in) { close(config_fd); return -1; }
    char line[8192];
    int valid = 1;
    while (fgets(line, sizeof(line), in)) {
        if (!strchr(line, '\n') && !feof(in)) { valid = 0; break; }
        line[strcspn(line, "\r\n")] = 0;
        if (!line[0] || line[0] == '#') continue;
        char *tab = strchr(line, '\t');
        if (!tab || !tab[1]) { valid = 0; break; }
        *tab++ = 0;
        if (!strcmp(ext, line)) {
            if (command[0]) { valid = 0; break; }
            strcpy(command, tab);
        }
    }
    if (ferror(in)) valid = 0;
    fclose(in);
    if (!valid) return -1;
    if (!command[0]) return 1;
    char proposal[] = ALOCK_SOCK_DIR "/syntax-XXXXXX";
    int fd = mkstemp(proposal);
    if (fd < 0) return -1;
    const unsigned char *bytes = content;
    size_t pos = 0;
    while (pos < size) {
        ssize_t written = write(fd, bytes + pos, size - pos);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) { close(fd); unlink(proposal); return -1; }
        pos += (size_t)written;
    }
    close(fd);
    pid_t child = fork();
    if (!child) {
        setpgid(0, 0);
        int nullfd = open("/dev/null", O_RDWR);
        if (nullfd >= 0) {
            dup2(nullfd, STDIN_FILENO); dup2(nullfd, STDOUT_FILENO); dup2(nullfd, STDERR_FILENO);
        }
        long maxfd = sysconf(_SC_OPEN_MAX);
        for (int i = 3; i < maxfd; i++) close(i);
        execl("/bin/sh", "sh", "-c", command, "alock-syntax", proposal, target, (char *)NULL);
        _exit(127);
    }
    int status = 0, result = -1;
    if (child > 0) {
        setpgid(child, child);
        long long deadline = syntax_now() + 10000;
        for (;;) {
            pid_t done = waitpid(child, &status, WNOHANG);
            if (done == child) { result = WIFEXITED(status) && WEXITSTATUS(status) == 0; break; }
            if (done < 0 && errno != EINTR) break;
            if (syntax_now() >= deadline) {
                kill(-child, SIGKILL);
                while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
                result = 0; break;
            }
            struct timespec pause = {0, 10000000};
            nanosleep(&pause, NULL);
        }
    }
    unlink(proposal);
    return result;
}
