/* rknpu_hybrid.c — M-tiling perf for ANY M (K<=1024): software-chunk M into
 * 4-tile pieces, each a single-submit scheduler call (fresh feature/output buffer
 * per chunk). ~4x fewer submits than per-tile software tiling. fp16.
 *   cc -O2 -I. -o rknpu_hybrid rknpu_hybrid.c && sudo ./rknpu_hybrid [M K N]
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
#include "regcmd_array_4x32x16.h"
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
static void setr(uint32_t*rc,int n,uint32_t b,uint32_t o,uint32_t v){int f=0;for(int k=0;k+1<n;k+=2)if((rc[k]&0xffff)==o&&(rc[k+1]>>16)==b){rc[k]=(o)|((v&0xffff)<<16);rc[k+1]=(b<<16)|((v>>16)&0xffff);f=1;}if(!f)fprintf(stderr,"WARN %x:%x\n",b,o);}
/* scheduler regcmd for mc rows (mc may span multiple internal M-tiles) */
static void synth(uint32_t*rc,int mc,int K,int N,uint32_t aA,uint32_t aB,uint32_t aC){
    memcpy(rc,REGCMD,REGCMD_N*4);
    setr(rc,REGCMD_N,0x201,0x1024,((K-1)<<16)|K);setr(rc,REGCMD_N,0x201,0x1030,K*N*2);setr(rc,REGCMD_N,0x201,0x1034,K*2);
    setr(rc,REGCMD_N,0x201,0x1044,K/32);setr(rc,REGCMD_N,0x201,0x1088,K);setr(rc,REGCMD_N,0x201,0x107c,K/8);
    setr(rc,REGCMD_N,0x201,0x1020,0x10000|mc);setr(rc,REGCMD_N,0x201,0x1084,0x10000|mc);setr(rc,REGCMD_N,0x201,0x102c,mc);
    setr(rc,REGCMD_N,0x1001,0x4034,mc-1);setr(rc,REGCMD_N,0x1001,0x405c,(mc-1)<<16);setr(rc,REGCMD_N,0x801,0x3014,(mc-1)<<16);
    setr(rc,REGCMD_N,0x1001,0x403c,((N-1)<<16)|(N-1));setr(rc,REGCMD_N,0x1001,0x4058,N-1);setr(rc,REGCMD_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1));
    setr(rc,REGCMD_N,0x201,0x1038,0x1010000|N);setr(rc,REGCMD_N,0x801,0x3018,N-1);
    int R=32768/K; if(R<1)R=1; int rows=(mc+1<R)?(mc+1):R; setr(rc,REGCMD_N,0x201,0x1010,16*rows);
    int kk=K/256,lg=0; while(kk>1){kk>>=1;lg++;} int base=0xb1-15*((1<<lg)-1),slope=15*(1<<lg),mg=mc/64; if(mg<1)mg=1;
    int v=base-slope*(mg-1); if(v<0x1b)v=0x1b; setr(rc,REGCMD_N,0x201,0x1040,v);
    setr(rc,REGCMD_N,0x201,0x1070,aA);setr(rc,REGCMD_N,0x201,0x1110,aB);setr(rc,REGCMD_N,0x1001,0x4020,aC);
}
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):1024,K=argc>2?atoi(argv[2]):512,N=argc>3?atoi(argv[3]):16;
    if(K%32||N%16){printf("need K%%32,N%%16\n");return 1;}
    g_fd=open(CARD,O_RDWR);if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    int KT=K/32,NN=N/16;
    struct buf B=bcreate((size_t)K*N*2,0x403),regcmd=bcreate(4096,0x403),task=bcreate(4096,0x40b);
    f16*bbuf=B.cpu,*blog=malloc((size_t)K*N*sizeof(f16)),*alog=malloc((size_t)M*K*sizeof(f16)); unsigned s=12345;
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(f16)(int)((s>>16)%4);}
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(f16)(int)((s>>16)%4);}
    for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
        bbuf[nt*KT*16*32+kt*16*32+nl*32+kk]=blog[(kt*32+kk)*N+(nt*16+nl)];
    bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);
    struct rknpu_task t; memset(&t,0,sizeof t);t.enable_mask=0xd;t.int_mask=0x300;t.int_clear=0x1ffff;t.regcfg_amount=108;t.regcmd_addr=regcmd.dma;
    memcpy(task.cpu,&t,sizeof t); bsync(&task,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);
    int R=32768/K; if(R<1)R=1; int chunk=4*R;                /* 4 scheduler tiles per submit */
    float*cres=malloc((size_t)M*N*sizeof(float)); int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE; int nsub=0;
    for(int pass=-1,nt=(M+chunk-1)/chunk; pass<nt; pass++){
        int m0=(pass<0)?0:pass*chunk, mc=(pass<0)?((M<chunk)?M:chunk):((M-m0<chunk)?(M-m0):chunk); if(mc<=0)continue;
        struct buf Ac=bcreate((size_t)mc*K*2,0x403),Cc=bcreate((size_t)mc*N*4,0x403);
        memcpy(Ac.cpu, alog+(size_t)m0*K, (size_t)mc*K*sizeof(f16));
        bsync(&Ac,both);bsync(&Cc,both);bsync(&Ac,RKNPU_MEM_SYNC_TO_DEVICE);
        uint32_t rc[REGCMD_N]; synth(rc,mc,K,N,(uint32_t)Ac.dma,(uint32_t)B.dma,(uint32_t)Cc.dma);
        memcpy(regcmd.cpu,rc,sizeof rc); bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);
        struct rknpu_submit sub;memset(&sub,0,sizeof sub);sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
        if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
        bsync(&Cc,RKNPU_MEM_SYNC_FROM_DEVICE);
        if(pass>=0){nsub++; memcpy(cres+(size_t)m0*N, Cc.cpu, (size_t)mc*N*sizeof(float));}
    }
    int bad=0; for(int m=0;m<M;m++)for(int n=0;n<N;n++){float ref=0;for(int k=0;k<K;k++)ref+=(float)alog[(size_t)m*K+k]*(float)blog[(size_t)k*N+n]; if(cres[(size_t)m*N+n]!=ref)bad++;}
    printf("HYBRID MKN=%d,%d,%d  submits=%d (chunk=%d rows=4 tiles)  mism=%d/%d : %s\n",
        M,K,N,nsub,chunk,bad,M*N,bad?"WRONG":"CORRECT");
    return bad?2:0;
}
