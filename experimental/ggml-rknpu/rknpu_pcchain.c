/* rknpu_pcchain.c — PC-chaining investigation (the "PC_DATA single-pass").
 *
 * FINDING: there is NO PC_DATA K-accumulation buffer. PC-chaining DOES work — one
 * RKNPU_SUBMIT runs S chained regcmd blocks linked by the trailer at word 216:
 * (reg 0x10, block 0x0101)=next regcmd addr, (reg 0x14)=0x37 (non-last)/0 (last).
 * This is what my old rknpu_mt.c was missing (it listed tasks but never set the
 * chain pointer, so the sequencer never advanced -> timeout). Pointing 0x101:0x10
 * at anything but the next regcmd -> timeout (proves it's the chain pointer).
 *
 * BUT the 0x2000 bit in reg 0x1040 does NOT accumulate across K here: a complete
 * regcmd diff of librknnrt's two chained ops (K=4096) shows they differ only in
 * 0x1070 (feature +sliceA) and 0x4020 (output +sliceC) with IDENTICAL weights —
 * i.e. they are M-TILES each doing the FULL K in one op, not K-slices accumulating.
 * 0x2000 is a "subsequent M-tile" scheduler flag. Diagnostic here confirmed it:
 * C ended = slice1 only (op1 overwrote, did not add). The real large-K single-pass
 * is therefore single-op-per-M-tile (see rknpu_sched.c: M<=R does full K in ONE
 * submit; decode M=1 does ANY K in one submit). Kept as the chaining reference.
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
static void orr(uint32_t*rc,int n,uint32_t b,uint32_t o,uint32_t bits){for(int k=0;k+1<n;k+=2)if((rc[k]&0xffff)==o&&(rc[k+1]>>16)==b){uint32_t v=(((rc[k+1]&0xffff)<<16)|(rc[k]>>16))|bits;rc[k]=(o)|((v&0xffff)<<16);rc[k+1]=(b<<16)|((v>>16)&0xffff);return;}}
/* sched regcmd for mc rows; acc -> add into existing C (0x2000 in 0x1040) */
static void synth(uint32_t*rc,int mc,int K,int N,uint32_t aA,uint32_t aB,uint32_t aC,int acc){
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
    if(acc) orr(rc,REGCMD_N,0x201,0x1040,0x2000);
    setr(rc,REGCMD_N,0x201,0x1070,aA);setr(rc,REGCMD_N,0x201,0x1110,aB);setr(rc,REGCMD_N,0x1001,0x4020,aC);
}
/* PC_DATA scratch trailer: 0x101:0x10 = partial-sum scratch addr, 0x14 = amount.
 * The cross-op accumulator lives here so chained ops can sum partials. */
static void chain(uint32_t*rc,uint32_t pcdata,uint32_t amount){
    rc[216]=0x0010|((pcdata&0xffff)<<16); rc[217]=(0x0101<<16)|((pcdata>>16)&0xffff);
    setr(rc,REGCMD_N,0x0101,0x14,amount);
}
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):1,K=argc>2?atoi(argv[2]):4096,N=argc>3?atoi(argv[3]):16;
    if(K%32||N%16){printf("need K%%32,N%%16\n");return 1;}
    g_fd=open(CARD,O_RDWR);if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    f16*blog=malloc((size_t)K*N*sizeof(f16)),*alog=malloc((size_t)M*K*sizeof(f16)); unsigned s=12345;
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(f16)(int)((s>>16)%4);}
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(f16)(int)((s>>16)%4);}
    int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE;
    int KS=2048, S=(K+KS-1)/KS;                /* K-slices, all expected clean power-of-2 */
    int R=32768/(KS<K?KS:K); if(R<1)R=1; int chunk=4*R;
    struct buf C=bcreate((size_t)M*N*4,0x403); bsync(&C,both);
    struct buf pcd=bcreate(65536,0x403); memset(pcd.cpu,0,65536); bsync(&pcd,both);bsync(&pcd,RKNPU_MEM_SYNC_TO_DEVICE); /* PC_DATA scratch */
    /* per-slice live weight buffers (all live during the one chained submit) */
    struct buf *Bb=malloc(S*sizeof(struct buf));
    for(int si=0;si<S;si++){int k0=si*KS,Kp=(K-k0<KS)?(K-k0):KS,KT=Kp/32,NN=N/16;
        Bb[si]=bcreate((size_t)Kp*N*2,0x403); f16*bb=Bb[si].cpu;
        for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
            bb[nt*KT*16*32+kt*16*32+nl*32+kk]=blog[(size_t)(k0+kt*32+kk)*N+(nt*16+nl)];
        bsync(&Bb[si],both);bsync(&Bb[si],RKNPU_MEM_SYNC_TO_DEVICE);}
    int nsub=0;
    for(int m0=0;m0<M;m0+=chunk){
        int mc=(M-m0<chunk)?(M-m0):chunk; if(mc<=0)continue;
        /* S live feature buffers + S chained regcmds + S tasks, ONE submit */
        struct buf *Af=malloc(S*sizeof(struct buf));
        struct buf regs=bcreate((size_t)S*REGCMD_N*4,0x403);
        struct buf task=bcreate((size_t)S*sizeof(struct rknpu_task)+64,0x40b);
        struct rknpu_task *tk=task.cpu; memset(tk,0,S*sizeof(struct rknpu_task));
        for(int si=0;si<S;si++){int k0=si*KS,Kp=(K-k0<KS)?(K-k0):KS;
            Af[si]=bcreate((size_t)mc*Kp*2,0x403); f16*ad=Af[si].cpu;
            for(int r=0;r<mc;r++)for(int j=0;j<Kp;j++) ad[(size_t)r*Kp+j]=alog[(size_t)(m0+r)*K+k0+j];
            bsync(&Af[si],both);bsync(&Af[si],RKNPU_MEM_SYNC_TO_DEVICE);
            uint32_t*rc=(uint32_t*)regs.cpu+si*REGCMD_N;
            synth(rc,mc,Kp,N,(uint32_t)Af[si].dma,(uint32_t)Bb[si].dma,(uint32_t)C.dma+m0*N*4, si>0);
            chain(rc, (uint32_t)pcd.dma, 0x37);   /* shared PC_DATA scratch for partial sums */
            tk[si].enable_mask=0xd; tk[si].int_mask=0x300; tk[si].int_clear=0x1ffff;
            tk[si].regcfg_amount=108; tk[si].regcmd_addr=regs.dma+(size_t)si*REGCMD_N*4;
        }
        bsync(&regs,both);bsync(&regs,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&task,both);
        struct rknpu_submit sub;memset(&sub,0,sizeof sub);
        sub.flags=0x5;sub.timeout=6000;sub.task_start=0;sub.task_number=S;sub.task_counter=0;
        sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;
        sub.subcore_task[0]=(struct rknpu_subcore_task){0,S};
        if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
        bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE); nsub++;
    }
    float*cres=C.cpu; int bad=0;
    /* diagnostic: C[0,0] vs slice0-only, slice1-only, and full sum */
    {float full=0,s0=0,s1=0;for(int k=0;k<K;k++){float p=(float)alog[k]*(float)blog[(size_t)k*N];full+=p;if(k<KS)s0+=p;else s1+=p;}
     printf("  diag C[0]=%g  full=%g slice0=%g slice1=%g s0+s1=%g\n",(double)cres[0],(double)full,(double)s0,(double)s1,(double)(s0+s1));}
    for(int m=0;m<M;m++)for(int n=0;n<N;n++){float ref=0;for(int k=0;k<K;k++)ref+=(float)alog[(size_t)m*K+k]*(float)blog[(size_t)k*N+n]; if(cres[(size_t)m*N+n]!=ref)bad++;}
    printf("PCCHAIN MKN=%d,%d,%d  S=%d chained/submit  submits=%d  mism=%d/%d : %s\n",
        M,K,N,S,nsub,bad,M*N,bad?"WRONG":"CORRECT");
    return bad?2:0;
}
