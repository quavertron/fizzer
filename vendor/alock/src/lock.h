/*
 * lock.h — lock table: byte_start + length, offset arithmetic
 */
#ifndef LOCK_H
#define LOCK_H

#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <time.h>

#define MAX_LOCKS     256
#define DEFAULT_TTL   600   /* 10 minutes */

typedef struct {
    int      id;
    char     agent[128];
    char     display_agent[128];
    char     file[4096];
    off_t    byte_start;
    size_t   length;
    uint32_t line_start;    /* original lines (informational only) */
    uint32_t line_end;
    int      active;
    time_t   acquired_at;
    int      ttl_seconds;
} Lock;

typedef struct {
    Lock  entries[MAX_LOCKS];
    int   count;
    int   next_id;
    void (*on_release)(const Lock *);
} LockTable;

void locktable_init(LockTable *lt);

/* acquire a lock on a byte range. returns lock id or -1 on conflict. */
int lock_acquire(LockTable *lt, const char *agent, const char *file,
                 off_t byte_start, size_t length,
                 uint32_t line_start, uint32_t line_end);

/* release all locks an agent holds on a file */
int lock_release_agent(LockTable *lt, const char *agent, const char *file);

/* release all locks an agent holds across all files */
int lock_release_all_agent(LockTable *lt, const char *agent);


/* rule 4: after a write at edit_offset with delta bytes inserted/removed,
 * adjust byte_start for all locks on that file below the edit point. */
void lock_adjust(LockTable *lt, const char *file,
                 off_t edit_offset, ssize_t delta);

/* adjust line_start/line_end for all locks after a line-count change */
void lock_adjust_lines(LockTable *lt, const char *file,
                       uint32_t after_line, ssize_t delta);

/* rule 7: expire stale locks */
void lock_expire(LockTable *lt);

/* convert line range to byte range */
int lines_to_bytes(const char *file, uint32_t line_start, uint32_t line_end,
                   off_t *byte_start, size_t *length);

/* find lock by id */
Lock *lock_find(LockTable *lt, int lock_id);
void lock_release_id(LockTable *lt, int id);
Lock *lock_blocker(LockTable *lt, const char *agent, const char *file, off_t start, size_t length);

#endif /* LOCK_H */
