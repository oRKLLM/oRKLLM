# ggml-backend-rknpu (experimental)

A from-scratch ggml compute backend for the **Rockchip RK3588 NPU**, driving the
NPU directly via its DRM kernel driver (`/dev/dri/renderD129`, `DRIVER=RKNPU`) —
no closed `librkllmrt.so`. Goal: run a current llama.cpp/ggml (with native
EAGLE-3 / multi-layer hidden states) on the NPU.

> **Status: early.** The device + memory layer is validated on hardware
> (`rknpu_probe`). Job submission and the matmul kernel are the next/hard parts.
> Full engineering log + feasibility analysis: oRKLLM wiki **ggml-backend-rknpu**.

## Files
- `rknpu_ioctl.h` — self-contained RKNPU DRM uapi (from Rockchip BSP `develop-6.1`,
  verified against kernel 6.1.115). No libdrm needed.
- `rknpu_probe.c` — validates the interface: open render node, `RKNPU_ACTION`
  queries, GEM buffer create→map→mmap→write→sync→destroy round-trip.

## Build & run (on an RK3588 board)
```sh
cc -O2 -o rknpu_probe rknpu_probe.c
./rknpu_probe          # run as a user in the 'render' group, or via sudo
```

## Regression tests
`test/regression.mjs` compiles every matmul kernel and runs it across a validated shape
matrix (fp16 + int8 GEMM, resident weights, single-submit decode, K-split hybrid),
asserting each self-validates against its CPU reference. Needs NPU hardware
(`/dev/dri/card1`) but not `librknnrt` — the synthesized kernels use raw DRM submission.
```sh
BOARD=user@host node test/regression.mjs        # full suite (33 cases)
BOARD=user@host node test/regression.mjs hybrid  # filter by kernel name
make regress BOARD=user@host                      # same, via Makefile
```
Runs serially with a settle delay (the NPU is single-stream) and a per-test wall timeout.
Shapes stay inside each kernel's proven regime: `sched*` cover decode (M=1) /
single-M-tile / K≤512 multi-tile; the hybrids cover arbitrary K incl. non-power-of-2.

## Why this is hard
The RK3588 NPU is a fixed-function NVDLA-derived INT8/FP16 **convolution**
accelerator. Matmul must be lowered to conv, and LLM *decode* is batch-1 GEMV
(far below the array's GEMM peak). See the wiki for the full feasibility verdict
and the two compute routes (`rknn_matmul_api` vs. raw regcmd).

## rknpu_matmul_test.c (Milestone 2)
Real FP16 matmul on the NPU via `rknn_matmul_api` (validated: `[4×32]×[32×16]` all-ones → 32). Needs `librknnrt.so` + `rknn_api.h`/`rknn_matmul_api.h` from
[airockchip/rknn-toolkit2](https://github.com/airockchip/rknn-toolkit2) `rknpu2/runtime/Linux/librknn_api/` (not committed here):
```sh
cc -O2 -I. -o mmtest rknpu_matmul_test.c -L. -lrknnrt
LD_LIBRARY_PATH=. ./mmtest
```
