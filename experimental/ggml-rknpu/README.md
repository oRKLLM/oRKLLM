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

## Why this is hard
The RK3588 NPU is a fixed-function NVDLA-derived INT8/FP16 **convolution**
accelerator. Matmul must be lowered to conv, and LLM *decode* is batch-1 GEMV
(far below the array's GEMM peak). See the wiki for the full feasibility verdict
and the two compute routes (`rknn_matmul_api` vs. raw regcmd).
