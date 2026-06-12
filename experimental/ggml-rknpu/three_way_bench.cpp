// CPU vs RKNPU vs Mali-GPU(Vulkan): q4_0 [2048x2048] decode GEMV + prefill GEMM.
#include "ggml.h"
#include "ggml-cpu.h"
#include "ggml-backend.h"
#include "ggml-rknpu.h"
#include "ggml-vulkan.h"
#include <stdio.h>
#include <vector>
#include <time.h>
static double now_ms(){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6; }
static void run(ggml_backend_t be, int M, const char* label){
  const int K=2048,N=2048;
  ggml_init_params p={ (size_t)64*1024*1024, NULL, true }; ggml_context* ctx=ggml_init(p);
  ggml_tensor* a=ggml_new_tensor_2d(ctx,GGML_TYPE_Q4_0,K,N);
  ggml_tensor* b=ggml_new_tensor_2d(ctx,GGML_TYPE_F32,K,M);
  ggml_tensor* c=ggml_mul_mat(ctx,a,b);
  ggml_backend_buffer_t buf=ggml_backend_alloc_ctx_tensors(ctx, be);   // alloc in THIS backend
  if(!buf){ printf("%-26s alloc failed\n",label); ggml_free(ctx); return; }
  std::vector<char> az(ggml_nbytes(a),0); ggml_backend_tensor_set(a,az.data(),0,az.size());
  std::vector<float> bz((size_t)K*M,1.0f); ggml_backend_tensor_set(b,bz.data(),0,bz.size()*4);
  ggml_cgraph* gf=ggml_new_graph(ctx); ggml_build_forward_expand(gf,c);
  if(ggml_backend_graph_compute(be,gf)!=GGML_STATUS_SUCCESS){ printf("%-26s compute failed\n",label); ggml_free(ctx); return; }
  ggml_backend_synchronize(be);
  int R=30; double t0=now_ms(); for(int i=0;i<R;i++){ ggml_backend_graph_compute(be,gf); } ggml_backend_synchronize(be); double avg=(now_ms()-t0)/R;
  printf("%-26s M=%-4d  steady=%8.3f ms\n", label, M, avg);
  ggml_free(ctx);
}
int main(){
  ggml_backend_t cpu=ggml_backend_cpu_init();
  ggml_backend_t npu=ggml_backend_rknpu_init();
  ggml_backend_t vk =ggml_backend_vk_init(0);
  printf("=== q4_0 [2048x2048] steady-state per-call ===\n");
  printf("-- decode GEMV (M=1) --\n");
  run(cpu,1,"CPU"); run(npu,1,"NPU"); if(vk) run(vk,1,"GPU(Vulkan/Mali)"); else printf("GPU: vk init failed\n");
  printf("-- prefill GEMM (M=256) --\n");
  run(cpu,256,"CPU"); run(npu,256,"NPU"); if(vk) run(vk,256,"GPU(Vulkan/Mali)");
  return 0;
}
