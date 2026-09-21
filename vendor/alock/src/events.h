#ifndef ALOCK_EVENTS_H
#define ALOCK_EVENTS_H
#include <stdint.h>
#include <stddef.h>
void activity_client(int fd, const uint8_t *data, size_t size);
int activity_poll(void);
void activity_edit(const char *file, const char *agent, const char *author, uint32_t start, uint32_t end,
    const void *before, size_t before_size, const void *after, size_t after_size);
void activity_lock(const char *file, const char *agent, uint32_t start, uint32_t end,
    const char *result, const char *blocker, const char *detail);
/* Best-effort, editor-neutral notifications of accepted file changes. */
void activity_release(const char *file, const char *agent, const char *author, uint32_t start, uint32_t end);
void events_change(const char *file, uint32_t start, uint32_t end,
                   const char *agent, const char *author);
#endif
