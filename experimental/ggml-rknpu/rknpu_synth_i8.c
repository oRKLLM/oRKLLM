/* rknpu_synth_i8.c — M2.3: synthesize an int8 (w8a8) matmul regcmd from scratch.
 * A[M,K] int8, B[K,N] int8 -> C[M,N] int32. Reuses the M2.2 approach with the int8
 * template (precision registers baked in) + element-size-1 strides. Validates vs CPU.
 *   cc -O2 -I. -o rknpu_synth_i8 rknpu_synth_i8.c && sudo ./rknpu_synth_i8 [M K N]
 * Constraints: K%32==0, N%32==0 (int8). */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include "rknpu_ioctl.h"
#include "regcmd_i8.h"   /* REGCMD_I8[REGCMD_I8_N] */

#define CARD "/dev/dri/card1"
static int g_fd;
struct buf { uint32_t handle; uint64_t dma, obj; void *cpu; size_t size; };
static size_t pgup(size_t s){ return (s+4095)&~((size_t)4095); }
static struct buf bcreate(size_t size,uint32_t flags){
    struct rknpu_mem_create c; memset(&c,0,sizeof c); c.size=pgup(size); c.flags=flags; c.core_mask=RKNPU_CORE0_MASK;
    if(ioctl(g_fd,DRM_IOCTL_RKNPU_MEM_CREATE,&c)){perror("CREATE");_exit(1);}
    struct rknpu_mem_map m; memset(&m,0,sizeof m); m.handle=c.handle;
    if(ioctl(g_fd,DRM_IOCTL_RKNPU_MEM_MAP,&m)){perror("MAP");_exit(1);}
    void*p=mmap(NULL,c.size,PROT_READ|PROT_WRITE,MAP_SHARED,g_fd,m.offset);
    if(p==MAP_FAILED){perror("mmap");_exit(1);}
    return (struct buf){c.handle,c.dma_addr,c.obj_addr,p,c.size};
}
static void bsync(struct buf*b,uint32_t f){struct rknpu_mem_sync s;memset(&s,0,sizeof s);s.obj_addr=b->obj;s.size=b->size;s.flags=f;ioctl(g_fd,DRM_IOCTL_RKNPU_MEM_SYNC,&s);}
static void act(uint32_t f,uint32_t v){struct rknpu_action a={.flags=f,.value=v};ioctl(g_fd,DRM_IOCTL_RKNPU_ACTION,&a);}
static void setr(uint32_t*rc,int n,uint32_t b,uint32_t o,uint32_t v){
    for(int k=0;k+1<n;k+=2)if((rc[k]&0xffff)==o&&(rc[k+1]>>16)==b){rc[k]=(o)|((v&0xffff)<<16);rc[k+1]=(b<<16)|((v>>16)&0xffff);return;}
    fprintf(stderr,"WARN reg %x:%x absent\n",b,o);
}
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):4,K=argc>2?atoi(argv[2]):32,N=argc>3?atoi(argv[3]):32;
    if(K%32||N%32){printf("need K%%32, N%%32 for int8\n");return 1;}
    g_fd=open(CARD,O_RDWR); if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    struct buf regcmd=bcreate(4096,0x403),task=bcreate(4096,0x40b);
    struct buf A=bcreate(M*K,0x403),B=bcreate(K*N,0x403),scratch=bcreate(K*N,0x403),C=bcreate(M*N*4,0x403); (void)scratch;
    /* data: small ints exact */
    int8_t *a=A.cpu,*bbuf=B.cpu; int32_t *href=malloc(M*N*4);
    int8_t *alog=malloc(M*K),*blog=malloc(K*N);
    unsigned s=12345;
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(int8_t)((s>>16)%4);}
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(int8_t)((s>>16)%4);}
    int KT=K/32,NT=N/32;
    for(int m=0;m<M;m++)for(int k=0;k<K;k++)a[m*K+k]=alog[m*K+k];          /* feature flat [M][K] */
    /* int8 weights: [Ntile][Ktile][32][32] (N tiles by 32, K tiles by 32) */
    for(int nt=0;nt<NT;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<32;nl++)for(int kk=0;kk<32;kk++)
        bbuf[nt*KT*32*32 + kt*32*32 + nl*32 + kk]=blog[(kt*32+kk)*N + (nt*32+nl)];
    for(int m=0;m<M;m++)for(int n=0;n<N;n++){int32_t acc=0;for(int k=0;k<K;k++)acc+=(int)alog[m*K+k]*(int)blog[k*N+n];href[m*N+n]=acc;}
    /* synth regcmd: int8 template + dim fields (element-size 1 for strides) */
    uint32_t rc[REGCMD_I8_N]; memcpy(rc,REGCMD_I8,sizeof rc);
    setr(rc,REGCMD_I8_N,0x201,0x1024,((K-1)<<16)|K);
    setr(rc,REGCMD_I8_N,0x201,0x1030,K*N);      /* int8: *1 */
    setr(rc,REGCMD_I8_N,0x201,0x1034,K);        /* int8: *1 */
    setr(rc,REGCMD_I8_N,0x201,0x1044,(K+63)/64);  /* int8: 64 K-channels/pass → ceil(K/64) */
    setr(rc,REGCMD_I8_N,0x201,0x1088,K);
    setr(rc,REGCMD_I8_N,0x201,0x107c,K/16);     /* int8: /16 */
    setr(rc,REGCMD_I8_N,0x201,0x1020,0x10000|M);setr(rc,REGCMD_I8_N,0x201,0x1084,0x10000|M);
    setr(rc,REGCMD_I8_N,0x201,0x102c,M);setr(rc,REGCMD_I8_N,0x201,0x1010,16*(M+1));
    setr(rc,REGCMD_I8_N,0x1001,0x4034,M-1);setr(rc,REGCMD_I8_N,0x1001,0x405c,(M-1)<<16);setr(rc,REGCMD_I8_N,0x801,0x3014,(M-1)<<16);
    setr(rc,REGCMD_I8_N,0x1001,0x403c,((N-1)<<16)|(N-1));setr(rc,REGCMD_I8_N,0x1001,0x4058,N-1);
    setr(rc,REGCMD_I8_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1));setr(rc,REGCMD_I8_N,0x201,0x1038,0x1010000|N);setr(rc,REGCMD_I8_N,0x801,0x3018,N-1);
    setr(rc,REGCMD_I8_N,0x201,0x1070,(uint32_t)A.dma);setr(rc,REGCMD_I8_N,0x201,0x1110,(uint32_t)B.dma);setr(rc,REGCMD_I8_N,0x1001,0x4020,(uint32_t)C.dma);
    memcpy(regcmd.cpu,rc,sizeof rc);
    struct rknpu_task t; memset(&t,0,sizeof t); t.enable_mask=0xd;t.int_mask=0x300;t.int_clear=0x1ffff;t.regcfg_amount=108;t.regcmd_addr=regcmd.dma;
    memcpy(task.cpu,&t,sizeof t);
    int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE;
    bsync(&regcmd,both);bsync(&task,both);bsync(&A,both);bsync(&B,both);bsync(&C,both);
    bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&A,RKNPU_MEM_SYNC_TO_DEVICE);
    struct rknpu_submit sub; memset(&sub,0,sizeof sub); sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
    if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
    bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE);
    int32_t *c=C.cpu; int bad=0,maxe=0;
    for(int i=0;i<M*N;i++){int e=c[i]-href[i];if(e<0)e=-e;if(e>maxe)maxe=e;if(e)bad++;}
    printf("INT8 MKN=%d,%d,%d C[0]=%d ref[0]=%d maxerr=%d mism=%d/%d : %s\n",M,K,N,c[0],href[0],maxe,bad,M*N,bad?"WRONG":"CORRECT");
    return bad?2:0;
}
