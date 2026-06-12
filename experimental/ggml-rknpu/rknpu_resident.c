/* rknpu_resident.c — M3.1: RESIDENT weights. Upload many weight matrices ONCE into
 * a single NPU arena, then run a matmul against each by patching the regcmd's weight
 * address to arena+offset — no per-weight rknn_matmul context, so no ~150-context wall.
 * Validates every result vs CPU. fp16, single-tile shape (M,K=32,N=16) for clarity.
 *   cc -O2 -I. -o rknpu_resident rknpu_resident.c && sudo ./rknpu_resident [NW]
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include "rknpu_ioctl.h"
#include "regcmd_array_4x32x16.h"   /* REGCMD[REGCMD_N] (fp16 4x32x16 template) */

#define CARD "/dev/dri/card1"
typedef _Float16 f16;
static int g_fd;
struct buf { uint32_t handle; uint64_t dma, obj; void *cpu; size_t size; };
static size_t pgup(size_t s){return (s+4095)&~((size_t)4095);}
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
    for(int k=0;k+1<n;k+=2)if((rc[k]&0xffff)==o&&(rc[k+1]>>16)==b){rc[k]=(o)|((v&0xffff)<<16);rc[k+1]=(b<<16)|((v>>16)&0xffff);return;}}

int main(int argc,char**argv){
    int NW = argc>1?atoi(argv[1]):256;   /* number of resident weight matrices (>150 wall) */
    int M=4,K=32,N=16;
    g_fd=open(CARD,O_RDWR); if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);

    size_t wbytes = (size_t)N*32*2;                 /* one weight matrix [N][32] fp16 */
    struct buf arena = bcreate(wbytes*NW, 0x403);   /* ALL weights resident in one buffer */
    struct buf A=bcreate(M*K*2,0x403), C=bcreate(M*N*4,0x403);
    struct buf regcmd=bcreate(4096,0x403), task=bcreate(4096,0x40b);

    /* fill + upload every weight matrix ONCE (transposed [N][32]); keep logical copy for ref */
    f16 *wlog = malloc((size_t)K*N*sizeof(f16)*NW);
    f16 *aw = arena.cpu;
    unsigned s=12345;
    for(int w=0; w<NW; w++){
        f16 *wl = wlog + (size_t)w*K*N;
        for(int i=0;i<K*N;i++){s=s*1103515245+12345; wl[i]=(f16)(int)((s>>16)%4);}
        f16 *dst = aw + (size_t)w*(N*32);
        for(int n=0;n<N;n++)for(int kk=0;kk<32;kk++) dst[n*32+kk]= (kk<K)? wl[kk*N+n] : (f16)0.0f;
    }
    bsync(&arena, RKNPU_MEM_SYNC_TO_DEVICE);        /* <-- weights uploaded ONCE */

    f16 *a=A.cpu; for(int i=0;i<M*K;i++){s=s*1103515245+12345; a[i]=(f16)(int)((s>>16)%4);}
    bsync(&A, RKNPU_MEM_SYNC_TO_DEVICE);

    /* base regcmd for this shape (fp16) */
    uint32_t base[REGCMD_N]; memcpy(base,REGCMD,sizeof base);
    setr(base,REGCMD_N,0x201,0x1024,((K-1)<<16)|K); setr(base,REGCMD_N,0x201,0x1030,K*N*2);
    setr(base,REGCMD_N,0x201,0x1034,K*2); setr(base,REGCMD_N,0x201,0x1044,K/32);
    setr(base,REGCMD_N,0x201,0x1088,K); setr(base,REGCMD_N,0x201,0x107c,K/8);
    setr(base,REGCMD_N,0x201,0x1020,0x10000|M); setr(base,REGCMD_N,0x201,0x1084,0x10000|M);
    setr(base,REGCMD_N,0x201,0x102c,M); setr(base,REGCMD_N,0x201,0x1010,16*(M+1));
    setr(base,REGCMD_N,0x1001,0x4034,M-1); setr(base,REGCMD_N,0x1001,0x405c,(M-1)<<16); setr(base,REGCMD_N,0x801,0x3014,(M-1)<<16);
    setr(base,REGCMD_N,0x1001,0x403c,((N-1)<<16)|(N-1)); setr(base,REGCMD_N,0x1001,0x4058,N-1);
    setr(base,REGCMD_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1)); setr(base,REGCMD_N,0x201,0x1038,0x1010000|N); setr(base,REGCMD_N,0x801,0x3018,N-1);
    setr(base,REGCMD_N,0x201,0x1070,(uint32_t)A.dma); setr(base,REGCMD_N,0x1001,0x4020,(uint32_t)C.dma);

    struct rknpu_task t; memset(&t,0,sizeof t); t.enable_mask=0xd;t.int_mask=0x300;t.int_clear=0x1ffff;t.regcfg_amount=108;t.regcmd_addr=regcmd.dma;
    memcpy(task.cpu,&t,sizeof t); bsync(&task, RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);

    /* warm-up submit (first NPU job after load has a cold-cache artifact) */
    { uint32_t rc[REGCMD_N]; memcpy(rc,base,sizeof rc);
      setr(rc,REGCMD_N,0x201,0x1110,(uint32_t)arena.dma); memcpy(regcmd.cpu,rc,sizeof rc);
      bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);
      struct rknpu_submit sub; memset(&sub,0,sizeof sub); sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
      ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub); bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE); }

    int ok=0;
    for(int w=0; w<NW; w++){
        uint32_t rc[REGCMD_N]; memcpy(rc,base,sizeof rc);
        setr(rc,REGCMD_N,0x201,0x1110,(uint32_t)(arena.dma + (size_t)w*wbytes));  /* weight by byte OFFSET */
        memcpy(regcmd.cpu,rc,sizeof rc);
        bsync(&regcmd, RKNPU_MEM_SYNC_TO_DEVICE);
        struct rknpu_submit sub; memset(&sub,0,sizeof sub); sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
        if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){fprintf(stderr,"submit %d failed\n",w);break;}
        bsync(&C, RKNPU_MEM_SYNC_FROM_DEVICE);
        float *c=C.cpu; f16 *wl=wlog+(size_t)w*K*N; int bad=0;
        for(int m=0;m<M;m++)for(int n=0;n<N;n++){float r=0;for(int k=0;k<K;k++)r+=(float)a[m*K+k]*(float)wl[k*N+n]; if(c[m*N+n]!=r){bad=1;}}
        if(!bad) ok++; else { fprintf(stderr,"weight %d WRONG\n",w); }
    }
    printf("RESIDENT: %d/%d matmuls correct against ONE arena of %d weights (uploaded once); ~150-ctx wall: BYPASSED\n", ok, NW, NW);
    return ok==NW?0:2;
}
