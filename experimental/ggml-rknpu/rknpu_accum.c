/* rknpu_hybrid.c — M-tiling perf for ARBITRARY M/K/N (fp16). Two-level tiling:
 *   1. split contraction K into <=2048 slices (the scheduler-fast range), accumulate;
 *   2. within each slice, M-tile into 4-tile pieces, each ONE single-submit scheduler
 *      call (NPU iterates 4 internal M-tiles). Clean power-of-2 Kp use the scheduler;
 *      odd remainder slices (768/1536/...) fall back to the proven per-M-tile path,
 *      so K is truly arbitrary (e.g. 11008, 5120). Avoids the PC_DATA RE.
 * BUFFER POOL: one feature+output buffer pair allocated once and reused (no per-tile
 *   mmap churn). POOL=1 is correct AND fastest — the NPU caches feature state by
 *   address across sequential submits, so rotating buffers (POOL>1) CORRUPTS results.
 * Validated vs CPU for arbitrary M/K/N incl 512x8192x512, 384x11008, 256x14336.
 *   cc -O2 -I. -o rknpu_hybrid rknpu_hybrid.c && sudo ./rknpu_hybrid [M K N]
 */
/* rknpu_accum.c — tested whether reg 0x1040's 0x2000 bit accumulates K-slices into
 * one C across SEPARATE submits. It does NOT (result = last slice only): the 0x2000
 * bit is a multi-M-tile scheduler flag, not a DRAM accumulate. Kept as the negative
 * result. Correct large-K accumulation is done in software (rknpu_hybrid.c K-split)
 * or by single-op-full-K for M<=R (rknpu_sched.c). NOTE: this file's own single-slice
 * path also showed C needs a per-submit MEM_SYNC_FROM_DEVICE to read back coherently.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <time.h>
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
/* OR bits into an existing reg's value (read-modify) */
static void orr(uint32_t*rc,int n,uint32_t b,uint32_t o,uint32_t bits){for(int k=0;k+1<n;k+=2)if((rc[k]&0xffff)==o&&(rc[k+1]>>16)==b){uint32_t v=(((rc[k+1]&0xffff)<<16)|(rc[k]>>16))|bits;rc[k]=(o)|((v&0xffff)<<16);rc[k+1]=(b<<16)|((v>>16)&0xffff);return;}}
/* regcmd for mc rows. sched=1 -> single-submit M-scheduler (clean power-of-2 Kp,
 * NPU iterates internal M-tiles); sched=0 -> one internal M-tile (mc<=16384/Kp),
 * proven for ANY Kp (the non-power-of-2 remainder slices go anomalous otherwise). */
static void synth(uint32_t*rc,int mc,int K,int N,uint32_t aA,uint32_t aB,uint32_t aC,int sched,int acc){
    memcpy(rc,REGCMD,REGCMD_N*4);
    setr(rc,REGCMD_N,0x201,0x1024,((K-1)<<16)|K);setr(rc,REGCMD_N,0x201,0x1030,K*N*2);setr(rc,REGCMD_N,0x201,0x1034,K*2);
    setr(rc,REGCMD_N,0x201,0x1044,K/32);setr(rc,REGCMD_N,0x201,0x1088,K);setr(rc,REGCMD_N,0x201,0x107c,K/8);
    setr(rc,REGCMD_N,0x201,0x1020,0x10000|mc);setr(rc,REGCMD_N,0x201,0x1084,0x10000|mc);setr(rc,REGCMD_N,0x201,0x102c,mc);
    setr(rc,REGCMD_N,0x1001,0x4034,mc-1);setr(rc,REGCMD_N,0x1001,0x405c,(mc-1)<<16);setr(rc,REGCMD_N,0x801,0x3014,(mc-1)<<16);
    setr(rc,REGCMD_N,0x1001,0x403c,((N-1)<<16)|(N-1));setr(rc,REGCMD_N,0x1001,0x4058,N-1);setr(rc,REGCMD_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1));
    setr(rc,REGCMD_N,0x201,0x1038,0x1010000|N);setr(rc,REGCMD_N,0x801,0x3018,N-1);
    if(sched){
        int R=32768/K; if(R<1)R=1; int rows=(mc+1<R)?(mc+1):R; setr(rc,REGCMD_N,0x201,0x1010,16*rows);
        int kk=K/256,lg=0; while(kk>1){kk>>=1;lg++;} int base=0xb1-15*((1<<lg)-1),slope=15*(1<<lg),mg=mc/64; if(mg<1)mg=1;
        int v=base-slope*(mg-1); if(v<0x1b)v=0x1b; setr(rc,REGCMD_N,0x201,0x1040,v);
    } else { setr(rc,REGCMD_N,0x201,0x1010,16*(mc+1)); }  /* single tile, template 0x1040 */
    if(acc) orr(rc,REGCMD_N,0x201,0x1040,0x2000);  /* HW accumulate into existing C (0x2000 bit) */
    setr(rc,REGCMD_N,0x201,0x1070,aA);setr(rc,REGCMD_N,0x201,0x1110,aB);setr(rc,REGCMD_N,0x1001,0x4020,aC);
}
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):1024,K=argc>2?atoi(argv[2]):512,N=argc>3?atoi(argv[3]):16;
    if(K%32||N%16){printf("need K%%32,N%%16\n");return 1;}
    g_fd=open(CARD,O_RDWR);if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    struct buf regcmd=bcreate(4096,0x403),task=bcreate(4096,0x40b);
    f16*blog=malloc((size_t)K*N*sizeof(f16)),*alog=malloc((size_t)M*K*sizeof(f16)); unsigned s=12345;
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(f16)(int)((s>>16)%4);}
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(f16)(int)((s>>16)%4);}
    struct rknpu_task t; memset(&t,0,sizeof t);t.enable_mask=0xd;t.int_mask=0x300;t.int_clear=0x1ffff;t.regcfg_amount=108;t.regcmd_addr=regcmd.dma;
    memcpy(task.cpu,&t,sizeof t); bsync(&task,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);
    int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE; int nsub=0;
    int KS=2048;
    /* HARDWARE ACCUMULATION: all K-slices write the SAME output C; the first slice for
     * each M-region overwrites (acc off), later slices set the 0x2000 bit in reg 0x1040
     * so the NPU adds into C in DRAM. No software partial accumulation, ONE output
     * buffer for the whole result. Single reused feature buffer (NPU caches feat by addr). */
    struct buf Af=bcreate((size_t)4*32768*2,0x403);      /* reused feature buffer */
    struct buf C=bcreate((size_t)M*N*4,0x403);           /* full result, HW-accumulated */
    bsync(&C,both);
    struct timespec ts0,ts1; clock_gettime(CLOCK_MONOTONIC,&ts0);
    for(int k0=0;k0<K;k0+=KS){
        int Kp=(K-k0<KS)?(K-k0):KS, KT=Kp/32,NN=N/16;
        struct buf B=bcreate((size_t)Kp*N*2,0x403); f16*bbuf=B.cpu;
        for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
            bbuf[nt*KT*16*32+kt*16*32+nl*32+kk]=blog[(size_t)(k0+kt*32+kk)*N+(nt*16+nl)];
        bsync(&B,both);bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);
        int sched=((Kp&(Kp-1))==0), R=32768/Kp; if(R<1)R=1; int chunk=sched?4*R:(16384/Kp); if(chunk<1)chunk=1;
        int acc=(k0>0);   /* first K-slice overwrites C; later slices accumulate in HW */
        for(int m0=0;m0<M;m0+=chunk){
            int mc=(M-m0<chunk)?(M-m0):chunk; if(mc<=0)continue;
            f16*ad=Af.cpu; for(int r=0;r<mc;r++)for(int j=0;j<Kp;j++) ad[(size_t)r*Kp+j]=alog[(size_t)(m0+r)*K+k0+j];
            bsync(&Af,RKNPU_MEM_SYNC_TO_DEVICE);
            uint32_t rc[REGCMD_N]; synth(rc,mc,Kp,N,(uint32_t)Af.dma,(uint32_t)B.dma,(uint32_t)C.dma+m0*N*4,sched,acc);
            memcpy(regcmd.cpu,rc,sizeof rc); bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);
            struct rknpu_submit sub;memset(&sub,0,sizeof sub);sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
            if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
            bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE);
            nsub++;
        }
    }
    bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE);
    clock_gettime(CLOCK_MONOTONIC,&ts1);
    double ms=(ts1.tv_sec-ts0.tv_sec)*1e3+(ts1.tv_nsec-ts0.tv_nsec)/1e6;
    float*cres=C.cpu;
    int bad=0; for(int m=0;m<M;m++)for(int n=0;n<N;n++){float ref=0;for(int k=0;k<K;k++)ref+=(float)alog[(size_t)m*K+k]*(float)blog[(size_t)k*N+n]; if(cres[(size_t)m*N+n]!=ref)bad++;}
    printf("ACCUM MKN=%d,%d,%d  Kslices=%d submits=%d  %.1fms (%.2fms/sub)  mism=%d/%d : %s\n",
        M,K,N,(K+KS-1)/KS,nsub,ms,ms/(nsub?nsub:1),bad,M*N,bad?"WRONG":"CORRECT");
    return bad?2:0;
}
