#define _POSIX_C_SOURCE 200809L
#include "turns.h"
#include "history.h"
#include <string.h>
#include <time.h>

#ifndef TURN_LEASE_SECONDS
#define TURN_LEASE_SECONDS 30
#endif
#define MAX_TURNS 128
#define MAX_MEMBERS 2048
static struct { char id[TURN_ID_SIZE]; double seen; } turns[MAX_TURNS];
static struct { int turn; char file[4096]; } members[MAX_MEMBERS];

static double clock_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static int find_turn(const char *id) {
    if (!id[0]) return -1;
    for (int i = 0; i < MAX_TURNS; i++) if (!strcmp(turns[i].id, id)) return i;
    return -1;
}

int turn_heartbeat(const char *id) {
    if (!id[0] || strlen(id) >= TURN_ID_SIZE || strspn(id, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_:") != strlen(id)) return -1;
    int index = find_turn(id);
    if (index < 0) for (int i = 0; i < MAX_TURNS; i++) if (!turns[i].id[0]) { index = i; break; }
    if (index < 0) return -1;
    strcpy(turns[index].id, id);
    turns[index].seen = clock_now();
    return 0;
}

int turn_prepare(const char *id, const char *file) {
    int index = find_turn(id), available = 0;
    if (id[0] && index < 0) return -1;
    if (strlen(file) >= sizeof(members[0].file)) return -1;
    for (int i = 0; i < MAX_MEMBERS; i++) {
        if (!members[i].file[0]) available = 1;
        else if (members[i].turn == index && !strcmp(members[i].file, file)) return 0;
    }
    if (id[0] && !available) return -1;
    /* Flush before admitting a different turn or an ordinary lock holder.
     * This also recovers snapshots left by a previous daemon incarnation. */
    return history_flush(file);
}

void turn_join(const char *id, const char *file) {
    int index = find_turn(id);
    if (index < 0) return;
    for (int i = 0; i < MAX_MEMBERS; i++)
        if (members[i].file[0] && members[i].turn == index && !strcmp(members[i].file, file)) return;
    for (int i = 0; i < MAX_MEMBERS; i++) if (!members[i].file[0]) {
        members[i].turn = index;
        strcpy(members[i].file, file);
        return;
    }
}

int turn_defer(const char *id, const char *file) {
    int index = find_turn(id), count = 0, own = 0;
    for (int i = 0; i < MAX_MEMBERS; i++) if (members[i].file[0] && !strcmp(members[i].file, file)) {
        count++;
        own |= members[i].turn == index;
    }
    return index >= 0 && own && count == 1;
}

int turn_end(const char *id) {
    int index = find_turn(id), failed = 0;
    if (index < 0) return 0;
    for (int i = 0; i < MAX_MEMBERS; i++) if (members[i].file[0] && members[i].turn == index) {
        if (history_flush(members[i].file)) failed = 1;
        else members[i].file[0] = 0;
    }
    /* Keep failed memberships for retry; another turn cannot bypass the flush. */
    if (!failed) turns[index].id[0] = 0;
    return failed ? -1 : 0;
}

void turn_expire(void (*release)(const char *)) {
    double now = clock_now();
    for (int i = 0; i < MAX_TURNS; i++) if (turns[i].id[0] && now - turns[i].seen > TURN_LEASE_SECONDS) {
        char id[TURN_ID_SIZE];
        strcpy(id, turns[i].id);
        release(id);
        if (turn_end(id)) turns[i].seen = now; /* Retry failed recording once per lease. */
    }
}

int turns_active(void) {
    for (int i = 0; i < MAX_TURNS; i++) if (turns[i].id[0]) return 1;
    return 0;
}
