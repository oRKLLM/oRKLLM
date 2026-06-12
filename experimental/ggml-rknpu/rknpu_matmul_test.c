/* rknpu_matmul_test.c — validate real NPU matmul via rknn_matmul_api.
 * A[M,K]=1.0, B[K,N]=1.0 (fp16) -> C[M,N] should all equal K. */
#include "rknn_api.h"
#include "rknn_matmul_api.h"
#include <stdio.h>
#include <string.h>

int main(void) {
  int M=4, K=32, N=16;                 /* RK3588 fp16: K%32, N%16 */
  rknn_matmul_ctx ctx=0;
  rknn_matmul_info info; memset(&info,0,sizeof info);
  info.M=M; info.K=K; info.N=N;
  info.type=RKNN_FLOAT16_MM_FLOAT16_TO_FLOAT32;
  info.B_layout=0; info.B_quant_type=0; info.AC_layout=0; info.AC_quant_type=0;
  rknn_matmul_io_attr io; memset(&io,0,sizeof io);
  int ret=rknn_matmul_create(&ctx,&info,&io);
  if(ret){printf("rknn_matmul_create failed: %d\n",ret);return 1;}
  printf("created. io sizes A=%u B=%u C=%u\n", io.A.size, io.B.size, io.C.size);
  rknn_tensor_mem *A=rknn_create_mem(ctx,io.A.size);
  rknn_tensor_mem *B=rknn_create_mem(ctx,io.B.size);
  rknn_tensor_mem *C=rknn_create_mem(ctx,io.C.size);
  __fp16 *a=(__fp16*)A->virt_addr, *b=(__fp16*)B->virt_addr;
  for(int i=0;i<M*K;i++) a[i]=(__fp16)1.0f;
  for(int i=0;i<K*N;i++) b[i]=(__fp16)1.0f;
  if(rknn_matmul_set_io_mem(ctx,A,&io.A)||rknn_matmul_set_io_mem(ctx,B,&io.B)||rknn_matmul_set_io_mem(ctx,C,&io.C)){printf("set_io_mem failed\n");return 1;}
  ret=rknn_matmul_run(ctx);
  if(ret){printf("rknn_matmul_run failed: %d\n",ret);return 1;}
  float *c=(float*)C->virt_addr;
  printf("C[0..4] = %.1f %.1f %.1f %.1f   (expect %d)\n", c[0],c[1],c[2],c[3], K);
  int ok=1; for(int i=0;i<M*N;i++) if(c[i]<K-0.5f||c[i]>K+0.5f){ok=0;break;}
  printf("NPU matmul result: %s\n", ok?"CORRECT":"WRONG");
  rknn_destroy_mem(ctx,A);rknn_destroy_mem(ctx,B);rknn_destroy_mem(ctx,C);
  rknn_matmul_destroy(ctx);
  return ok?0:2;
}
