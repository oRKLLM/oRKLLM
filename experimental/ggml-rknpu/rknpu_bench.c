/* Steady-state NPU matmul throughput (weight pre-loaded) for LLM-shaped GEMV (decode)
 * vs GEMM (prefill), FP16, via rknn_matmul_api. */
#include "rknn_api.h"
#include "rknn_matmul_api.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
static double now_ms(){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6; }
static void bench(const char* tag,int M,int K,int N,int reps){
  rknn_matmul_ctx ctx=0; rknn_matmul_info info; memset(&info,0,sizeof info);
  info.M=M;info.K=K;info.N=N;info.type=RKNN_FLOAT16_MM_FLOAT16_TO_FLOAT32;
  rknn_matmul_io_attr io; memset(&io,0,sizeof io);
  if(rknn_matmul_create(&ctx,&info,&io)){printf("%s: create fail\n",tag);return;}
  rknn_tensor_mem*A=rknn_create_mem(ctx,io.A.size),*B=rknn_create_mem(ctx,io.B.size),*C=rknn_create_mem(ctx,io.C.size);
  memset(A->virt_addr,0,io.A.size); memset(B->virt_addr,0,io.B.size); // weight pre-loaded (B set once)
  rknn_matmul_set_io_mem(ctx,A,&io.A); rknn_matmul_set_io_mem(ctx,B,&io.B); rknn_matmul_set_io_mem(ctx,C,&io.C);
  rknn_matmul_run(ctx); // warmup
  double t0=now_ms(); for(int i=0;i<reps;i++) rknn_matmul_run(ctx); double dt=(now_ms()-t0)/reps;
  double gflop=2.0*M*K*N/1e9;
  printf("%-26s M=%-4d K=%-5d N=%-5d  %7.3f ms/call  %8.2f GFLOP/s\n",tag,M,K,N,dt,gflop/(dt/1e3));
  rknn_destroy_mem(ctx,A);rknn_destroy_mem(ctx,B);rknn_destroy_mem(ctx,C);rknn_matmul_destroy(ctx);
}
int main(){
  printf("=== RK3588 NPU steady-state matmul (FP16, weight pre-loaded) ===\n");
  bench("decode GEMV (attn/proj)",1,2048,2048,100);
  bench("decode GEMV (ffn up)",   1,2048,5504,100);
  bench("decode GEMV (lm_head)",  1,2048,32000,50);
  bench("prefill GEMM (m=256)",   256,2048,2048,50);
  bench("prefill GEMM (m=512)",   512,2048,2048,30);
  return 0;
}
