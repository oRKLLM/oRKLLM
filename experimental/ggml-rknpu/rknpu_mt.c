/* rknpu_mt.c — perf: M-tile a matmul as N TASKS in ONE RKNPU_SUBMIT (task_number=N),
 * instead of N separate submits. Each task has its own regcmd (own feature/output
 * buffer). Collapses N submits -> 1 (the dominant per-submit overhead). fp16.
 *   cc -O2 -I. -o rknpu_mt rknpu_mt.c && sudo ./rknpu_mt [M K N]
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
static void synth(uint32_t*rc,int M,int K,int N,uint32_t aA,uint32_t aB,uint32_t aC){
    memcpy(rc,REGCMD,REGCMD_N*4);
    setr(rc,REGCMD_N,0x201,0x1024,((K-1)<<16)|K);setr(rc,REGCMD_N,0x201,0x1030,K*N*2);setr(rc,REGCMD_N,0x201,0x1034,K*2);
    setr(rc,REGCMD_N,0x201,0x1044,K/32);setr(rc,REGCMD_N,0x201,0x1088,K);setr(rc,REGCMD_N,0x201,0x107c,K/8);
    setr(rc,REGCMD_N,0x201,0x1020,0x10000|M);setr(rc,REGCMD_N,0x201,0x1084,0x10000|M);setr(rc,REGCMD_N,0x201,0x102c,M);
    setr(rc,REGCMD_N,0x201,0x1010,(16*(M+1)>0x800)?0x800:16*(M+1));{int mt=(M+63)/64;setr(rc,REGCMD_N,0x201,0x1040,0xb1-15*(mt-1));}
    setr(rc,REGCMD_N,0x1001,0x4034,M-1);setr(rc,REGCMD_N,0x1001,0x405c,(M-1)<<16);setr(rc,REGCMD_N,0x801,0x3014,(M-1)<<16);
    setr(rc,REGCMD_N,0x1001,0x403c,((N-1)<<16)|(N-1));setr(rc,REGCMD_N,0x1001,0x4058,N-1);setr(rc,REGCMD_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1));
    setr(rc,REGCMD_N,0x201,0x1038,0x1010000|N);setr(rc,REGCMD_N,0x801,0x3018,N-1);
    setr(rc,REGCMD_N,0x201,0x1070,aA);setr(rc,REGCMD_N,0x201,0x1110,aB);setr(rc,REGCMD_N,0x1001,0x4020,aC);
}
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):128,K=argc>2?atoi(argv[2]):512,N=argc>3?atoi(argv[3]):16;
    if(K%32||N%16){printf("need K%%32,N%%16\n");return 1;}
    g_fd=open(CARD,O_RDWR);if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    int cap=16384/K; if(cap<1)cap=1; int NT=(M+cap-1)/cap;
    /* weights resident */
    int KT=K/32,NN=N/16;
    struct buf B=bcreate((size_t)K*N*2,0x403); f16*bbuf=B.cpu;
    f16*blog=malloc((size_t)K*N*sizeof(f16)); unsigned s=12345;
    f16*alog=malloc((size_t)M*K*sizeof(f16));
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(f16)(int)((s>>16)%4);}
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(f16)(int)((s>>16)%4);}
    for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
        bbuf[nt*KT*16*32+kt*16*32+nl*32+kk]=blog[(kt*32+kk)*N+(nt*16+nl)];
    bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);
    /* per-tile feature + output buffers (unique live IOVAs) */
    struct buf *Ac=malloc(NT*sizeof(struct buf)),*Cc=malloc(NT*sizeof(struct buf));
    struct buf regcmd=bcreate((size_t)NT*REGCMD_N*4,0x403);   /* N regcmds concatenated */
    struct buf task=bcreate((size_t)NT*sizeof(struct rknpu_task)+64,0x40b);
    struct rknpu_task *tk=task.cpu; memset(tk,0,NT*sizeof(struct rknpu_task));
    for(int i=0;i<NT;i++){
        int m0=i*cap, mc=(M-m0<cap)?(M-m0):cap;
        Ac[i]=bcreate((size_t)mc*K*2,0x403); Cc[i]=bcreate((size_t)mc*N*4,0x403);
        memcpy(Ac[i].cpu, alog+(size_t)m0*K, (size_t)mc*K*sizeof(f16));
        bsync(&Ac[i],RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);bsync(&Cc[i],RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);bsync(&Ac[i],RKNPU_MEM_SYNC_TO_DEVICE);
        uint32_t *rc=(uint32_t*)regcmd.cpu + i*REGCMD_N;
        synth(rc, mc,K,N, (uint32_t)Ac[i].dma,(uint32_t)B.dma,(uint32_t)Cc[i].dma);
        tk[i].enable_mask=0xd; tk[i].int_mask=(i==NT-1)?0x300:0x0; tk[i].int_clear=0x1ffff; tk[i].regcfg_amount=108;
        tk[i].regcmd_addr=regcmd.dma + (size_t)i*REGCMD_N*4;
    }
    bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);
    bsync(&task,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);
    /* ONE submit, N tasks on core 0 */
    struct rknpu_submit sub; memset(&sub,0,sizeof sub);
    sub.flags=0x5; sub.timeout=6000; sub.task_start=0; sub.task_number=NT; sub.task_counter=0;
    sub.task_obj_addr=task.obj; sub.core_mask=RKNPU_CORE0_MASK; sub.fence_fd=-1;
    sub.subcore_task[0]=(struct rknpu_subcore_task){0,NT};
    if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
    for(int i=0;i<NT;i++) bsync(&Cc[i],RKNPU_MEM_SYNC_FROM_DEVICE);
    /* validate */
    int bad=0;
    for(int i=0;i<NT;i++){int m0=i*cap,mc=(M-m0<cap)?(M-m0):cap; float*c=Cc[i].cpu;
        for(int r=0;r<mc;r++)for(int n=0;n<N;n++){float ref=0;for(int k=0;k<K;k++)ref+=(float)alog[(size_t)(m0+r)*K+k]*(float)blog[(size_t)k*N+n];
            if(c[r*N+n]!=ref)bad++;}}
    printf("MULTI-TASK MKN=%d,%d,%d  tiles=%d in ONE submit  mism=%d/%d : %s  hw=%lldus\n",
        M,K,N,NT,bad,M*N,bad?"WRONG":"CORRECT",(long long)sub.hw_elapse_time);
    return bad?2:0;
}
