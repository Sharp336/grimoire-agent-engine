CC ?= gcc
CFLAGS := -Wall -O2

all: build clean

build:
	$(CC) $(CFLAGS) -o app main.c

clean:
	rm -f app

.PHONY: all build clean
