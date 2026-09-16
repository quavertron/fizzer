#ifndef BRIDGE_H
#define BRIDGE_H
#include <sys/types.h>

int cmd_bridge(int argc, char **argv);
/* Shared by the CLI and the compiled test harness; policy is enforced by CLI. */
int bridge_serve(const char *root, const char *socket_path, uid_t peer);
int bridge_serve_turn(const char *root, const char *socket_path, uid_t peer, int batching);
#endif
