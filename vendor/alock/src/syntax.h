#ifndef ALOCK_SYNTAX_H
#define ALOCK_SYNTAX_H
#include <stddef.h>
/* 1: passes or no configured checker; 0: rejected; -1: checker/config I/O error. */
int syntax_check(const char *target, const void *content, size_t size);
#endif
