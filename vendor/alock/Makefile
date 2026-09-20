CC      = cc
CFLAGS  = -std=c11 -D_DEFAULT_SOURCE -D_POSIX_C_SOURCE=200809L -Wall -Wextra -O2 -Isrc -Ilibdtob/lib
OBJDIR  = obj
BIN     ?= alock

SRC = src/main.c src/events.c src/lock.c src/daemon.c src/ipc.c src/bridge.c src/history.c src/turns.c src/nab_embed.c src/account_io.c src/syntax.c
OBJ = $(patsubst src/%.c,$(OBJDIR)/%.o,$(SRC))

.PHONY: all clean

all: $(BIN)
	rm -rf $(OBJDIR)

$(OBJDIR):
	mkdir -p $(OBJDIR)

$(OBJDIR)/%.o: src/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) -c -o $@ $<

$(OBJDIR)/nab_embed.o: nab/src/nab.c nab/src/cmd.c nab/src/util.c nab/src/xbdiff.c nab/src/rebuild.c nab/src/nab.h

libdtob/libdtob.a:
	$(MAKE) -C libdtob libdtob.a

control/target/release/libalock_control.a: control/src/lib.rs control/src/transport.rs control/Cargo.toml control/Cargo.lock
	cargo build --locked --release --manifest-path control/Cargo.toml

$(BIN): $(OBJ) control/target/release/libalock_control.a libdtob/libdtob.a
	$(CC) -o $@ $^ -lpthread -ldl -lm

clean:
	rm -rf $(OBJDIR) $(BIN)
