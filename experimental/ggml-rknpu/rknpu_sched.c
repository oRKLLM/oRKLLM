/* rknpu_sched.c — perf: replicate librknnrt's SINGLE-TASK internal M-scheduler.
 * One RKNPU_SUBMIT, full M feature/output; the NPU iterates M-tiles internally,
 * driven by 0x1010 (16*rows-per-tile) and 0x1040 (packed tile schedule). Uses the
 * captured librknnrt values for these two regs. fp16.
 *   cc -O2 -I. -o rknpu_sched rknpu_sched.c && sudo ./rknpu_sched [M K N r1010 r1040]
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
int main(int argc,char**argv){
    int M=argc>1?atoi(argv[1]):128,K=argc>2?atoi(argv[2]):512,N=argc>3?atoi(argv[3]):16;
    uint32_t r1010=argc>4?strtoul(argv[4],0,16):0, r1040=argc>5?strtoul(argv[5],0,16):0;
    g_fd=open(CARD,O_RDWR);if(g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0);act(RKNPU_POWER_ON,0);act(RKNPU_SET_PROC_NICE,(uint32_t)-19);
    struct buf regcmd=bcreate(4096,0x403),task=bcreate(4096,0x40b);
    struct buf A=bcreate((size_t)M*K*2,0x403),B=bcreate((size_t)K*N*2,0x403),scr=bcreate((size_t)K*N*2,0x403),C=bcreate((size_t)M*N*4,0x403);(void)scr;
    f16*a=A.cpu,*bbuf=B.cpu; float*href=malloc((size_t)M*N*4);
    f16*alog=malloc((size_t)M*K*sizeof(f16)),*blog=malloc((size_t)K*N*sizeof(f16)); unsigned s=12345;
    for(int i=0;i<M*K;i++){s=s*1103515245+12345;alog[i]=(f16)(int)((s>>16)%4);}
    for(int i=0;i<K*N;i++){s=s*1103515245+12345;blog[i]=(f16)(int)((s>>16)%4);}
    int KT=K/32,NN=N/16;
    for(int m=0;m<M;m++)for(int k=0;k<K;k++)a[m*K+k]=alog[m*K+k];
    for(int nt=0;nt<NN;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
        bbuf[nt*KT*16*32+kt*16*32+nl*32+kk]=blog[(kt*32+kk)*N+(nt*16+nl)];
    for(int m=0;m<M;m++)for(int n=0;n<N;n++){float acc=0;for(int k=0;k<K;k++)acc+=(float)alog[m*K+k]*(float)blog[k*N+n];href[m*N+n]=acc;}
    uint32_t rc[REGCMD_N]; memcpy(rc,REGCMD,sizeof rc);
    setr(rc,REGCMD_N,0x201,0x1024,((K-1)<<16)|K);setr(rc,REGCMD_N,0x201,0x1030,K*N*2);setr(rc,REGCMD_N,0x201,0x1034,K*2);
    setr(rc,REGCMD_N,0x201,0x1044,K/32);setr(rc,REGCMD_N,0x201,0x1088,K);setr(rc,REGCMD_N,0x201,0x107c,K/8);
    setr(rc,REGCMD_N,0x201,0x1020,0x10000|M);setr(rc,REGCMD_N,0x201,0x1084,0x10000|M);setr(rc,REGCMD_N,0x201,0x102c,M);
    setr(rc,REGCMD_N,0x1001,0x4034,M-1);setr(rc,REGCMD_N,0x1001,0x405c,(M-1)<<16);setr(rc,REGCMD_N,0x801,0x3014,(M-1)<<16);
    setr(rc,REGCMD_N,0x1001,0x403c,((N-1)<<16)|(N-1));setr(rc,REGCMD_N,0x1001,0x4058,N-1);setr(rc,REGCMD_N,0x1001,0x4038,(((N/4)-1)<<16)|((N/4)-1));
    setr(rc,REGCMD_N,0x201,0x1038,0x1010000|N);setr(rc,REGCMD_N,0x801,0x3018,N-1);
    /* M-scheduler regs. SINGLE M-tile (M<R, incl. decode M=1): full K in ONE submit,
     * 0x1040=0xb1 (librknnrt's value — validated for arbitrary K incl 4096/8192).
     * MULTI M-tile, K<=2048: base/slope closed-form (validated). MULTI-tile K>2048:
     * needs per-K CBUF calibration (nonlinear) — pass explicit hex args. */
    int R=32768/K; if(R<1)R=1;
    if(!r1010){ int rows=(M+1<R)?(M+1):R; r1010=16*rows; }
    if(!r1040){ if(M<R){ r1040=0xb1; }                       /* single M-tile: any K */
                else { int kk=K/256, lg=0; while(kk>1){kk>>=1;lg++;}
                int base=0xb1-15*((1<<lg)-1), slope=15*(1<<lg), mg=M/64; if(mg<1)mg=1;
                int v=base-slope*(mg-1); if(v<0x1b)v=0x1b; r1040=v; } }
    setr(rc,REGCMD_N,0x201,0x1010,r1010);
    setr(rc,REGCMD_N,0x201,0x1040,r1040);
    setr(rc,REGCMD_N,0x201,0x1070,(uint32_t)A.dma);setr(rc,REGCMD_N,0x201,0x1110,(uint32_t)B.dma);setr(rc,REGCMD_N,0x1001,0x4020,(uint32_t)C.dma);
    memcpy(regcmd.cpu,rc,sizeof rc);
    struct rknpu_task t; memset(&t,0,sizeof t);t.enable_mask=0xd;t.int_mask=0x300;t.int_clear=0x1ffff;t.regcfg_amount=108;t.regcmd_addr=regcmd.dma;
    memcpy(task.cpu,&t,sizeof t);
    int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE;
    bsync(&regcmd,both);bsync(&task,both);bsync(&A,both);bsync(&B,both);bsync(&C,both);
    bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&A,RKNPU_MEM_SYNC_TO_DEVICE);
    struct rknpu_submit sub;memset(&sub,0,sizeof sub);sub.flags=0x5;sub.timeout=6000;sub.task_number=1;sub.task_obj_addr=task.obj;sub.core_mask=RKNPU_CORE0_MASK;sub.fence_fd=-1;sub.subcore_task[0]=(struct rknpu_subcore_task){0,1};
    if(ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&sub)){perror("SUBMIT");return 1;}
    bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE);
    float*c=C.cpu;int bad=0;for(int i=0;i<M*N;i++)if(c[i]!=href[i])bad++;
    printf("SCHED MKN=%d,%d,%d 1010=0x%x 1040=0x%x  ONE submit  mism=%d/%d : %s  hw=%lldus\n",
        M,K,N,r1010,r1040,bad,M*N,bad?"WRONG":"CORRECT",(long long)sub.hw_elapse_time);
    return bad?2:0;
}
