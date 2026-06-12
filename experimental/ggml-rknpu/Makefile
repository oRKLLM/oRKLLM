# Build the RKNPU probe (run on an RK3588 board).
CC ?= cc
CFLAGS ?= -O2 -Wall
rknpu_probe: rknpu_probe.c rknpu_ioctl.h
	$(CC) $(CFLAGS) -o $@ rknpu_probe.c
clean:
	rm -f rknpu_probe

# Regression suite: compiles every matmul kernel on the NPU board and runs it across a
# validated shape matrix (fp16 + int8, GEMM / resident / single-submit / K-split hybrid).
# Requires NPU hardware. Override the board with BOARD=user@host, filter with K=<name>.
regress:
	BOARD=$(BOARD) node test/regression.mjs $(K)

.PHONY: clean regress
