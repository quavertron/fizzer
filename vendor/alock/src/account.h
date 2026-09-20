#ifndef ALOCK_ACCOUNT_H
#define ALOCK_ACCOUNT_H
#include "lock.h"
#include <dtob.h>
/* Separate-account state machine. Native editor staging keeps its own lifecycle. */
DtobValue *account_request(DtobValue *request, LockTable *locks);
void account_expire(LockTable *locks);
int account_active(void);
int account_cli(int argc, char **argv);
#endif
