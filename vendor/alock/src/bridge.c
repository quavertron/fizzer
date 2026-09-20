#define _GNU_SOURCE
#include "bridge.h"
#include "history.h"
#include "turns.h"
#include "daemon.h"
#include "ipc.h"
#include "cli.h"
#include <dtob.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/acl.h>
#else
#include <sys/xattr.h>
#endif

#define CONTENT_LIMIT (4u * 1024 * 1024)
#define TICKETS 32
#ifndef BRIDGE_LEASE_SECONDS
#define BRIDGE_LEASE_SECONDS 60
#endif
#ifndef BRIDGE_HEARTBEAT_SECONDS
#define BRIDGE_HEARTBEAT_SECONDS 5
#endif
#define TOKEN_LEN 48
enum { REPLY_OK, STAGE, COMMIT, ABORT, MKDIR, STAGE_DELETE, COMMIT_DELETE,
       STAGE_REPLACE_LINK, STAGE_LINK, REPLY_ERROR = 255 };
/* Wire v1: ALB1 + three network-order u32s (op, argument bytes, content
 * bytes), then argument and opaque content. No untrusted recursive decoder. */
typedef struct {
    unsigned op;
    char argument[PATH_MAX];
    uint8_t *content;
    size_t size;
} Frame;
typedef struct {
    char token[TOKEN_LEN + 1], agent[64], path[PATH_MAX], stage[PATH_MAX];
    uint8_t *base;
    size_t size;
    double created;
    int existed, deleting, leaf_link, make_link;
    char author[33], display_agent[33];
} Ticket;
static volatile sig_atomic_t stopping;
static char bridge_turn[TURN_ID_SIZE];
static void stop_bridge(int sig) { (void)sig; stopping = 1; }
static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

/* Absolute deadlines also bound a client trickling one byte at a time. */
static int transfer(int fd, void *data, size_t size, int sending, double deadline) {
    uint8_t *p = data;
    while (size && !stopping) {
        int ms = (int)((deadline - now()) * 1000);
        if (ms <= 0) return -1;
        struct pollfd pollfd = {fd, sending ? POLLOUT : POLLIN, 0};
        int ready = poll(&pollfd, 1, ms);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) return -1;
        ssize_t n = sending ? send(fd, p, size, 0) : recv(fd, p, size, 0);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n <= 0) return -1;
        p += n; size -= (size_t)n;
    }
    return size ? -1 : 0;
}

static int send_frame(int fd, unsigned op, const char *arg, const void *body, size_t size) {
    size_t len = strlen(arg);
    if (len >= PATH_MAX || size > CONTENT_LIMIT) return -1;
    uint32_t header[] = {htonl(0x414c4231), htonl(op), htonl((uint32_t)len), htonl((uint32_t)size)};
    double deadline = now() + 10;
    return transfer(fd, header, sizeof(header), 1, deadline) ||
           transfer(fd, (void *)arg, len, 1, deadline) ||
           transfer(fd, (void *)body, size, 1, deadline);
}

static int recv_frame(int fd, Frame *frame) {
    uint32_t header[4];
    double deadline = now() + 10;
    if (transfer(fd, header, sizeof(header), 0, deadline)) return -1;
    size_t len = ntohl(header[2]), size = ntohl(header[3]);
    if (ntohl(header[0]) != 0x414c4231 || len >= sizeof(frame->argument) || size > CONTENT_LIMIT) return -1;
    frame->op = ntohl(header[1]); frame->size = size;
    frame->content = malloc(size + 1);
    if (!frame->content) return -1;
    if (transfer(fd, frame->argument, len, 0, deadline) || memchr(frame->argument, 0, len) ||
        transfer(fd, frame->content, size, 0, deadline)) return -1;
    frame->argument[len] = 0;
    return 0;
}

static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0;
}

static int peer_uid(int fd, uid_t *uid) {
#ifdef __APPLE__
    gid_t gid;
    return getpeereid(fd, uid, &gid);
#else
    struct ucred peer;
    socklen_t len = sizeof(peer);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &len)) return -1;
    *uid = peer.uid;
    return 0;
#endif
}

static int safe_acl(const char *path, int directory) {
#ifdef __APPLE__
    acl_t acl = acl_get_file(path, ACL_TYPE_EXTENDED);
    /* macOS reports ENOENT for an absent extended ACL as well as a missing
     * file. Require the file to still exist; reject all other lookup errors. */
    if (!acl) {
        struct stat st;
        return errno == ENOENT && lstat(path, &st) == 0;
    }
    acl_entry_t entry;
    /* Standard macOS home directories have an everyone deny-delete ACL.
     * Deny entries cannot grant write access; keep rejecting all allow entries. */
    int safe = 1;
    int next = ACL_FIRST_ENTRY;
    while (acl_get_entry(acl, next, &entry) == 0) {
        acl_tag_t tag;
        if (!directory || acl_get_tag_type(entry, &tag) || tag != ACL_EXTENDED_DENY) {
            safe = 0;
            break;
        }
        next = ACL_NEXT_ENTRY;
    }
    acl_free(acl);
    return safe;
#else
    (void)directory;
    if (getxattr(path, "system.posix_acl_access", NULL, 0) >= 0) return 0;
    return errno == ENODATA || errno == ENOTSUP;
#endif
}

static int protected_path(const char *path, int directory) {
    struct stat st;
    if (lstat(path, &st) || (st.st_uid != 0 && st.st_uid != getuid()) || !safe_acl(path, directory)) return 0;
    if (directory) {
        int sticky = st.st_uid == 0 && (st.st_mode & S_ISVTX);
        return S_ISDIR(st.st_mode) && (!(st.st_mode & 022) || sticky);
    }
    return S_ISREG(st.st_mode) && st.st_nlink == 1 && !(st.st_mode & 022) && st.st_size <= CONTENT_LIMIT;
}

static int parents_safe(const char *path) {
    char parent[PATH_MAX];
    if (strlen(path) >= sizeof(parent) || path[0] != '/') return 0;
    strcpy(parent, path);
    char *slash;
    while ((slash = strrchr(parent, '/')) != NULL) {
        *slash = 0;
        if (!protected_path(parent[0] ? parent : "/", 1)) return 0;
        if (!parent[0]) break;
    }
    return 1;
}

static int safe_link(const char *path) {
    struct stat st;
    return !lstat(path, &st) && S_ISLNK(st.st_mode) &&
        (st.st_uid == getuid() || st.st_uid == 0) && st.st_nlink == 1;
}

static int target_path_mode(const char *root, const char *relative, char *path, int allow_link) {
    if (!relative[0] || relative[0] == '/') return 0;
    for (const char *p = relative; ; ) {
        const char *end = strchr(p, '/');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        if (!n || (n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.')) return 0;
        if (!end) break;
        p = end + 1;
    }
    if (snprintf(path, PATH_MAX, "%s/%s", !strcmp(root, "/") ? "" : root, relative) >= PATH_MAX || !parents_safe(path)) return 0;
    struct stat st;
    if (lstat(path, &st) < 0) return errno == ENOENT;
    return protected_path(path, 0) || (allow_link && safe_link(path));
}

static int target_path(const char *root, const char *relative, char *path) {
    return target_path_mode(root, relative, path, 0);
}

static uint8_t *read_link(const char *path, size_t *size) {
    uint8_t *data = malloc(PATH_MAX);
    if (!data) return NULL;
    ssize_t n = readlink(path, (char *)data, PATH_MAX);
    if (n < 0 || n == PATH_MAX) { free(data); return NULL; }
    *size = (size_t)n;
    return data;
}

static uint8_t *read_file(const char *path, size_t *size) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    struct stat st;
    uint8_t *data = NULL;
    if (fd < 0) return NULL;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || st.st_size > CONTENT_LIMIT) goto done;
    data = malloc(CONTENT_LIMIT + 1);
    if (!data) goto done;
    *size = 0;
    while (*size <= CONTENT_LIMIT) {
        ssize_t n = read(fd, data + *size, CONTENT_LIMIT + 1 - *size);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { free(data); data = NULL; break; }
        if (!n) break;
        *size += (size_t)n;
    }
    if (*size > CONTENT_LIMIT) { free(data); data = NULL; }
done:
    close(fd);
    return data;
}

static int write_all(int fd, const void *data, size_t size) {
    const uint8_t *p = data;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        p += n; size -= (size_t)n;
    }
    return 0;
}

/* Only trusted daemon responses use DTOB; agent requests never reach it raw. */
static int daemon_call(const char *operation, Ticket *ticket, char *error, size_t error_size) {
    char sock[PATH_MAX];
    if (daemon_spawn(ticket->path, sock, sizeof(sock))) goto failed;
    int needs_author = !strcmp(operation, "commit") || (!strcmp(operation, "stage") && (ticket->deleting || ticket->leaf_link));
    int capability = bridge_turn[0] ? daemon_turn_capable(sock) : needs_author ? daemon_author_capable(sock) : 1;
    if (capability < 0) {
        snprintf(error, error_size, "Private alock daemon is busy or unavailable; retry after it responds"); return -2;
    }
    if (!capability) {
        snprintf(error, error_size, "Running alock daemon lacks required author/history or turn support; let locks drain and allow 30 seconds idle, then retry"); return -1;
    }
    int fd = ipc_connect(sock);
    if (fd < 0) goto failed;
    struct timeval timeout = {10, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    DtobValue *request = dtob_kvset();
    dtob_kvset_put(request, "cmd", dtob_raw((const uint8_t *)operation, strlen(operation)));
    dtob_kvset_put(request, "file", dtob_raw((uint8_t *)ticket->path, strlen(ticket->path)));
    dtob_kvset_put(request, "agent", dtob_raw((uint8_t *)ticket->agent, strlen(ticket->agent)));
    if (bridge_turn[0]) dtob_kvset_put(request, "turn", dtob_raw((uint8_t *)bridge_turn, strlen(bridge_turn)));
    dtob_kvset_put(request, "display_agent", dtob_raw((uint8_t *)ticket->display_agent, strlen(ticket->display_agent)));
    if (ticket->author[0]) dtob_kvset_put(request, "author", dtob_raw((uint8_t *)ticket->author, strlen(ticket->author)));
    if (!strcmp(operation, "stage")) {
        if (ticket->deleting) dtob_kvset_put(request, "delete", dtob_uint(1));
        if (ticket->leaf_link) dtob_kvset_put(request, "replace_symlink", dtob_uint(1));
        if (ticket->make_link) dtob_kvset_put(request, "make_symlink", dtob_uint(1));
        dtob_kvset_put(request, "line_start", dtob_uint(1));
        dtob_kvset_put(request, "line_end", dtob_uint(2147483647));
    } else dtob_kvset_put(request, "stage", dtob_raw((uint8_t *)ticket->stage, strlen(ticket->stage)));
    size_t len;
    uint8_t *bytes = dtob_encode(request, &len);
    dtob_free(request);
    int sent = bytes ? ipc_send(fd, bytes, len) : -1;
    free(bytes);
    bytes = sent ? NULL : ipc_recv(fd, &len);
    close(fd);
    if (!bytes) goto failed;
    DtobValue *reply = dtob_decode(bytes, len);
    free(bytes);
    if (!reply) goto failed;
    int ok = dtob_kvset_uint(reply, "ok") == 1;
    if (!ok) dtob_kvset_str(reply, "error", error, error_size);
    else if (dtob_kvset_str(reply, "historyError", error, error_size) > 0) ok = 0;
    else if (!strcmp(operation, "stage")) dtob_kvset_str(reply, "stage", ticket->stage, sizeof(ticket->stage));
    dtob_free(reply);
    return ok ? 0 : -1;
failed:
    snprintf(error, error_size, "Private alock daemon is unavailable; request outcome is unknown, verify the file before retrying an edit");
    return -2;
}

static void discard(Ticket *ticket) {
    if (ticket->stage[0]) {
        char ignored[512];
        daemon_call("abort", ticket, ignored, sizeof(ignored));
    }
    free(ticket->base);
    memset(ticket, 0, sizeof(*ticket));
}

static void handle(int client, const char *root, Ticket *tickets, Frame *request) {
    char error[512] = "Invalid request";
    Ticket *ticket = NULL;
    char *author = NULL;
    if (request->op == COMMIT || request->op == COMMIT_DELETE || request->op == MKDIR) {
        author = strchr(request->argument, '\n');
        if (author) *author++ = 0;
        if (!history_author_valid(author)) { strcpy(error, "--author is required (1-32 bytes, no control characters)"); goto fail; }
        if (history_enabled(error, sizeof(error)) < 0) goto fail;
    }
    if (request->op == MKDIR && request->size == 0) {
        char destination[PATH_MAX];
        struct stat st;
        if (!target_path(root, request->argument, destination) ||
            lstat(destination, &st) == 0 || errno != ENOENT) {
            strcpy(error, "Cannot create directory: parent must be safe and destination absent"); goto fail;
        }
        if (bridge_turn[0]) {
            Ticket creation = {0};
            strcpy(creation.path, destination);
            snprintf(creation.author, sizeof(creation.author), "%s", author);
            if (daemon_call("mkdir", &creation, error, sizeof(error))) goto fail;
        } else {
            if (history_flush(destination) || mkdir(destination, 0755)) goto fail;
            if (history_record(destination, author, "mkdir", "", 0, "directory\n", 10, error, sizeof(error))) goto fail;
        }
        send_frame(client, REPLY_OK, "", NULL, 0);
        return;
    }
    if ((request->op == STAGE || request->op == STAGE_DELETE || request->op == STAGE_REPLACE_LINK || request->op == STAGE_LINK) && request->size == 0) {
        char *identity = strchr(request->argument, '\n');
        if (identity) *identity++ = 0;
        if (identity && !history_author_valid(identity)) goto fail;
        for (int i = 0; i < TICKETS; i++) if (!tickets[i].token[0]) { ticket = &tickets[i]; break; }
        if (!ticket) { strcpy(error, "Too many pending proposals"); goto fail; }
        if (!target_path_mode(root, request->argument, ticket->path, request->op != STAGE)) {
            strcpy(error, "Unsafe or missing target: check path, permissions, links and ACLs"); goto fail;
        }
        uint8_t random[24];
        int fd = open("/dev/urandom", O_RDONLY);
        if (fd < 0) goto fail;
        ssize_t n = read(fd, random, sizeof(random));
        close(fd);
        if (n != sizeof(random)) goto fail;
        for (size_t i = 0; i < sizeof(random); i++) snprintf(ticket->token + i * 2, 3, "%02x", random[i]);
        snprintf(ticket->agent, sizeof(ticket->agent), "bridge-%s", ticket->token);
        snprintf(ticket->display_agent, sizeof(ticket->display_agent), "%s", identity ? identity : "fizzer");
        ticket->created = now();
        struct stat initial;
        ticket->existed = lstat(ticket->path, &initial) == 0;
        ticket->deleting = request->op == STAGE_DELETE;
        ticket->leaf_link = ticket->existed && S_ISLNK(initial.st_mode);
        ticket->make_link = request->op == STAGE_LINK;
        if ((request->op == STAGE_REPLACE_LINK || request->op == STAGE_LINK) && !ticket->leaf_link) {
            strcpy(error, "Expected an existing symlink"); goto fail;
        }
        if (daemon_call("stage", ticket, error, sizeof(error))) goto fail;
        ticket->base = read_file(ticket->stage, &ticket->size);
        if (!ticket->base) { strcpy(error, "Cannot read baseline (maximum 4 MiB)"); goto fail; }
        if (send_frame(client, REPLY_OK, ticket->token, ticket->base, ticket->size)) discard(ticket);
        return;
    }
    if ((request->op != COMMIT && request->op != COMMIT_DELETE && request->op != ABORT) || strlen(request->argument) != TOKEN_LEN) goto fail;
    for (int i = 0; i < TICKETS; i++)
        if (!strcmp(tickets[i].token, request->argument)) { ticket = &tickets[i]; break; }
    if (!ticket) { strcpy(error, "Unknown or expired ticket"); goto fail; }
    if (author) snprintf(ticket->author, sizeof(ticket->author), "%s", author);
    if (now() - ticket->created > BRIDGE_LEASE_SECONDS) {
        strcpy(error, "Expired ticket; stage again"); goto fail;
    }
    if (request->op == ABORT) {
        if (request->size) goto fail;
        discard(ticket);
        send_frame(client, REPLY_OK, "", NULL, 0);
        return;
    }
    if (ticket->deleting != (request->op == COMMIT_DELETE) || (ticket->deleting && request->size)) {
        strcpy(error, "Commit operation does not match staged operation"); goto fail;
    }
    struct stat current_stat;
    int absent = lstat(ticket->path, &current_stat) < 0 && errno == ENOENT;
    if (!parents_safe(ticket->path) || (ticket->existed ?
        !(ticket->leaf_link ? safe_link(ticket->path) : protected_path(ticket->path, 0)) : !absent)) {
        strcpy(error, "Target permissions or links changed"); goto fail;
    }
    size_t size = 0;
    uint8_t *current = ticket->leaf_link ? read_link(ticket->path, &size) :
        ticket->existed ? read_file(ticket->path, &size) : calloc(1, 1);
    int matches = current && size == ticket->size && !memcmp(current, ticket->base, size);
    free(current);
    if (!matches) { strcpy(error, "File changed since staging; stage again"); goto fail; }
    /* This path came from our private daemon, never the agent. */
    int written;
    if (ticket->deleting) written = unlink(ticket->stage);
    else {
        int fd = open(ticket->stage, O_WRONLY | O_TRUNC | O_NOFOLLOW);
        if (fd < 0) goto fail;
        written = write_all(fd, request->content, request->size);
        if (close(fd)) written = -1;
    }
    if (written || daemon_call("commit", ticket, error, sizeof(error))) goto fail;
    ticket->stage[0] = 0;
    discard(ticket);
    send_frame(client, REPLY_OK, "", NULL, 0);
    return;
fail:
    if (ticket) discard(ticket);
    send_frame(client, REPLY_ERROR, error, NULL, 0);
}

int bridge_serve(const char *root_path, const char *socket_path, uid_t peer) {
    return bridge_serve_turn(root_path, socket_path, peer, 0);
}

/* C filesystem/peer primitives shared with the Rust account controller. */
int account_target(const char *root, const char *relative, char *out) {
    return target_path(root, relative, out);
}
int account_safe(const char *path) {
    struct stat st;
    return parents_safe(path) && (lstat(path, &st) < 0 ? errno == ENOENT : protected_path(path, 0));
}
int account_peer(int fd, unsigned uid) {
    uid_t peer;
    return peer_uid(fd, &peer) == 0 && peer == (uid_t)uid;
}

int bridge_serve_turn(const char *root_path, const char *socket_path, uid_t peer, int batching) {
    char root[PATH_MAX], parent[PATH_MAX];
    struct stat st;
    if (!realpath(root_path, root) || !protected_path(root, 1) || !parents_safe(root) ||
        strlen(socket_path) >= sizeof(parent) || !parents_safe(socket_path)) goto unsafe;
    strcpy(parent, socket_path);
    char *slash = strrchr(parent, '/');
    if (!slash || slash == parent) goto unsafe;
    *slash = 0;
    if (stat(parent, &st) || st.st_uid != getuid() || (st.st_mode & 022)) goto unsafe;
    if (mkdir(ALOCK_SOCK_DIR, 0700) && errno != EEXIST) goto unsafe;
    if (lstat(ALOCK_SOCK_DIR, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077)) goto unsafe;
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    if (strlen(socket_path) >= sizeof(address.sun_path)) goto unsafe;
    strcpy(address.sun_path, socket_path);
    int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) return 1;
    /* Never unlink an existing endpoint. */
    if (bind(listener, (struct sockaddr *)&address, sizeof(address))) {
        perror("alock bridge bind"); close(listener); return 1;
    }
    int result = 1;
    Ticket *tickets = calloc(TICKETS, sizeof(*tickets));
    Ticket lifecycle = {0};
    char lifecycle_error[512];
    bridge_turn[0] = 0;
    if (batching) {
        char key[65];
        alock_nab_key(socket_path, key);
        snprintf(bridge_turn, sizeof(bridge_turn), "%s-%ld", key, (long)getpid());
        if (daemon_call("turn-heartbeat", &lifecycle, lifecycle_error, sizeof(lifecycle_error))) {
            fprintf(stderr, "alock bridge: %s\n", lifecycle_error); goto done;
        }
    }
    if (!tickets || chmod(socket_path, 0666) || listen(listener, 8)) goto done;
    stopping = 0;
    signal(SIGPIPE, SIG_IGN);
    struct sigaction action = {0};
    action.sa_handler = stop_bridge;
    sigaction(SIGINT, &action, NULL); sigaction(SIGTERM, &action, NULL);
    printf("Bridge ready: %s\n", socket_path); fflush(stdout);
    double heartbeat = now();
    while (!stopping) {
        if (bridge_turn[0] && now() - heartbeat >= BRIDGE_HEARTBEAT_SECONDS) {
            int result = daemon_call("turn-heartbeat", &lifecycle, lifecycle_error, sizeof(lifecycle_error));
            if (result) {
                fprintf(stderr, "alock bridge: %s\n", lifecycle_error);
                if (result != -2) break;
            }
            heartbeat = now();
        }
        for (int i = 0; i < TICKETS; i++)
            if (tickets[i].token[0] && now() - tickets[i].created > BRIDGE_LEASE_SECONDS) discard(&tickets[i]);
        struct pollfd pollfd = {listener, POLLIN, 0};
        int ready = poll(&pollfd, 1, 1000);
        if (ready < 0 && errno != EINTR) break;
        if (ready <= 0) continue;
        int client = accept(listener, NULL, NULL);
        if (client < 0) continue;
        uid_t uid;
        Frame request = {0};
        if (!nonblocking(client)) {
            if (peer_uid(client, &uid) || uid != peer)
                send_frame(client, REPLY_ERROR, "Unix peer UID is not authorized", NULL, 0);
            else if (recv_frame(client, &request))
                send_frame(client, REPLY_ERROR, "Invalid or oversized frame", NULL, 0);
            else handle(client, root, tickets, &request);
        }
        free(request.content);
        close(client);
    }
    result = stopping ? 0 : 1;
done:
    close(listener); unlink(socket_path);
    if (tickets) for (int i = 0; i < TICKETS; i++) if (tickets[i].token[0]) discard(&tickets[i]);
    if (bridge_turn[0] && daemon_call("turn-end", &lifecycle, lifecycle_error, sizeof(lifecycle_error))) {
        fprintf(stderr, "alock bridge: %s\n", lifecycle_error); result = 1;
    }
    free(tickets);
    return result;
unsafe:
    fprintf(stderr, "alock bridge: unsafe root, socket directory, or private daemon runtime\n");
    return 1;
}

int cmd_bridge(int argc, char **argv) {
    const char *endpoint = arg_get(argc, argv, "--socket");
    if (argc < 3 || !endpoint) goto usage;
    const char *operation = argv[2];
    if (!strcmp(operation, "serve")) {
        const char *root = arg_get(argc, argv, "--root"), *user = arg_get(argc, argv, "--user");
        if (!root || !user) goto usage;
        struct passwd *account = getpwnam(user);
        if (!account || getuid() == 0 || geteuid() != getuid() || !account->pw_uid || account->pw_uid == getuid()) {
            fprintf(stderr, "alock bridge: run as human non-root user; authorize a different non-root account\n"); return 1;
        }
        int batching = 0;
        for (int i = 3; i < argc; i++) if (!strcmp(argv[i], "--turn")) batching = 1;
        return bridge_serve_turn(root, endpoint, account->pw_uid, batching);
    }
    unsigned op = !strcmp(operation, "stage") ? STAGE : !strcmp(operation, "mkdir") ? MKDIR : !strcmp(operation, "commit") ? COMMIT : !strcmp(operation, "abort") ? ABORT : 0;
    for (int i = 3; i < argc; i++) {
        if (!strcmp(argv[i], "--delete")) {
            if (op == STAGE) op = STAGE_DELETE;
            else if (op == COMMIT) op = COMMIT_DELETE;
            else goto usage;
        } else if (!strcmp(argv[i], "--replace-symlink") || !strcmp(argv[i], "--symlink")) {
            if (op != STAGE) goto usage;
            op = !strcmp(argv[i], "--symlink") ? STAGE_LINK : STAGE_REPLACE_LINK;
        }
    }
    int staging = op == STAGE || op == STAGE_DELETE || op == STAGE_REPLACE_LINK || op == STAGE_LINK;
    const char *argument = arg_get(argc, argv, staging || op == MKDIR ? "--path" : "--ticket");
    if (!op || !argument) goto usage;
    char attributed[PATH_MAX];
    if (staging) {
        const char *agent = arg_get(argc, argv, "--author");
        if (!agent) agent = arg_get(argc, argv, "--agent");
        if (agent) {
            if (!history_author_valid(agent) || strchr(argument, '\n') ||
                snprintf(attributed, sizeof(attributed), "%s\n%s", argument, agent) >= (int)sizeof(attributed)) goto usage;
            argument = attributed;
        }
    }
    if (op == COMMIT || op == COMMIT_DELETE || op == MKDIR) {
        const char *author = arg_get(argc, argv, "--author");
        if (!history_author_valid(author)) {
            fprintf(stderr, "alock bridge: --author is required (1-32 bytes, no control characters)\n"); return 2;
        }
        if (strchr(argument, '\n') || snprintf(attributed, sizeof(attributed), "%s\n%s", argument, author) >= (int)sizeof(attributed)) goto usage;
        argument = attributed;
    }
    uint8_t *content = NULL;
    size_t size = 0;
    if (op == COMMIT) {
        const char *file = arg_get(argc, argv, "--file");
        if (!file) goto usage;
        content = read_file(file, &size);
        if (!content) { fprintf(stderr, "alock bridge: unreadable/non-regular proposal or exceeds 4 MiB limit\n"); return 1; }
    }
    if (strlen(endpoint) >= sizeof(((struct sockaddr_un *)0)->sun_path)) { free(content); goto usage; }
    signal(SIGPIPE, SIG_IGN);
    int fd = ipc_connect(endpoint), result = 1;
    Frame response = {0};
    if (fd < 0 || nonblocking(fd) || send_frame(fd, op, argument, content, size) || recv_frame(fd, &response)) {
        fprintf(stderr, "alock bridge: connection failed or invalid response\n"); goto done;
    }
    if (response.op != REPLY_OK) { fprintf(stderr, "alock bridge: %s\n", response.argument); goto done; }
    if (staging) {
        if (strlen(response.argument) != TOKEN_LEN) goto done;
        char temporary[] = "/tmp/alock-proposal-XXXXXX", escaped[PATH_MAX * 2];
        int output = mkstemp(temporary);
        if (output < 0) goto done;
        int failed = write_all(output, response.content, response.size);
        if (close(output)) failed = 1;
        if (failed) { unlink(temporary); goto done; }
        /* Ticket is hexadecimal; reject a malformed server response before JSON. */
        if (strspn(response.argument, "0123456789abcdef") != TOKEN_LEN) { unlink(temporary); goto done; }
        json_escape(temporary, escaped, sizeof(escaped));
        printf("{\"ticket\":\"%s\",\"file\":\"%s\"}\n", response.argument, escaped);
    } else printf("{\"ok\":true}\n");
    result = 0;
done:
    if (fd >= 0) close(fd);
    free(content); free(response.content);
    return result;
usage:
    fprintf(stderr, "usage: alock bridge serve --socket PATH --root DIR --user USER [--turn]\n"
                    "       alock bridge stage --socket PATH --path RELATIVE_FILE [--delete | --replace-symlink | --symlink] [--author NAME | --agent NAME]\n"
                    "       alock bridge mkdir --socket PATH --path RELATIVE_DIRECTORY --author NAME\n"
                    "       alock bridge commit --socket PATH --ticket TOKEN (--file PROPOSAL | --delete) --author NAME\n"
                    "       alock bridge abort --socket PATH --ticket TOKEN\n");
    return 2;
}
