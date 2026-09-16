#ifndef DAEMON_H
#define DAEMON_H

#include <stddef.h>

int daemon_spawn(const char *file, char *sock_path, size_t pathsz);
int daemon_author_capable(const char *sock_path);
int daemon_turn_capable(const char *sock_path);

#endif
