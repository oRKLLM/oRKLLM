/* rknpu_mm.c — reusable fp16 NPU matmul library (see rknpu_mm.h).
 * Extracted from the validated rknpu_hybrid.c: K-split into <=2048 slices, each slice
 * M-tiled into single-submit-scheduler chunks (clean power-of-2 Kp) or per-M-tile
 * fallback (odd remainder Kp); fp32 partials accumulated. Weights packed per-slice and
 * kept resident; one reused feature buffer (the NPU caches feature state by address). */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include "rknpu_ioctl.h"
#include "regcmd_array_4x32x16.h"
#include "rknpu_mm.h"
#define CARD "/dev/dri/card1"
#define KS 2048
typedef rk_f16 f16;

struct buf { uint32_t handle; uint64_t dma, obj; void *cpu; size_t size; };
struct rknpu_mm { int fd; struct buf regcmd, task, Af, Cc; size_t ccsz; float *cres; size_t cressz; int warmed; };
struct rknpu_w  { int K, N, S; struct buf *Bb; };

static size_t pgup(size_t s){return (s+4095)&~((size_t)4095);}
static struct buf bcreate(int fd,size_t size,uint32_t flags){
    struct rknpu_mem_create c; memset(&c,0,sizeof c); c.size=pgup(size); c.flags=flags; c.core_mask=RKNPU_CORE0_MASK;
    if(ioctl(fd,DRM_IOCTL_RKNPU_MEM_CREATE,&c)){perror("CREATE");return (struct buf){0};}
    struct rknpu_mem_map m; memset(&m,0,sizeof m); m.handle=c.handle;
    if(ioctl(fd,DRM_IOCTL_RKNPU_MEM_MAP,&m)){perror("MAP");return (struct buf){0};}
    void*p=mmap(NULL,c.size,PROT_READ|PROT_WRITE,MAP_SHARED,fd,m.offset);
    if(p==MAP_FAILED){perror("mmap");return (struct buf){0};}
    return (struct buf){c.handle,c.dma_addr,c.obj_addr,p,c.size};
}
static void bdestroy(int fd,struct buf*b){ if(!b->cpu)return; munmap(b->cpu,b->size);
    struct rknpu_mem_destroy d; memset(&d,0,sizeof d); d.handle=b->handle; d.obj_addr=b->obj; ioctl(fd,DRM_IOCTL_RKNPU_MEM_DESTROY,&d); b->cpu=0; }
static void bsync(int fd,struct buf*b,uint32_t f){struct rknpu_mem_sync s;memset(&s,0,sizeof s);s.obj_addr=b->obj;s.size=b->size;s.flags=f;ioctl(fd,DRM_IOCTL_RKNPU_MEM_SYNC,&s);}
static void act(int fd,uint32_t f,uint32_t v){struct rknpu_action a={.flags=f,.value=v};ioctl(fd,DRM_IOCTL_RKNPU_ACTION,&a);}
/* replace ALL matching entries — the template has some regs (e.g. 0x1040) more than
 * once and the NPU uses a later copy, so a first-match-only setr leaves stale values. */
static void setr(uint32_t*rc,int n,uint32_t b,uint32_t o,uint32_t v){for(int k=0;k+1<n;k+=2)if((rc[k]&0xffff)==o&&(rc[k+1]>>16)==b){rc[k]=(o)|((v&0xffff)<<16);rc[k+1]=(b<<16)|((v>>16)&0xffff);}}
/* sched=1: single-submit M-scheduler (clean power-of-2 Kp); sched=0: one internal M-tile */
static void synth(uint32_t*rc,int mc,int K,int N,uint32_t aA,uint32_t aB,uint32_t aC,int sched){
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
        int v=base-slope*(mg-1); if(v<0x1b)v=0x1b;
        setr(rc,REGCMD_N,0x201,0x1040,v);
    } else { setr(rc,REGCMD_N,0x201,0x1010,16*(mc+1)); }
    setr(rc,REGCMD_N,0x201,0x1070,aA);setr(rc,REGCMD_N,0x201,0x1110,aB);setr(rc,REGCMD_N,0x1001,0x4020,aC);
}

rknpu_mm *rknpu_mm_init(void){
    int fd=open(CARD,O_RDWR); if(fd<0){perror("open " CARD);return NULL;}
    act(fd,RKNPU_GET_DRV_VERSION,0);act(fd,RKNPU_POWER_ON,0);act(fd,RKNPU_SET_PROC_NICE,(uint32_t)-19);
    rknpu_mm *c=calloc(1,sizeof *c); c->fd=fd;
    c->regcmd=bcreate(fd,4096,0x403); c->task=bcreate(fd,4096,0x40b); c->Af=bcreate(fd,(size_t)4*32768*2,0x403);
    struct rknpu_task t; memset(&t,0,sizeof t); t.enable_mask=0xd;t.int_mask=0x300;t.int_clear=0x1ffff;t.regcfg_amount=108;t.regcmd_addr=c->regcmd.dma;
    memcpy(c->task.cpu,&t,sizeof t); bsync(fd,&c->task,RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);
    if(!c->regcmd.cpu||!c->task.cpu||!c->Af.cpu){rknpu_mm_free(c);return NULL;}
    return c;
}
void rknpu_mm_free(rknpu_mm *c){ if(!c)return; int fd=c->fd;
    bdestroy(fd,&c->regcmd);bdestroy(fd,&c->task);bdestroy(fd,&c->Af);bdestroy(fd,&c->Cc);
    free(c->cres); if(fd>=0)close(fd); free(c); }

rknpu_w *rknpu_mm_pack(rknpu_mm *c,int K,int N,const f16 *B){
    if(K%32||N%16) return NULL;
    int S=(K+KS-1)/KS; rknpu_w *w=calloc(1,sizeof *w); w->K=K;w->N=N;w->S=S; w->Bb=calloc(S,sizeof(struct buf));
    for(int si=0;si<S;si++){int k0=si*KS,Kp=(K-k0<KS)?(K-k0):KS,KT=Kp/32,NN=N/16;
        w->Bb[si]=bcreate(c->fd,(size_t)Kp*N*2,0x403); f16*bb=w->Bb[si].cpu;
        for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
            bb[nt*KT*16*32+kt*16*32+nl*32+kk]=B[(size_t)(k0+kt*32+kk)*N+(nt*16+nl)];
        bsync(c->fd,&w->Bb[si],RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE);bsync(c->fd,&w->Bb[si],RKNPU_MEM_SYNC_TO_DEVICE);}
    return w;
}
void rknpu_mm_w_free(rknpu_w *w){ if(!w)return; free(w->Bb); free(w); }   /* buffers freed at ctx teardown */

int rknpu_mm_run(rknpu_mm *c,rknpu_w *w,int M,const f16 *A,float *C){
    int fd=c->fd,K=w->K,N=w->N;
    size_t need=(size_t)M*N*4;
    if(c->cressz<need){c->cres=realloc(c->cres,need);c->cressz=need;}
    memset(c->cres,0,need);
    /* size the reused output device buffer to the largest chunk this run needs */
    size_t maxout=0; for(int k0=0;k0<K;k0+=KS){int Kp=(K-k0<KS)?(K-k0):KS;int R=32768/Kp;if(R<1)R=1;size_t o=(size_t)4*R*N*4;if(o>maxout)maxout=o;}
    if(c->ccsz<maxout){bdestroy(fd,&c->Cc);c->Cc=bcreate(fd,maxout,0x403);c->ccsz=maxout; if(!c->Cc.cpu)return -1;}
    for(int si=0;si<w->S;si++){int k0=si*KS,Kp=(K-k0<KS)?(K-k0):KS;
        int sched=((Kp&(Kp-1))==0), R=32768/Kp; if(R<1)R=1; int chunk=sched?4*R:(16384/Kp); if(chunk<1)chunk=1;
        for(int m0=0;m0<M;m0+=chunk){int mc=(M-m0<chunk)?(M-m0):chunk; if(mc<=0)continue;
            f16*ad=c->Af.cpu; for(int r=0;r<mc;r++)for(int j=0;j<Kp;j++) ad[(size_t)r*Kp+j]=A[(size_t)(m0+r)*K+k0+j];
            bsync(fd,&c->Af,RKNPU_MEM_SYNC_TO_DEVICE);
            uint32_t rc[REGCMD_N]; synth(rc,mc,Kp,N,(uint32_t)c->Af.dma,(uint32_t)w->Bb[si].dma,(uint32_t)c->Cc.dma,sched);
            memcpy(c->regcmd.cpu,rc,sizeof rc); bsync(fd,&c->regcmd,RKNPU_MEM_SYNC_TO_DEVICE);
            struct rknpu_submit sub;memset(&sub,0,sizeof sub);sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=c->task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
            /* cold-start: the first submit on a fresh context yields stale results, so run
             * it twice once (a warmup), then never again. */
            int reps=c->warmed?1:2;
            for(int rep=0;rep<reps;rep++){
                if(ioctl(fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return -1;}
                bsync(fd,&c->Cc,RKNPU_MEM_SYNC_FROM_DEVICE);
            }
            c->warmed=1;
            float*cc=c->Cc.cpu; for(int r=0;r<mc;r++)for(int n=0;n<N;n++) c->cres[(size_t)(m0+r)*N+n]+=cc[(size_t)r*N+n];
        }
    }
    memcpy(C,c->cres,need); return 0;
}
