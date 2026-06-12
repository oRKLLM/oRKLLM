// Backend-level benchmark: per-call MUL_MAT time on RKNPU (cache miss vs hit) vs CPU.
// Weight q4_0 [K=2048,N=2048] (dequant is the prep the cache eliminates).
#include "ggml.h"
#include "ggml-cpu.h"
#include "ggml-backend.h"
#include "ggml-rknpu.h"
#include <stdio.h>
#include <vector>
#include <time.h>
static double now_ms(){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6; }
static void run(ggml_backend_t be, int M, const char* label){
  const int K=2048,N=2048;
  ggml_init_params p={ (size_t)64*1024*1024, NULL, true };
  ggml_context* ctx=ggml_init(p);
  ggml_tensor* a=ggml_new_tensor_2d(ctx,GGML_TYPE_Q4_0,K,N);  // weight
  ggml_tensor* b=ggml_new_tensor_2d(ctx,GGML_TYPE_F32,K,M);   // activations
  ggml_tensor* c=ggml_mul_mat(ctx,a,b);
  ggml_backend_buffer_t buf=ggml_backend_alloc_ctx_tensors(ctx, ggml_backend_cpu_init());
  std::vector<char> az(ggml_nbytes(a),0); ggml_backend_tensor_set(a,az.data(),0,az.size()); // valid q4_0 (zeros)
  std::vector<float> bz((size_t)K*M,1.0f); ggml_backend_tensor_set(b,bz.data(),0,bz.size()*4);
  ggml_cgraph* gf=ggml_new_graph(ctx); ggml_build_forward_expand(gf,c);
  double t1a=now_ms(); ggml_backend_graph_compute(be,gf); double call1=now_ms()-t1a;  // miss (incl dequant)
  int R=30; double t0=now_ms(); for(int i=0;i<R;i++) ggml_backend_graph_compute(be,gf); double avg=(now_ms()-t0)/R;
  printf("%-22s M=%-4d  call1=%7.3f ms  steady=%7.3f ms\n", label, M, call1, avg);
  ggml_free(ctx);
}
int main(){
  ggml_backend_t npu=ggml_backend_rknpu_init(), cpu=ggml_backend_cpu_init();
  printf("=== MUL_MAT q4_0 [2048x2048], per-call time ===\n");
  run(npu,1,  "NPU decode GEMV");
  run(cpu,1,  "CPU decode GEMV");
  run(npu,256,"NPU prefill GEMM");
  run(cpu,256,"CPU prefill GEMM");
  return 0;
}
