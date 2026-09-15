CC      = gcc
# Using -I $(PREFIX)/include ensures the compiler sees your newly installed headers immediately
PREFIX  = $(HOME)/.local
CFLAGS  = -O3 -march=native -flto -DNDEBUG -Wall -Wextra -Werror -pedantic -std=c11 \
          -D_POSIX_C_SOURCE=200809L -I lib -I src -I $(PREFIX)/include -I/opt/homebrew/include
LDFLAGS = -L/opt/homebrew/lib -lgmp
AR      = ar

SRCS    = src/trit.c src/lexer.c src/ast.c src/parser.c src/serialize.c src/extra.c
OBJS    = $(SRCS:.c=.o)
DEPS    = $(SRCS:.c=.d)

.PHONY: all clean install uninstall

# Just typing 'make' now builds and installs everything to ~/.local
all: install

libdtob.a: $(OBJS)
	@$(AR) rcs $@ $(OBJS)

src/%.o: src/%.c
	@$(CC) $(CFLAGS) -MMD -MP -c -o $@ $<

-include $(DEPS)

install: libdtob.a
	@mkdir -p $(PREFIX)/lib
	@mkdir -p $(PREFIX)/include/dtob
	@mkdir -p $(PREFIX)/lib/pkgconfig
	@cp libdtob.a $(PREFIX)/lib/
	@cp lib/dtob.h lib/dtob_types.h $(PREFIX)/include/dtob/
	@if [ -f dtob.pc.in ]; then \
		sed 's|@PREFIX@|$(PREFIX)|g' dtob.pc.in > $(PREFIX)/lib/pkgconfig/dtob.pc; \
	fi
	@rm -f $(DEPS)

uninstall:
	rm -f $(PREFIX)/lib/libdtob.a
	rm -rf $(PREFIX)/include/dtob
	rm -f $(PREFIX)/lib/pkgconfig/dtob.pc

clean:
	@rm -f src/*.o src/*.d libdtob.a
