/* Exercise the production server under our test UID without a runtime bypass
 * in `alock bridge serve`. Root/account provisioning is not needed for tests. */
#include "bridge.h"
#include "ipc.h"
#include "daemon.h"
#include <dtob.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include "account_io.h"
#include "cli.h"

extern DtobValue *account_daemon(DtobValue *request);
extern unsigned char *account_load(const char *path, size_t *size);

static DtobValue *account_input(int argc, char **argv) {
    DtobValue *req = dtob_kvset();
    dtob_kvset_put(req, "cmd", dtob_raw((uint8_t *)"account", 7));
    const char *keys[] = {"operation", "session", "file", "author", "sha256", "ticket"};
    for (size_t i=0; i<sizeof(keys)/sizeof(keys[0]); i++) {
        char flag[64]; snprintf(flag,sizeof(flag),"--%s",keys[i]);
        const char *value=arg_get(argc,argv,flag);
        if (value) dtob_kvset_put(req, keys[i],dtob_raw((const uint8_t *)value,strlen(value)));
    }
    const char *numbers[] = {"line_start", "line_end", "persistent_seconds", "remote"};
    for (size_t i=0; i<sizeof(numbers)/sizeof(numbers[0]); i++) {
        char flag[64]; snprintf(flag,sizeof(flag),"--%s",numbers[i]);
        const char *value=arg_get(argc,argv,flag);
        if (value) dtob_kvset_put(req,numbers[i],dtob_uint(strtoull(value,NULL,10)));
    }
    const char *replacement=arg_get(argc,argv,"--replacement");
    if (replacement) {
        size_t size; uint8_t *data=account_load(replacement,&size);
        if (!data) { dtob_free(req); return NULL; }
        dtob_kvset_put(req,"replacement",dtob_raw(data,size)); free(data);
    }
    return req;
}
static int account_output(DtobValue *reply) {
    if (!reply) return 1;
    printf("{\"ok\":%llu,\"status\":%llu,\"start\":%llu,\"length\":%llu",
        (unsigned long long)dtob_kvset_uint(reply,"ok"),(unsigned long long)dtob_kvset_uint(reply,"status"),
        (unsigned long long)dtob_kvset_uint(reply,"start"),(unsigned long long)dtob_kvset_uint(reply,"length"));
    const char *keys[]={"ticket","sha256","error","pending","historyError"};
    for(size_t i=0;i<sizeof(keys)/sizeof(keys[0]);i++) {
        char value[4096],escaped[8192]; dtob_kvset_str(reply,keys[i],value,sizeof(value));
        json_escape(value,escaped,sizeof(escaped)); printf(",\"%s\":\"%s\"",keys[i],escaped);
    }
    printf("}\n");
    size_t size; const uint8_t *content=dtob_kvset_raw(reply,"content",&size);
    if(content) fwrite(content,1,size,stdout);
    dtob_free(reply); return 0;
}

int main(int argc, char **argv) {
    if (argc > 2 && (!strcmp(argv[1], "--account") || !strcmp(argv[1], "--encode-account"))) {
        DtobValue *req=account_input(argc,argv);
        if(!req) return 1;
        if(!strcmp(argv[1],"--encode-account")) {
            size_t size; uint8_t *data=dtob_encode(req,&size); dtob_free(req);
            if(!data) return 1;
            fwrite(data,1,size,stdout); free(data); return 0;
        }
        DtobValue *reply=account_daemon(req); dtob_free(req); return account_output(reply);
    }
    if(argc==3 && !strcmp(argv[1],"--decode-account")) {
        size_t size; uint8_t *data=account_load(argv[2],&size);
        DtobValue *reply=data?dtob_decode(data,size):NULL; free(data); return account_output(reply);
    }
    if (argc == 2 && !strcmp(argv[1], "--daemon-pid")) {
        char sock[4096];
        if (daemon_spawn("", sock, sizeof(sock))) return 1;
        int fd = ipc_connect(sock);
        if (fd < 0) return 1;
        DtobValue *request = dtob_kvset();
        dtob_kvset_put(request, "cmd", dtob_raw((uint8_t *)"capabilities", 12));
        size_t size;
        uint8_t *bytes = dtob_encode(request, &size);
        dtob_free(request);
        int failed = !bytes || ipc_send(fd, bytes, size);
        free(bytes);
        bytes = failed ? NULL : ipc_recv(fd, &size);
        close(fd);
        DtobValue *reply = bytes ? dtob_decode(bytes, size) : NULL;
        free(bytes);
        if (!reply) return 1;
        printf("%llu\n", (unsigned long long)dtob_kvset_uint(reply, "pid"));
        dtob_free(reply);
        return 0;
    }
    if (argc == 2 && !strcmp(argv[1], "--decode-event")) {
        size_t size;
        uint8_t *data = ipc_recv(STDIN_FILENO, &size);
        DtobValue *event = data ? dtob_decode(data, size) : NULL;
        free(data);
        if (!event) return 1;
        char agent[128], author[128];
        dtob_kvset_str(event, "agent", agent, sizeof(agent));
        dtob_kvset_str(event, "author", author, sizeof(author));
        printf("%s\n%s\n", agent, author);
        dtob_free(event);
        return 0;
    }
    if (argc != 4 && argc != 5) return 2;
    return bridge_serve_turn(argv[1], argv[2], (uid_t)strtoul(argv[3], NULL, 10), argc == 5);
}
