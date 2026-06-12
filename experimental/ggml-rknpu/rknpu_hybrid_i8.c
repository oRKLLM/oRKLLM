/* rknpu_hybrid_i8.c — M-tiling perf for ARBITRARY M/K/N (int8 / w8a8). Same two-level
 * tiling as the fp16 hybrid:
 *   1. split contraction K into <=1024 slices (the int8 scheduler-fast range — int8
 *      packs 2x rows/CBUF so R=65536/K is clean up to 1024), accumulate int32 partials;
 *   2. within each slice, M-tile into 4-tile pieces, each ONE single-submit scheduler
 *      call (NPU iterates 4 internal M-tiles), fresh feature/output buffer per piece.
 * int8 scheduler regs:  0x1010 = 16*min(mc+1, 65536/Kp);  0x1040 = the fp16 closed
 * form evaluated at effective K = Kp/2 (int8 contracts 2x per CBUF pass).
 * A[M,K] int8, B[K,N] int8 -> C[M,N] int32.  K%32==0, N%32==0.  Validated vs CPU.
 *   cc -O2 -I. -o rknpu_hybrid_i8 rknpu_hybrid_i8.c && sudo ./rknpu_hybrid_i8 [M K N]
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
#include "regcmd_i8.h"
#define CARD "/dev/dri/card1"
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
/* int8 regcmd for mc rows. sched=1 -> single-submit M-scheduler (clean Kp in
 * {512,1024}); sched=0 -> one internal M-tile (mc<=32768/Kp), proven for any Kp. */
static void synth(uint32_t*rc,int mc,int K,int N,uint32_t aA,uint32_t aB,uint32_t aC,int sched){
    memcpy(rc,REGCMD_I8,REGCMD_I8_N*4);
    setr(rc,REGCMD_I8_N,0x201,0x1024,((K-1)<<16)|K);setr(rc,REGCMD_I8_N,0x201,0x1030,K*N);setr(rc,REGCMD_I8_N,0x201,0x1034,K);
    setr(rc,REGCMD_I8_N,0x201,0x1044,(K+63)/64);setr(rc,REGCMD_I8_N,0x201,0x1088,K);setr(rc,REGCMD_I8_N,0x201,0x107c,K/16);
    setr(rc,REGCMD_I8_N,0x201,0x1020,0x10000|mc);setr(rc,REGCMD_I8_N,0x201,0x1084,0x10000|mc);setr(rc,REGCMD_I8_N,0x201,0x102c,mc);
    setr(rc,REGCMD_I8_N,0x1001,0x4034,mc-1);setr(rc,REGCMD_I8_N,0x1001,0x405c,(mc-1)<<16);setr(rc,REGCMD_I8_N,0x801,0x3014,(mc-1)<<16);
    setr(rc,REGCMD_I8_N,0x1001,0x403c,((N-1)<<16)|(N-1));setr(rc,REGCMD_I8_N,0x1001,0x4058,N-1);setr(rc,REGCMD_I8_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1));
    setr(rc,REGCMD_I8_N,0x201,0x1038,0x1010000|N);setr(rc,REGCMD_I8_N,0x801,0x3018,N-1);
    if(sched){
        int R=65536/K; if(R<1)R=1; int rows=(mc+1<R)?(mc+1):R; setr(rc,REGCMD_I8_N,0x201,0x1010,16*rows);
        int keff=K/2,kk=keff/256,lg=0; while(kk>1){kk>>=1;lg++;} int base=0xb1-15*((1<<lg)-1),slope=15*(1<<lg),mg=mc/64; if(mg<1)mg=1;
        int v=base-slope*(mg-1); if(v<0x1b)v=0x1b; setr(rc,REGCMD_I8_N,0x201,0x1040,v);
    } else { setr(rc,REGCMD_I8_N,0x201,0x1010,16*(mc+1)); }  /* single tile, template 0x1040 */
    setr(rc,REGCMD_I8_N,0x201,0x1070,aA);setr(rc,REGCMD_I8_N,0x201,0x1110,aB);setr(rc,REGCMD_I8_N,0x1001,0x4020,aC);
}
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):1024,K=argc>2?atoi(argv[2]):512,N=argc>3?atoi(argv[3]):32;
    if(K%32||N%32){printf("need K%%32,N%%32 (int8)\n");return 1;}
    g_fd=open(CARD,O_RDWR);if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    struct buf regcmd=bcreate(4096,0x403),task=bcreate(4096,0x40b);
    int8_t*blog=malloc((size_t)K*N),*alog=malloc((size_t)M*K); unsigned s=12345;
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(int8_t)((s>>16)%4);}
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(int8_t)((s>>16)%4);}
    struct rknpu_task t; memset(&t,0,sizeof t);t.enable_mask=0xd;t.int_mask=0x300;t.int_clear=0x1ffff;t.regcfg_amount=108;t.regcmd_addr=regcmd.dma;
    memcpy(task.cpu,&t,sizeof t); bsync(&task,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);
    int32_t*cres=calloc((size_t)M*N,sizeof(int32_t)); int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE; int nsub=0;
    int KS=1024;   /* int8 scheduler-fast slice (R=65536/K clean up to 1024) */
    for(int k0=0;k0<K;k0+=KS){
        int Kp=(K-k0<KS)?(K-k0):KS, KT=Kp/32,NN=N/32;
        struct buf B=bcreate((size_t)Kp*N,0x403); int8_t*bbuf=B.cpu;
        for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<32;nl++)for(int kk=0;kk<32;kk++)
            bbuf[nt*KT*32*32+kt*32*32+nl*32+kk]=blog[(size_t)(k0+kt*32+kk)*N+(nt*32+nl)];
        bsync(&B,both);bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);
        /* clean slice (512/1024) -> fast scheduler, 4 internal tiles/submit;
         * odd remainder slice -> proven per-M-tile path (one internal tile/submit). */
        int sched=(Kp==1024||Kp==512), R=65536/Kp; if(R<1)R=1; int chunk=sched?4*R:(32768/Kp); if(chunk<1)chunk=1;
        for(int pass=(k0?0:-1),nt2=(M+chunk-1)/chunk; pass<nt2; pass++){
            int m0=(pass<0)?0:pass*chunk, mc=(pass<0)?((M<chunk)?M:chunk):((M-m0<chunk)?(M-m0):chunk); if(mc<=0)continue;
            struct buf Ac=bcreate((size_t)mc*Kp,0x403),Cc=bcreate((size_t)mc*N*4,0x403);
            int8_t*ad=Ac.cpu; for(int r=0;r<mc;r++)for(int j=0;j<Kp;j++) ad[(size_t)r*Kp+j]=alog[(size_t)(m0+r)*K+k0+j];
            bsync(&Ac,both);bsync(&Cc,both);bsync(&Ac,RKNPU_MEM_SYNC_TO_DEVICE);
            uint32_t rc[REGCMD_I8_N]; synth(rc,mc,Kp,N,(uint32_t)Ac.dma,(uint32_t)B.dma,(uint32_t)Cc.dma,sched);
            memcpy(regcmd.cpu,rc,sizeof rc); bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);
            struct rknpu_submit sub;memset(&sub,0,sizeof sub);sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
            if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
            bsync(&Cc,RKNPU_MEM_SYNC_FROM_DEVICE);
            if(pass>=0){nsub++; int32_t*cc=Cc.cpu; for(int r=0;r<mc;r++)for(int n=0;n<N;n++) cres[(size_t)(m0+r)*N+n]+=cc[(size_t)r*N+n];}
        }
    }
    int bad=0; for(int m=0;m<M;m++)for(int n=0;n<N;n++){int32_t ref=0;for(int k=0;k<K;k++)ref+=(int)alog[(size_t)m*K+k]*(int)blog[(size_t)k*N+n]; if(cres[(size_t)m*N+n]!=ref)bad++;}
    printf("HYBRID-I8 MKN=%d,%d,%d  Kslices=%d submits=%d  mism=%d/%d : %s\n",
        M,K,N,(K+KS-1)/KS,nsub,bad,M*N,bad?"WRONG":"CORRECT");
    return bad?2:0;
}
