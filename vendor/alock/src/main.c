/*
 * main.c — alock CLI (daemon client)
 *
 * commands:
 *   alock acquire --file foo.c --lines 10-50 --agent abc123
 *   alock write   --file foo.c --lines 15-17 --agent abc123 < content
 *   alock release --file foo.c --agent abc123
 *   alock release-agent --agent abc123
 *   alock check   --file foo.c --agent abc123
 *   alock status  [--file foo.c]
 */
#include "ipc.h"
#include "daemon.h"
#include "history.h"
#include "bridge.h"
#include "cli.h"
#include <dtob.h>
#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

const char *resolve_path(const char *path, char *resolved, size_t size) {
    if (realpath(path, resolved) != NULL)
        return resolved;
    /* Missing files still need the same lock key through symlinked parents. */
    char copy[4096], parent[4096];
    if (strlen(path) < sizeof(copy)) {
        strcpy(copy, path);
        char *slash = strrchr(copy, '/');
        const char *name = slash ? slash + 1 : copy;
        if (slash) *slash = '\0';
        if (name[0] && realpath(slash ? (copy[0] ? copy : "/") : ".", parent) &&
            snprintf(resolved, size, "%s/%s", parent, name) < (int)size)
            return resolved;
    }
    if (path[0] == '/') {
        strncpy(resolved, path, size - 1);
        resolved[size - 1] = '\0';
    } else {
        char cwd[4096];
        if (getcwd(cwd, sizeof(cwd)))
            snprintf(resolved, size, "%s/%s", cwd, path);
        else
            strncpy(resolved, path, size - 1);
    }
    return resolved;
}

static void usage(void) {
    fprintf(stderr,
        "usage:\n"
        "  alock bridge serve --socket <path> --root <directory> --user <agent-user>\n"
        "  alock bridge stage --socket <path> --path <relative-file>\n"
        "  alock bridge commit --socket <path> --ticket <ticket> --file <proposal> --author <name>\n"
        "  alock bridge mkdir --socket <path> --path <directory> --author <name>\n"
        "  alock bridge abort --socket <path> --ticket <ticket>\n"
        "  alock stage         --file <path> --lines <start>-<end> --agent <id> [--delete | --to <path>]\n"
        "  alock commit       --file <path> --stage <temp-path> --agent <id> --author <name>\n"
        "  alock abort        --file <path> --stage <temp-path> --agent <id>\n"
        "  alock history      --file <path> [--retry]\n"
        "  alock acquire       --file <path> --lines <start>-<end> --agent <id>\n"
        "  alock write         --file <path> --lines <start>-<end> --agent <id> --author <name> < content\n"
        "  alock release       --file <path> --agent <id>\n"
        "  alock release-agent --agent <id>\n"
        "  alock check         --file <path> --agent <id>\n"
        "  alock status        [--file <path>]\n");
}

const char *arg_get(int argc, char **argv, const char *flag) {
    for (int i = 0; i < argc - 1; i++)
        if (strcmp(argv[i], flag) == 0) return argv[i + 1];
    return NULL;
}

int arg_has(int argc, char **argv, const char *flag) {
    for (int i = 1; i < argc; i++)
        if (strcmp(argv[i], flag) == 0) return 1;
    return 0;
}

static int parse_lines(const char *s, uint32_t *start, uint32_t *end) {
    return sscanf(s, "%u-%u", start, end) == 2 ? 0 : -1;
}

void json_escape(const char *src, char *dst, size_t dstsz) {
    size_t j = 0;
    if (!src) { if (dstsz > 0) dst[0] = '\0'; return; }
    for (size_t i = 0; src[i] && j + 2 < dstsz; i++) {
        unsigned char c = src[i];
        if (c == '"' || c == '\\') {
            dst[j++] = '\\';
            dst[j++] = c;
        } else if (c == '\n') {
            dst[j++] = '\\';
            dst[j++] = 'n';
        } else if (c == '\r') {
            dst[j++] = '\\';
            dst[j++] = 'r';
        } else if (c == '\t') {
            dst[j++] = '\\';
            dst[j++] = 't';
        } else if (c >= 0x20) {
            dst[j++] = c;
        }
    }
    dst[j] = '\0';
}



typedef struct {
    char file[4096];
    const char *agent;
    uint32_t line_start;
    uint32_t line_end;
} RangeArgs;

static int parse_range_args(int argc, char **argv, const char *cmd,
                            RangeArgs *args) {
    const char *file = arg_get(argc, argv, "--file");
    const char *lines = arg_get(argc, argv, "--lines");
    args->agent = arg_get(argc, argv, "--agent");

    if (!file || !lines || !args->agent) {
        fprintf(stderr, "alock %s: missing required args\n", cmd);
        return -1;
    }
    if (parse_lines(lines, &args->line_start, &args->line_end) != 0)
        return -1;

    resolve_path(file, args->file, sizeof(args->file));
    return 0;
}

static DtobValue *daemon_request(const char *sock_path, DtobValue *req) {
    int fd = ipc_connect(sock_path);
    if (fd < 0) {
        fprintf(stderr, "alock: cannot connect to daemon\n");
        dtob_free(req);
        return NULL;
    }

    size_t enc_len;
    uint8_t *enc = dtob_encode(req, &enc_len);
    dtob_free(req);
    if (!enc) { close(fd); return NULL; }

    if (ipc_send(fd, enc, enc_len) != 0) {
        free(enc);
        close(fd);
        return NULL;
    }
    free(enc);

    size_t resp_len;
    uint8_t *resp_data = ipc_recv(fd, &resp_len);
    close(fd);
    if (!resp_data) return NULL;

    DtobValue *resp = dtob_decode(resp_data, resp_len);
    free(resp_data);
    return resp;
}

static DtobValue *make_request(const char *cmd, const char *file,
                               const char *agent) {
    DtobValue *req = dtob_kvset();
    dtob_kvset_put(req, "cmd", dtob_raw((const uint8_t *)cmd, strlen(cmd)));
    if (file)
        dtob_kvset_put(req, "file", dtob_raw((const uint8_t *)file, strlen(file)));
    if (agent)
        dtob_kvset_put(req, "agent", dtob_raw((const uint8_t *)agent, strlen(agent)));
    return req;
}

static DtobValue *make_range_request(const char *cmd, const RangeArgs *args) {
    DtobValue *req = make_request(cmd, args->file, args->agent);
    dtob_kvset_put(req, "line_start", dtob_uint(args->line_start));
    dtob_kvset_put(req, "line_end", dtob_uint(args->line_end));
    return req;
}

static int resp_ok(DtobValue *resp);
static void print_error(DtobValue *resp);
static void print_lock_json(DtobValue *resp);

static int finish_response(DtobValue *resp, int print_lock) {
    if (!resp) return 1;
    int ok = resp_ok(resp);
    char history_error[512] = {0};
    dtob_kvset_str(resp, "historyError", history_error, sizeof(history_error));
    if (ok && history_error[0]) {
        fprintf(stderr, "alock: %s\n", history_error);
        dtob_free(resp);
        return 1;
    }
    if (!ok) print_error(resp);
    else if (print_lock) print_lock_json(resp);
    else printf("{\"ok\":true}\n");
    dtob_free(resp);
    return ok ? 0 : 1;
}

static int resp_ok(DtobValue *resp) {
    return resp && dtob_kvset_uint(resp, "ok") == 1;
}

static void print_error(DtobValue *resp) {
    char err[512];
    dtob_kvset_str(resp, "error", err, sizeof(err));
    fprintf(stderr, "alock: %s\n", err);
}

static void print_lock_json(DtobValue *resp) {
    printf("{\"ok\":true,\"lock\":%lld,\"line_start\":%llu,\"line_end\":%llu,"
           "\"byte_start\":%lld,\"length\":%llu}\n",
           (long long)dtob_kvset_int(resp, "lock"),
           (unsigned long long)dtob_kvset_uint(resp, "line_start"),
           (unsigned long long)dtob_kvset_uint(resp, "line_end"),
           (long long)dtob_kvset_int(resp, "byte_start"),
           (unsigned long long)dtob_kvset_uint(resp, "length"));
}

static void print_status_json(DtobValue *resp) {
    char file[4096];
    dtob_kvset_str(resp, "file", file, sizeof(file));

    DtobValue *locks = dtob_kvset_get(resp, "locks");
    if (!locks || locks->num_elements == 0) {
        printf("{\"ok\":true,\"file\":\"%s\",\"locks\":[]}\n", file);
        return;
    }

    printf("{\"ok\":true,\"file\":\"%s\",\"locks\":[", file);
    for (size_t i = 0; i < locks->num_elements; i++) {
        DtobValue *e = locks->elements[i].data.val;
        char agent[128];
        char lock_file[4096];
        dtob_kvset_str(e, "agent", agent, sizeof(agent));
        dtob_kvset_str(e, "file", lock_file, sizeof(lock_file));
        printf("%s{\"lock\":%lld,\"agent\":\"%s\",\"line_start\":%llu,"
               "\"line_end\":%llu,\"byte_start\":%lld,\"length\":%llu,\"ttl\":%lld",
               i > 0 ? "," : "",
               (long long)dtob_kvset_int(e, "lock"),
               agent,
               (unsigned long long)dtob_kvset_uint(e, "line_start"),
               (unsigned long long)dtob_kvset_uint(e, "line_end"),
               (long long)dtob_kvset_int(e, "byte_start"),
               (unsigned long long)dtob_kvset_uint(e, "length"),
               (long long)dtob_kvset_int(e, "ttl"));
        if (lock_file[0]) printf(",\"file\":\"%s\"", lock_file);
        printf("}");
    }
    printf("]}\n");
}

static int cmd_acquire(int argc, char **argv) {
    RangeArgs args;
    if (parse_range_args(argc, argv, "acquire", &args) != 0) return 2;

    char sock_path[4096];
    if (daemon_spawn(args.file, sock_path, sizeof(sock_path)) != 0) {
        fprintf(stderr, "alock: cannot start daemon\n");
        return 1;
    }

    return finish_response(
        daemon_request(sock_path, make_range_request("acquire", &args)), 1);
}

static int cmd_stage(int argc, char **argv) {
    RangeArgs args;
    if (parse_range_args(argc, argv, "stage", &args)) return 2;
    const char *destination = arg_get(argc, argv, "--to");
    int deleting = arg_has(argc, argv, "--delete");
    if (deleting && destination) { fprintf(stderr, "alock: --delete and --to are mutually exclusive\n"); return 2; }
    DtobValue *req = make_range_request("stage", &args);
    if (deleting) dtob_kvset_put(req, "delete", dtob_uint(1));
    if (destination) {
        /* Canonicalize the parent while retaining the final directory entry. */
        char copy[4096], parent[4096], resolved[4096];
        if (strlen(destination) >= sizeof(copy)) { dtob_free(req); return 2; }
        strcpy(copy, destination);
        char *slash = strrchr(copy, '/');
        const char *name = slash ? slash + 1 : copy;
        if (slash) *slash = '\0';
        if (!name[0] || !strcmp(name, ".") || !strcmp(name, "..") ||
            !realpath(slash ? (copy[0] ? copy : "/") : ".", parent) ||
            snprintf(resolved, sizeof(resolved), "%s/%s", parent, name) >= (int)sizeof(resolved)) {
            fprintf(stderr, "alock: invalid rename destination or missing parent\n");
            dtob_free(req); return 2;
        }
        dtob_kvset_put(req, "destination", dtob_raw((uint8_t *)resolved, strlen(resolved)));
    }
    char sock[4096];
    if (daemon_spawn(args.file, sock, sizeof(sock))) { dtob_free(req); return 1; }
    DtobValue *resp = daemon_request(sock, req);
    if (!resp_ok(resp)) return finish_response(resp, 0);
    char path[4096], escaped[8192];
    dtob_kvset_str(resp, "stage", path, sizeof(path));
    if ((deleting || destination) && dtob_kvset_uint(resp, "operation") != (deleting ? 1u : 2u)) {
        DtobValue *abort_req = make_request("abort", args.file, args.agent);
        dtob_kvset_put(abort_req, "stage", dtob_raw((uint8_t *)path, strlen(path)));
        DtobValue *aborted = daemon_request(sock, abort_req);
        if (aborted) dtob_free(aborted);
        dtob_free(resp);
        fprintf(stderr, "alock: running daemon lacks delete/rename support; retry after its active locks drain and it exits\n");
        return 1;
    }
    json_escape(path, escaped, sizeof(escaped));
    printf("{\"ok\":true,\"stage\":\"%s\"}\n", escaped);
    dtob_free(resp);
    return 0;
}

static int cmd_stage_finish(int argc, char **argv, const char *cmd) {
    const char *author = arg_get(argc, argv, "--author");
    if (!strcmp(cmd, "commit") && !history_author_valid(author)) {
        fprintf(stderr, "alock: --author is required (1-32 bytes, no control characters)\n"); return 2;
    }
    const char *file = arg_get(argc, argv, "--file");
    const char *agent = arg_get(argc, argv, "--agent");
    const char *stage = arg_get(argc, argv, "--stage");
    if (!file || !agent || !stage) return 2;
    char resolved[4096], sock[4096];
    resolve_path(file, resolved, sizeof(resolved));
    ipc_socket_path(resolved, sock, sizeof(sock));
    if (!strcmp(cmd, "commit") && daemon_author_capable(sock) <= 0) {
        fprintf(stderr, "alock: running daemon lacks author/nab support; let locks drain and allow 30 seconds idle before retrying\n"); return 1;
    }
    DtobValue *req = make_request(cmd, resolved, agent);
    if (author) dtob_kvset_put(req, "author", dtob_raw((const uint8_t *)author, strlen(author)));
    dtob_kvset_put(req, "stage", dtob_raw((const uint8_t *)stage, strlen(stage)));
    DtobValue *resp = daemon_request(sock, req);
    return finish_response(resp, 0);
}

static int cmd_write(int argc, char **argv) {
    const char *author = arg_get(argc, argv, "--author");
    if (!history_author_valid(author)) {
        fprintf(stderr, "alock: --author is required (1-32 bytes, no control characters)\n"); return 2;
    }
    RangeArgs args;
    if (parse_range_args(argc, argv, "write", &args) != 0) return 2;

    /* read content from stdin */
    size_t cap = 4096, len = 0;
    uint8_t *content = malloc(cap);
    ssize_t n;
    while ((n = read(STDIN_FILENO, content + len, cap - len)) > 0) {
        len += n;
        if (len == cap) { cap *= 2; content = realloc(content, cap); }
    }

    char sock_path[4096];
    ipc_socket_path(args.file, sock_path, sizeof(sock_path));

    if (daemon_author_capable(sock_path) <= 0) {
        fprintf(stderr, "alock: running daemon lacks author/nab support; let locks drain and allow 30 seconds idle before retrying\n"); free(content); return 1;
    }

    DtobValue *req = make_range_request("write", &args);
    dtob_kvset_put(req, "author", dtob_raw((const uint8_t *)author, strlen(author)));
    dtob_kvset_put(req, "content", dtob_raw(content, len));
    free(content);

    return finish_response(daemon_request(sock_path, req), 1);
}

static int cmd_check(int argc, char **argv) {
    const char *file  = arg_get(argc, argv, "--file");
    const char *agent = arg_get(argc, argv, "--agent");
    if (!file || !agent) {
        fprintf(stderr, "alock check: missing required args\n");
        return 2;
    }

    char resolved[4096];
    file = resolve_path(file, resolved, sizeof(resolved));

    char sock_path[4096];
    ipc_socket_path(file, sock_path, sizeof(sock_path));

    return finish_response(daemon_request(sock_path, make_request("check", file, agent)), 0);
}

static int cmd_release(int argc, char **argv) {
    const char *file  = arg_get(argc, argv, "--file");
    const char *agent = arg_get(argc, argv, "--agent");
    if (!file || !agent) {
        fprintf(stderr, "alock release: missing required args\n");
        return 2;
    }

    char resolved[4096];
    file = resolve_path(file, resolved, sizeof(resolved));

    char sock_path[4096];
    ipc_socket_path(file, sock_path, sizeof(sock_path));

    return finish_response(daemon_request(sock_path, make_request("release", file, agent)), 0);
}

static int cmd_release_agent(int argc, char **argv) {
    const char *agent = arg_get(argc, argv, "--agent");
    if (!agent) {
        fprintf(stderr, "alock release-agent: missing required arg\n");
        return 2;
    }

    char sock_path[4096];
    ipc_socket_path(NULL, sock_path, sizeof(sock_path));

    return finish_response(
        daemon_request(sock_path, make_request("release-agent", NULL, agent)), 0);
}

static int cmd_status(int argc, char **argv) {
    const char *file = arg_get(argc, argv, "--file");
    char resolved[4096];
    if (file)
        file = resolve_path(file, resolved, sizeof(resolved));

    char sock_path[4096];
    ipc_socket_path(file, sock_path, sizeof(sock_path));

    DtobValue *resp =
        daemon_request(sock_path, make_request("status", file, NULL));
    if (!resp) {
        fprintf(stderr, "no active locks\n");
        return 0;
    }

    print_status_json(resp);
    dtob_free(resp);
    return 0;
}



int main(int argc, char **argv) {
    if (argc < 2) { usage(); return 2; }
    if (!strcmp(argv[1], "history")) {
        const char *file = arg_get(argc, argv, "--file");
        if (!file) { fprintf(stderr, "usage: alock history --file PATH [--retry]\n"); return 2; }
        char resolved[4096];
        if (!resolve_path(file, resolved, sizeof(resolved))) return 2;
        return history_command(resolved, arg_has(argc, argv, "--retry"));
    }

    const char *cmd = argv[1];

    if (strcmp(cmd, "bridge") == 0)        return cmd_bridge(argc, argv);

    if (strcmp(cmd, "acquire") == 0)       return cmd_acquire(argc, argv);
    if (strcmp(cmd, "stage") == 0)         return cmd_stage(argc, argv);
    if (strcmp(cmd, "commit") == 0 || strcmp(cmd, "abort") == 0)
        return cmd_stage_finish(argc, argv, cmd);
    if (strcmp(cmd, "write") == 0)         return cmd_write(argc, argv);
    if (strcmp(cmd, "release") == 0)       return cmd_release(argc, argv);
    if (strcmp(cmd, "release-agent") == 0) return cmd_release_agent(argc, argv);
    if (strcmp(cmd, "check") == 0)         return cmd_check(argc, argv);
    if (strcmp(cmd, "status") == 0)        return cmd_status(argc, argv);

    usage();
    return 2;
}
