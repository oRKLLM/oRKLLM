/* rknpu_pcchain.c — single-submit large matmul for ARBITRARY M via M-tile PC-chaining.
 *
 * This is the general-M companion to rknpu_sched.c's decode path. librknnrt does large
 * matmul as S = ceil(M/R) M-tiles, each computing the FULL K in one op, the ops linked
 * by the PC-chain trailer at regcmd word 216: (reg 0x10, blk 0x0101)=next regcmd addr,
 * (reg 0x14)=0x37 (non-last)/0 (last). All S ops run in ONE RKNPU_SUBMIT; each writes
 * its own disjoint rows of C (no accumulation, so NO 0x2000 bit). Per-tile scheduler
 * regs (R rows/tile, base 0x1040) are a per-K CBUF-heuristic calibration (nonlinear, no
 * clean closed form) — table below, captured from librknnrt. Power-of-2 K only; other K
 * use the K-split hybrid (rknpu_hybrid.c).
 *
 * NOTE: this is a completeness/reference primitive and a foundation for future Rockchip
 * NPUs (more cores/bandwidth may favor it). On RK3588 it re-reads the full weights per
 * M-tile, so the K-split hybrid is faster for prefill — see the wiki.
 *   cc -O2 -I. -o rknpu_pcchain rknpu_pcchain.c && sudo ./rknpu_pcchain [M K N]
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
/* per-K CBUF calibration: rows/tile R and base 0x1040 (captured from librknnrt) */
static int caltab(int K,int*R,int*base){
    switch(K){case 512:*R=64;*base=0x84;return 1; case 1024:*R=48;*base=0x48;return 1;
              case 2048:*R=32;*base=0x2a;return 1; case 4096:*R=24;*base=0x48;return 1;
              case 8192:*R=8;*base=0x84;return 1;} return 0;
}
/* full-K regcmd for an R-row M-tile (no accumulation — disjoint C rows) */
static void synth(uint32_t*rc,int rows,int K,int N,uint32_t aA,uint32_t aB,uint32_t aC,int r1010,int r1040){
    memcpy(rc,REGCMD,REGCMD_N*4);
    setr(rc,REGCMD_N,0x201,0x1024,((K-1)<<16)|K);setr(rc,REGCMD_N,0x201,0x1030,K*N*2);setr(rc,REGCMD_N,0x201,0x1034,K*2);
    setr(rc,REGCMD_N,0x201,0x1044,K/32);setr(rc,REGCMD_N,0x201,0x1088,K);setr(rc,REGCMD_N,0x201,0x107c,K/8);
    setr(rc,REGCMD_N,0x201,0x1020,0x10000|rows);setr(rc,REGCMD_N,0x201,0x1084,0x10000|rows);setr(rc,REGCMD_N,0x201,0x102c,rows);
    setr(rc,REGCMD_N,0x1001,0x4034,rows-1);setr(rc,REGCMD_N,0x1001,0x405c,(rows-1)<<16);setr(rc,REGCMD_N,0x801,0x3014,(rows-1)<<16);
    setr(rc,REGCMD_N,0x1001,0x403c,((N-1)<<16)|(N-1));setr(rc,REGCMD_N,0x1001,0x4058,N-1);setr(rc,REGCMD_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1));
    setr(rc,REGCMD_N,0x201,0x1038,0x1010000|N);setr(rc,REGCMD_N,0x801,0x3018,N-1);
    setr(rc,REGCMD_N,0x201,0x1010,r1010);setr(rc,REGCMD_N,0x201,0x1040,r1040);
    setr(rc,REGCMD_N,0x201,0x1070,aA);setr(rc,REGCMD_N,0x201,0x1110,aB);setr(rc,REGCMD_N,0x1001,0x4020,aC);
}
static void chain(uint32_t*rc,uint32_t nextAddr){
    rc[216]=0x0010|((nextAddr&0xffff)<<16); rc[217]=(0x0101<<16)|((nextAddr>>16)&0xffff);
    setr(rc,REGCMD_N,0x0101,0x14,nextAddr?0x37:0x0);
}
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):128,K=argc>2?atoi(argv[2]):4096,N=argc>3?atoi(argv[3]):16;
    if(K%32||N%16){printf("need K%%32,N%%16\n");return 1;}
    int R,base; if(!caltab(K,&R,&base)){printf("K=%d not calibrated (power-of-2 512..8192); use the hybrid\n",K);return 1;}
    g_fd=open(CARD,O_RDWR);if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    int S=(M+R-1)/R, Mp=S*R, KT=K/32,NN=N/16;          /* S M-tiles, M padded to S*R rows */
    f16*blog=malloc((size_t)K*N*sizeof(f16)),*alog=calloc((size_t)Mp*K,sizeof(f16)); unsigned s=12345;
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(f16)(int)((s>>16)%4);}   /* rows>=M stay 0 */
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(f16)(int)((s>>16)%4);}
    /* one shared full-K weight buffer; one padded feature buffer; one padded output */
    struct buf B=bcreate((size_t)K*N*2,0x403); f16*bb=B.cpu;
    for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
        bb[nt*KT*16*32+kt*16*32+nl*32+kk]=blog[(size_t)(kt*32+kk)*N+(nt*16+nl)];
    struct buf A=bcreate((size_t)Mp*K*2,0x403); memcpy(A.cpu,alog,(size_t)Mp*K*2);
    struct buf C=bcreate((size_t)Mp*N*4,0x403);
    struct buf regs=bcreate((size_t)S*REGCMD_N*4,0x403);
    struct buf task=bcreate((size_t)S*sizeof(struct rknpu_task)+64,0x40b);
    struct rknpu_task*tk=task.cpu; memset(tk,0,S*sizeof(struct rknpu_task));
    for(int si=0;si<S;si++){
        uint32_t*rc=(uint32_t*)regs.cpu+si*REGCMD_N;
        synth(rc,R,K,N,(uint32_t)A.dma+si*R*K*2,(uint32_t)B.dma,(uint32_t)C.dma+si*R*N*4,16*R,base);
        chain(rc, si<S-1 ? (uint32_t)(regs.dma+(size_t)(si+1)*REGCMD_N*4) : 0);
        tk[si].enable_mask=0xd; tk[si].int_mask=0x300; tk[si].int_clear=0x1ffff;
        tk[si].regcfg_amount=108; tk[si].regcmd_addr=regs.dma+(size_t)si*REGCMD_N*4;
    }
    int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE;
    bsync(&B,both);bsync(&A,both);bsync(&C,both);bsync(&regs,both);bsync(&task,both);
    bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&A,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&regs,RKNPU_MEM_SYNC_TO_DEVICE);
    struct rknpu_submit sub;memset(&sub,0,sizeof sub);
    sub.flags=0x5;sub.timeout=6000;sub.task_start=0;sub.task_number=S;sub.task_counter=0;
    sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;
    sub.subcore_task[0]=(struct rknpu_subcore_task){0,S};
    if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
    bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE);
    float*cres=C.cpu; int bad=0;
    for(int m=0;m<M;m++)for(int n=0;n<N;n++){float ref=0;for(int k=0;k<K;k++)ref+=(float)alog[(size_t)m*K+k]*(float)blog[(size_t)k*N+n]; if(cres[(size_t)m*N+n]!=ref)bad++;}
    printf("PCCHAIN MKN=%d,%d,%d  R=%d S=%d M-tiles in ONE submit  mism=%d/%d : %s\n",
        M,K,N,R,S,bad,M*N,bad?"WRONG":"CORRECT");
    return bad?2:0;
}
