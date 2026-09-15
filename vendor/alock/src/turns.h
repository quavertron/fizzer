#ifndef ALOCK_TURNS_H
#define ALOCK_TURNS_H
#include <stddef.h>
#define TURN_ID_SIZE 96
int turn_heartbeat(const char *id);
int turn_prepare(const char *id, const char *file);
void turn_join(const char *id, const char *file);
int turn_defer(const char *id, const char *file);
int turn_end(const char *id);
void turn_expire(void (*release)(const char *));
int turns_active(void);
#endif
