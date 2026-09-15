CC = gcc
CFLAGS = -Wall -Wextra -Werror -pedantic -std=c11 -O3 -D_POSIX_C_SOURCE=200809L -Isrc -Ilibdtob/lib

TARGET = nab

.PHONY: all clean

all: $(TARGET)

libdtob/libdtob.a:
	$(MAKE) -C libdtob

$(TARGET): src/nab.c src/nab.h src/util.c src/xbdiff.c src/cmd.c src/rebuild.c libdtob/libdtob.a
	$(CC) $(CFLAGS) -o $(TARGET) src/nab.c libdtob/libdtob.a

clean:
	rm -f $(TARGET)
