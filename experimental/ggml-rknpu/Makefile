# Build the RKNPU probe (run on an RK3588 board).
CC ?= cc
CFLAGS ?= -O2 -Wall
rknpu_probe: rknpu_probe.c rknpu_ioctl.h
	$(CC) $(CFLAGS) -o $@ rknpu_probe.c
clean:
	rm -f rknpu_probe
.PHONY: clean
