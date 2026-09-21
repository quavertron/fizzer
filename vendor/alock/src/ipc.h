#ifndef IPC_H
#define IPC_H

#include <signal.h>
#include <stddef.h>
#include <stdint.h>

#ifndef ALOCK_SOCK_DIR
#define ALOCK_SOCK_DIR "/tmp/alock"
#endif
#define ALOCK_SOCK_PATH ALOCK_SOCK_DIR "/daemon.sock"

void     ipc_socket_path(const char *file, char *out, size_t outsz);
int      ipc_listen(const char *path);
int      ipc_connect(const char *path);
int      ipc_send(int fd, const uint8_t *data, size_t len);
uint8_t *ipc_recv(int fd, size_t *out_len);
/* Deadline-bounded read/write loop, shared with the bridge. `until` is an
 * absolute ipc_now_ms() stamp; a non-NULL `abort` breaks the loop early on
 * shutdown. Handles both socket and plain file descriptors. */
long long ipc_now_ms(void);
int      ipc_transfer(int fd, void *data, size_t size, int writing,
                      long long until, volatile sig_atomic_t *abort);
void     ipc_cleanup(const char *path);

#endif
