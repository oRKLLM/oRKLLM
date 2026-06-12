// Exercise ggml_backend_rknpu's MUL_MAT on the NPU and check numerics vs expected.
// a(f16)[K,N]=1, b(f32)[K,M]=1 -> c[N,M] should all equal K.
#include "ggml.h"
#include "ggml-cpu.h"
#include "ggml-backend.h"
#include "ggml-rknpu.h"
#include <stdio.h>
#include <vector>
#include <cmath>

int main(void) {
    const int K=32, N=16, M=4;   // matches v0 supports_op: f16 weight, K%32, N%16, 2D
    ggml_backend_t npu = ggml_backend_rknpu_init();
    ggml_backend_t cpu = ggml_backend_cpu_init();
    if (!npu) { printf("rknpu_init failed\n"); return 1; }

    ggml_init_params p = { /*mem*/ 16*1024*1024, NULL, /*no_alloc*/ true };
    ggml_context * ctx = ggml_init(p);
    ggml_tensor * a = ggml_new_tensor_2d(ctx, GGML_TYPE_F16, K, N); // src0 (weight)
    ggml_tensor * b = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, K, M); // src1 (activations)
    ggml_tensor * c = ggml_mul_mat(ctx, a, b);                       // [N, M]

    ggml_backend_buffer_t buf = ggml_backend_alloc_ctx_tensors(ctx, cpu); // host buffers
    (void)buf;
    std::vector<ggml_fp16_t> av(K*N);
    for (auto & x : av) x = ggml_fp32_to_fp16(1.0f);
    std::vector<float> bv(K*M, 1.0f);
    ggml_backend_tensor_set(a, av.data(), 0, av.size()*sizeof(ggml_fp16_t));
    ggml_backend_tensor_set(b, bv.data(), 0, bv.size()*sizeof(float));

    ggml_cgraph * gf = ggml_new_graph(ctx);
    ggml_build_forward_expand(gf, c);

    printf("rknpu supports this MUL_MAT? %d\n",
           ggml_backend_dev_supports_op(ggml_backend_get_device(npu), c));
    enum ggml_status st = ggml_backend_graph_compute(npu, gf); // run on NPU
    printf("graph_compute status = %d\n", st);

    std::vector<float> out(N*M);
    ggml_backend_tensor_get(c, out.data(), 0, out.size()*sizeof(float));
    int ok=1; for (auto v : out) if (std::fabs(v - (float)K) > 0.5f) { ok=0; break; }
    printf("c[0..4] = %.1f %.1f %.1f %.1f  (expect %d)\n", out[0],out[1],out[2],out[3], K);
    printf("NPU MUL_MAT in ggml: %s\n", ok ? "CORRECT" : "WRONG");
    ggml_free(ctx);
    return ok?0:2;
}
