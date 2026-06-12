/* NPU matmul throughput across dtypes (timing only; weights pre-loaded) to see if
 * native INT quant changes the GEMV(decode)/GEMM(prefill) verdict. */
#include "rknn_api.h"
#include "rknn_matmul_api.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
static double now_ms(){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6; }
static void bench(const char* tag, rknn_matmul_type type, int M,int K,int N,int reps){
  rknn_matmul_ctx ctx=0; rknn_matmul_info info; memset(&info,0,sizeof info);
  info.M=M;info.K=K;info.N=N;info.type=type;
  rknn_matmul_io_attr io; memset(&io,0,sizeof io);
  if(rknn_matmul_create(&ctx,&info,&io)){printf("%-22s M=%-4d K=%-5d N=%-5d  create FAILED (type unsupported?)\n",tag,M,K,N);return;}
  rknn_tensor_mem*A=rknn_create_mem(ctx,io.A.size),*B=rknn_create_mem(ctx,io.B.size),*C=rknn_create_mem(ctx,io.C.size);
  memset(A->virt_addr,0,io.A.size); memset(B->virt_addr,0,io.B.size);
  rknn_matmul_set_io_mem(ctx,A,&io.A); rknn_matmul_set_io_mem(ctx,B,&io.B); rknn_matmul_set_io_mem(ctx,C,&io.C);
  rknn_matmul_run(ctx);
  double t0=now_ms(); for(int i=0;i<reps;i++) rknn_matmul_run(ctx); double dt=(now_ms()-t0)/reps;
  printf("%-22s M=%-4d K=%-5d N=%-5d  %7.3f ms  %8.2f GFLOP/s\n",tag,M,K,N,dt,(2.0*M*K*N/1e9)/(dt/1e3));
  rknn_destroy_mem(ctx,A);rknn_destroy_mem(ctx,B);rknn_destroy_mem(ctx,C);rknn_matmul_destroy(ctx);
}
int main(){
  printf("=== NPU matmul by dtype (decode GEMV vs prefill GEMM) ===\n");
  printf("-- decode GEMV (M=1, K=2048, N=2048) --\n");
  bench("fp16xfp16",  RKNN_FLOAT16_MM_FLOAT16_TO_FLOAT32, 1,2048,2048,100);
  bench("fp16xint8",  RKNN_FLOAT16_MM_INT8_TO_FLOAT32,    1,2048,2048,100);
  bench("fp16xint4",  RKNN_FLOAT16_MM_INT4_TO_FLOAT32,    1,2048,2048,100);
  bench("int8xint8",  RKNN_INT8_MM_INT8_TO_INT32,         1,2048,2048,100);
  printf("-- prefill GEMM (M=512, K=2048, N=2048) --\n");
  bench("fp16xfp16",  RKNN_FLOAT16_MM_FLOAT16_TO_FLOAT32, 512,2048,2048,30);
  bench("fp16xint8",  RKNN_FLOAT16_MM_INT8_TO_FLOAT32,    512,2048,2048,30);
  bench("fp16xint4",  RKNN_FLOAT16_MM_INT4_TO_FLOAT32,    512,2048,2048,30);
  bench("int8xint8",  RKNN_INT8_MM_INT8_TO_INT32,         512,2048,2048,30);
  return 0;
}
