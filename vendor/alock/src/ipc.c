#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "ipc.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include <sys/time.h>

static long long milliseconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static long long deadline(int fd, int writing) {
    struct timeval tv = {0};
    socklen_t size = sizeof(tv);
    getsockopt(fd, SOL_SOCKET, writing ? SO_SNDTIMEO : SO_RCVTIMEO, &tv, &size);
    long long timeout = (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    return milliseconds() + (timeout ? timeout : 10000);
}

static int transfer(int fd, void *data, size_t size, int writing, long long until) {
    unsigned char *p = data;
    int type;
    socklen_t type_size = sizeof(type);
    int is_socket = getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_size) == 0;
    while (size) {
        long long left = until - milliseconds();
        if (left <= 0) return -1;
        struct pollfd wait = {fd, writing ? POLLOUT : POLLIN, 0};
        int ready = poll(&wait, 1, (int)left);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) return -1;
        ssize_t n = is_socket ? (writing ? send(fd, p, size, MSG_DONTWAIT) : recv(fd, p, size, MSG_DONTWAIT))
                              : (writing ? write(fd, p, size) : read(fd, p, size));
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n <= 0) return -1;
        p += n; size -= (size_t)n;
    }
    return 0;
}

void ipc_socket_path(const char *file, char *out, size_t outsz) {
    (void)file;
    snprintf(out, outsz, "%s", ALOCK_SOCK_PATH);
}

int ipc_listen(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    unlink(path);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    if (listen(fd, 8) < 0) {
        close(fd);
        unlink(path);
        return -1;
    }
    return fd;
}

int ipc_connect(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

int ipc_send(int fd, const uint8_t *data, size_t len) {
    if (len > 64 * 1024 * 1024) return -1;
    uint32_t hdr = (uint32_t)len;
    uint8_t buf[4] = {
        hdr & 0xff, (hdr >> 8) & 0xff,
        (hdr >> 16) & 0xff, (hdr >> 24) & 0xff
    };
    long long until = deadline(fd, 1);
    return transfer(fd, buf, 4, 1, until) || transfer(fd, (void *)data, len, 1, until) ? -1 : 0;
}

uint8_t *ipc_recv(int fd, size_t *out_len) {
    uint8_t hdr[4];
    long long until = deadline(fd, 0);
    if (transfer(fd, hdr, 4, 0, until)) return NULL;

    uint32_t len = (uint32_t)hdr[0]
                 | ((uint32_t)hdr[1] << 8)
                 | ((uint32_t)hdr[2] << 16)
                 | ((uint32_t)hdr[3] << 24);

    if (!len || len > 64 * 1024 * 1024) return NULL;
    uint8_t *buf = malloc(len);
    if (!buf) return NULL;

    if (transfer(fd, buf, len, 0, until)) { free(buf); return NULL; }

    *out_len = len;
    return buf;
}

void ipc_cleanup(const char *path) {
    unlink(path);
}
