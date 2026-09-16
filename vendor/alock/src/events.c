#include "events.h"
#include "cli.h"
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

void events_change(const char *file, uint32_t start, uint32_t end,
                   const char *agent, const char *author) {
    char default_dir[128];
    snprintf(default_dir, sizeof(default_dir), "/tmp/alock-events-%lu", (unsigned long)getuid());
    const char *directory = getenv("ALOCK_EVENT_DIR");
    if (!directory || !*directory) directory = default_dir;
    struct stat info;
    if (lstat(directory, &info) || !S_ISDIR(info.st_mode) ||
        info.st_uid != getuid() || (info.st_mode & 0077)) return;
    DIR *entries = opendir(directory);
    if (!entries) return;
    char escaped_file[24577], escaped_agent[769], escaped_author[193], payload[27000];
    json_escape(file, escaped_file, sizeof(escaped_file));
    json_escape(agent, escaped_agent, sizeof(escaped_agent));
    json_escape(author, escaped_author, sizeof(escaped_author));
    int length = snprintf(payload, sizeof(payload),
        "{\"kind\":\"change\",\"file\":\"%s\",\"line_start\":%u,\"line_end\":%u,"
        "\"agent\":\"%s\",\"author\":\"%s\"}\n",
        escaped_file, start, end, escaped_agent, escaped_author);
    if (length < 0 || (size_t)length >= sizeof(payload)) { closedir(entries); return; }
    int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
    if (fd < 0) { closedir(entries); return; }
    struct dirent *entry;
    while ((entry = readdir(entries))) {
        size_t size = strlen(entry->d_name);
        int stream = size > 7 && !strcmp(entry->d_name + size - 7, ".stream");
        int datagram = size > 5 && !strcmp(entry->d_name + size - 5, ".sock");
        if (!stream && !datagram) continue;
        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        int n = snprintf(address.sun_path, sizeof(address.sun_path), "%s/%s", directory, entry->d_name);
        if (n < 0 || (size_t)n >= sizeof(address.sun_path)) continue;
        if (lstat(address.sun_path, &info) || !S_ISSOCK(info.st_mode) || info.st_uid != getuid()) continue;
        if (stream) {
            int client = socket(AF_UNIX, SOCK_STREAM, 0);
            if (client < 0) continue;
            int flags = fcntl(client, F_GETFL);
            if (flags < 0 || fcntl(client, F_SETFL, flags | O_NONBLOCK) < 0) {
                close(client); continue;
            }
#ifdef SO_NOSIGPIPE
            int one = 1;
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
            if (connect(client, (struct sockaddr *)&address, sizeof(address)) == 0) {
                size_t sent = 0;
                while (sent < (size_t)length) {
                    int send_flags = MSG_DONTWAIT;
#ifdef MSG_NOSIGNAL
                    send_flags |= MSG_NOSIGNAL;
#endif
                    ssize_t n = send(client, payload + sent, (size_t)length - sent, send_flags);
                    if (n <= 0) break;
                    sent += (size_t)n;
                }
            }
            close(client);
        } else {
            (void)sendto(fd, payload, (size_t)length, MSG_DONTWAIT,
                         (struct sockaddr *)&address, sizeof(address));
        }
    }
    close(fd);
    closedir(entries);
}
