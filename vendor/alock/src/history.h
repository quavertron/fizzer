#ifndef ALOCK_HISTORY_H
#define ALOCK_HISTORY_H
#include <stddef.h>

int history_enabled(char *error, size_t size);
int history_author_valid(const char *author);
int history_command(const char *file, int retry);
int history_flush(const char *file);
void history_recover(void);
int history_record_turn(const char *turn, int defer, const char *file, const char *author, const char *operation,
                   const void *before, size_t before_size, const void *after, size_t after_size,
                   char *error, size_t error_size);
int history_record(const char *file, const char *author, const char *operation,
                   const void *before, size_t before_size, const void *after, size_t after_size,
                   char *error, size_t error_size);
int history_record_account(const char *file, const char *author, const char *operation,
                   const void *before, size_t before_size, const void *after, size_t after_size,
                   char *error, size_t error_size);
int alock_nab_main(int argc, char **argv);
void alock_nab_key(const char *file, char out[65]);
/* Revision identity hashes the bytes, independently of the file's path. */
void alock_content_hash(const void *content, size_t size, char out[65]);
#endif
