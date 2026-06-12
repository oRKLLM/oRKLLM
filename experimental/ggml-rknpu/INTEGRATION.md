# Integrating ggml-rknpu into llama.cpp / ggml

The backend is a CPU-assist backend (like ggml-blas): host buffers, claims only
`GGML_OP_MUL_MAT`, offloads it to the RK3588 NPU via `rknn_matmul_api`.

Drop-in steps (against a current llama.cpp checkout):
1. `cp ggml-rknpu.h        ggml/include/`
2. `mkdir ggml/src/ggml-rknpu && cp ggml-rknpu.cpp ggml/src/ggml-rknpu/`
   plus `rknn_api.h`, `rknn_matmul_api.h`, `librknnrt.so` from
   [airockchip/rknn-toolkit2](https://github.com/airockchip/rknn-toolkit2)
   (`rknpu2/runtime/Linux/librknn_api/`).
3. `ggml/src/ggml-rknpu/CMakeLists.txt`:
   ```cmake
   ggml_add_backend_library(ggml-rknpu ggml-rknpu.cpp)
   target_include_directories(ggml-rknpu PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
   target_link_libraries(ggml-rknpu PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/librknnrt.so)
   ```
4. Wire the build:
   - `ggml/CMakeLists.txt`: `option(GGML_RKNPU "ggml: use RKNPU" OFF)`
   - `ggml/src/CMakeLists.txt`: `ggml_add_backend(RKNPU)`
   - `ggml/src/ggml-backend-reg.cpp`: `#ifdef GGML_USE_RKNPU #include "ggml-rknpu.h" #endif`
     and `#ifdef GGML_USE_RKNPU register_backend(ggml_backend_rknpu_reg()); #endif`
5. Configure: `cmake -B build -DGGML_RKNPU=ON ...`
6. Validate: `./build/bin/test-backend-ops -b RKNPU -o MUL_MAT`

## v0 scope / TODO
- v0 supports: 2D MUL_MAT, FP16 weights (src0) × F32 activations (src1) → F32,
  contiguous, `K%32==0 && N%16==0` (RK3588 fp16 alignment). Everything else stays
  on CPU via `supports_op`.
- TODO: padding (arbitrary K/N), FP16×INT4 weight-quant + native relayout (LLM
  case), batched (ne2/ne3), persistent rknn ctx + cached relayout'd weights,
  GEMV-vs-GEMM benchmark (the practicality question). See wiki ggml-backend-rknpu.
