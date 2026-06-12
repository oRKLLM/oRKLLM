/* rknpu_mm_param.c — parametric matmul (argv: M K N) for M1.3 register-dictionary
 * sweeps. A[M,K]=1, B[K,N]=1 (fp16) -> C[M,N] == K.  Run under rknpu_dump.so to
 * capture the regcmd per shape, then diff across shapes to localize M/K/N fields. */
#include "rknn_api.h"
#include "rknn_matmul_api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  int M = argc>1?atoi(argv[1]):4;
  int K = argc>2?atoi(argv[2]):32;
  int N = argc>3?atoi(argv[3]):16;
  rknn_matmul_ctx ctx=0;
  rknn_matmul_info info; memset(&info,0,sizeof info);
  info.M=M; info.K=K; info.N=N;
  info.type=RKNN_FLOAT16_MM_FLOAT16_TO_FLOAT32;
  rknn_matmul_io_attr io; memset(&io,0,sizeof io);
  int ret=rknn_matmul_create(&ctx,&info,&io);
  if(ret){printf("create failed: %d\n",ret);return 1;}
  printf("MKN=%d,%d,%d io A=%u B=%u C=%u\n", M,K,N, io.A.size,io.B.size,io.C.size);
  rknn_tensor_mem *A=rknn_create_mem(ctx,io.A.size);
  rknn_tensor_mem *B=rknn_create_mem(ctx,io.B.size);
  rknn_tensor_mem *C=rknn_create_mem(ctx,io.C.size);
  __fp16 *a=(__fp16*)A->virt_addr,*b=(__fp16*)B->virt_addr;
  for(int i=0;i<M*K;i++) a[i]=(__fp16)1.0f;
  for(int i=0;i<K*N;i++) b[i]=(__fp16)1.0f;
  if(rknn_matmul_set_io_mem(ctx,A,&io.A)||rknn_matmul_set_io_mem(ctx,B,&io.B)||rknn_matmul_set_io_mem(ctx,C,&io.C)){printf("set_io failed\n");return 1;}
  ret=rknn_matmul_run(ctx);
  if(ret){printf("run failed: %d\n",ret);return 1;}
  float *c=(float*)C->virt_addr;
  int ok=1; for(int i=0;i<M*N;i++) if(c[i]<K-0.5f||c[i]>K+0.5f){ok=0;break;}
  printf("C[0]=%.1f expect %d : %s\n", c[0], K, ok?"CORRECT":"WRONG");
  rknn_destroy_mem(ctx,A);rknn_destroy_mem(ctx,B);rknn_destroy_mem(ctx,C);
  rknn_matmul_destroy(ctx);
  return ok?0:2;
}
