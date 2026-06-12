// Sustained decode: run q4_0 [2048x2048] GEMV (M=1) continuously for ~6s on each
// backend; report per-1s-window throughput (exposes throttling/DVFS), not just burst.
#include "ggml.h"
#include "ggml-cpu.h"
#include "ggml-backend.h"
#include "ggml-rknpu.h"
#include "ggml-vulkan.h"
#include <stdio.h>
#include <vector>
#include <time.h>
#include <cstdlib>
static double now_ms(){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6; }
static void sustained(ggml_backend_t be, const char* label, double secs){
  if(!be){ printf("%-18s (backend null)\n",label); return; }
  const int K=2048,N=2048,M=1;
  ggml_init_params p={ (size_t)64*1024*1024, NULL, true }; ggml_context* ctx=ggml_init(p);
  ggml_tensor* a=ggml_new_tensor_2d(ctx,GGML_TYPE_Q4_0,K,N);
  ggml_tensor* b=ggml_new_tensor_2d(ctx,GGML_TYPE_F32,K,M);
  ggml_tensor* c=ggml_mul_mat(ctx,a,b);
  ggml_backend_buffer_t buf=ggml_backend_alloc_ctx_tensors(ctx, be);
  if(!buf){ printf("%-18s alloc failed\n",label); ggml_free(ctx); return; }
  std::vector<char> az(ggml_nbytes(a),0); ggml_backend_tensor_set(a,az.data(),0,az.size());
  std::vector<float> bz((size_t)K*M,1.0f); ggml_backend_tensor_set(b,bz.data(),0,bz.size()*4);
  ggml_cgraph* gf=ggml_new_graph(ctx); ggml_build_forward_expand(gf,c);
  ggml_backend_graph_compute(be,gf); ggml_backend_synchronize(be); // warmup
  printf("%-18s per-second iters/s: ", label); fflush(stdout);
  double t0=now_ms(), ws=t0; long witer=0, total=0; double first=0,last=0;
  while(now_ms()-t0 < secs*1000){
    ggml_backend_graph_compute(be,gf); ggml_backend_synchronize(be);
    witer++; total++;
    if(now_ms()-ws>=1000){ double r=witer/((now_ms()-ws)/1000.0); printf("%.0f ",r); fflush(stdout); if(first==0)first=r; last=r; witer=0; ws=now_ms(); }
  }
  double dt=(now_ms()-t0)/1000.0;
  printf("| avg %.0f it/s (%.3f ms/call) | throttle %.0f%%\n", total/dt, dt*1000/total, first>0?(1-last/first)*100:0);
  ggml_free(ctx);
}
int main(int argc,char**argv){
  ggml_backend_t cpu=ggml_backend_cpu_init(), npu=ggml_backend_rknpu_init(), vk=ggml_backend_vk_init(0);
  printf("=== sustained decode GEMV q4_0 [2048x2048], 6s each ===\n");
  double S=argc>1?atof(argv[1]):6; sustained(cpu,"CPU",S); sustained(npu,"NPU",S); sustained(vk,"GPU(Mali)",S);
  return 0;
}
