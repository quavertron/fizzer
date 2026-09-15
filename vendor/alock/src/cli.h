#ifndef ALOCK_CLI_H
#define ALOCK_CLI_H
#include <stddef.h>
const char *resolve_path(const char *path, char *resolved, size_t size);
const char *arg_get(int argc, char **argv, const char *flag);
int arg_has(int argc, char **argv, const char *flag);
void json_escape(const char *src, char *dst, size_t dstsz);
#endif
