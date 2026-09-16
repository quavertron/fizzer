#ifndef ALOCK_EVENTS_H
#define ALOCK_EVENTS_H
#include <stdint.h>
/* Best-effort, editor-neutral notifications of accepted file changes. */
void events_change(const char *file, uint32_t start, uint32_t end,
                   const char *agent, const char *author);
#endif
