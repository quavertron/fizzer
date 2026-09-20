#ifndef ALOCK_ACCOUNT_IO_H
#define ALOCK_ACCOUNT_IO_H
#include "lock.h"
#include <stddef.h>
#include <stdint.h>
typedef struct { uint64_t start, length; uint32_t line_start, line_end; } AccountRange;
unsigned char *account_read(const char *path, size_t *size, unsigned *mode, int *exists);
int account_publish(const char *path, const void *bytes, size_t size, unsigned mode, int exists);
int account_lock(LockTable *lt, const char *agent, const char *path, AccountRange *range);
int account_lock_get(LockTable *lt, int id, AccountRange *range);
void account_unlock(LockTable *lt, int id);
void account_adjust(LockTable *lt, int id, const char *path, size_t size, int64_t lines);
int account_random(unsigned char *bytes, size_t size);
#endif
