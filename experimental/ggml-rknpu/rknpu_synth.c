/* rknpu_synth.c — M2.2: SYNTHESIZE the regcmd from scratch for arbitrary (M,K,N).
 *
 * Uses the captured 4x32x16 regcmd as the structural template (the ~90 shape-
 * invariant register writes + 4 trailing PC-control entries), and recomputes the
 * ~18 dimension-dependent registers from the M1.3 register dictionary (each a
 * closed-form function of M/K/N). Patches A/B/C addresses, submits via raw
 * RKNPU_SUBMIT on the card node, and validates the NPU result against a CPU
 * matmul reference using small-integer data (exact in fp16/fp32).
 *
 *   cc -O2 -I. -o rknpu_synth rknpu_synth.c && sudo ./rknpu_synth [M K N]
 *
 * Constraints (NPU fp16 matmul): K % 32 == 0, N % 16 == 0.
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
#include "regcmd_array_4x32x16.h"   /* REGCMD[REGCMD_N], REGCMD_N=224 (112 entries) */

#define CARD "/dev/dri/card1"
typedef _Float16 f16;
static int g_fd;
struct buf { uint32_t handle; uint64_t dma, obj; void *cpu; size_t size; };

static size_t pgup(size_t s){ return (s + 4095) & ~((size_t)4095); }

static struct buf bcreate(size_t size, uint32_t flags) {
    struct rknpu_mem_create c; memset(&c,0,sizeof c);
    c.size = pgup(size); c.flags = flags; c.core_mask = RKNPU_CORE0_MASK;
    if (ioctl(g_fd, DRM_IOCTL_RKNPU_MEM_CREATE, &c)) { perror("MEM_CREATE"); _exit(1); }
    struct rknpu_mem_map m; memset(&m,0,sizeof m); m.handle = c.handle;
    if (ioctl(g_fd, DRM_IOCTL_RKNPU_MEM_MAP, &m)) { perror("MEM_MAP"); _exit(1); }
    void *p = mmap(NULL, c.size, PROT_READ|PROT_WRITE, MAP_SHARED, g_fd, m.offset);
    if (p == MAP_FAILED) { perror("mmap"); _exit(1); }
    return (struct buf){ c.handle, c.dma_addr, c.obj_addr, p, c.size };
}
static void bsync(struct buf *b, uint32_t flags) {
    struct rknpu_mem_sync s; memset(&s,0,sizeof s);
    s.obj_addr = b->obj; s.offset = 0; s.size = b->size; s.flags = flags;
    ioctl(g_fd, DRM_IOCTL_RKNPU_MEM_SYNC, &s);
}
static void act(uint32_t f, uint32_t v){ struct rknpu_action a={.flags=f,.value=v}; ioctl(g_fd,DRM_IOCTL_RKNPU_ACTION,&a); }

/* set the register entry (block,reg) in the regcmd to `value` (M1.3 encoding) */
static void set_reg(uint32_t *rc, int n, uint32_t block, uint32_t off, uint32_t value) {
    for (int k=0;k+1<n;k+=2)
        if ((rc[k]&0xffff)==off && (rc[k+1]>>16)==block) {
            rc[k]   = (off) | ((value & 0xffff) << 16);
            rc[k+1] = (block << 16) | ((value >> 16) & 0xffff);
            return;
        }
    fprintf(stderr, "  WARN: reg %x:%x not in template\n", block, off);
}

/* Build the regcmd for (M,K,N) from the template + M1.3 closed-form dim fields. */
static void synth_regcmd(uint32_t *rc, int M, int K, int N, uint32_t aA, uint32_t aB, uint32_t aC) {
    memcpy(rc, REGCMD, REGCMD_N*4);
    /* K fields (block 0x0201 CNA feature) */
    set_reg(rc,REGCMD_N,0x0201,0x1024, ((K-1)<<16)|K);
    set_reg(rc,REGCMD_N,0x0201,0x1030, K*N*2);  /* weights byte-size (depends on K AND N) */
    set_reg(rc,REGCMD_N,0x0201,0x1034, K*2);
    set_reg(rc,REGCMD_N,0x0201,0x1044, K/32);
    set_reg(rc,REGCMD_N,0x0201,0x1088, K);
    set_reg(rc,REGCMD_N,0x0201,0x107c, K/8);
    /* M fields */
    set_reg(rc,REGCMD_N,0x0201,0x1020, 0x10000|M);
    set_reg(rc,REGCMD_N,0x0201,0x1084, 0x10000|M);
    set_reg(rc,REGCMD_N,0x0201,0x102c, M);
    set_reg(rc,REGCMD_N,0x0201,0x1010, (16*(M+1) > 0x800) ? 0x800 : 16*(M+1));  /* saturates at M>=127 (M-tile=64) */
    set_reg(rc,REGCMD_N,0x1001,0x4034, M-1);
    set_reg(rc,REGCMD_N,0x1001,0x405c, (M-1)<<16);
    set_reg(rc,REGCMD_N,0x0801,0x3014, (M-1)<<16);
    /* N fields (block 0x1001 PPU/core output) */
    set_reg(rc,REGCMD_N,0x1001,0x403c, ((N-1)<<16)|(N-1));
    set_reg(rc,REGCMD_N,0x1001,0x4058, N-1);
    set_reg(rc,REGCMD_N,0x1001,0x4038, (((N/4)-1)<<16)|((N/4)-1));
    set_reg(rc,REGCMD_N,0x0201,0x1038, 0x1010000|N);
    set_reg(rc,REGCMD_N,0x0801,0x3018, N-1);
    /* addresses */
    set_reg(rc,REGCMD_N,0x0201,0x1070, aA);
    set_reg(rc,REGCMD_N,0x0201,0x1110, aB);
    set_reg(rc,REGCMD_N,0x1001,0x4020, aC);
}

int main(int argc, char **argv) {
    int M = argc>1?atoi(argv[1]):4, K = argc>2?atoi(argv[2]):32, N = argc>3?atoi(argv[3]):16;
    if (K%32 || N%16) { printf("need K%%32==0, N%%16==0\n"); return 1; }
    g_fd = open(CARD, O_RDWR); if (g_fd<0){perror("open");return 1;}
    act(RKNPU_GET_DRV_VERSION,0); act(RKNPU_POWER_ON,0); act(RKNPU_SET_PROC_NICE,(uint32_t)-19);

    struct buf regcmd=bcreate(4096,0x403), task=bcreate(4096,0x40b);
    struct buf A=bcreate(M*K*2,0x403), B=bcreate(K*N*2,0x403);
    struct buf scratch=bcreate(K*N*2,0x403); (void)scratch;   /* template's 6th buffer */
    struct buf C=bcreate(M*N*4,0x403);

    /* small-int data (exact in fp16). A (feature) is row-major [M][K]; B (weights)
     * must be TRANSPOSED to [N][K] in the NPU buffer — the NPU expects weights
     * output-channel-major (derived from librknnrt's set_io_mem reorder). */
    f16 *a=A.cpu,*bbuf=B.cpu; float *href=malloc(M*N*sizeof(float));
    f16 *alog=malloc(M*K*sizeof(f16)), *blog=malloc(K*N*sizeof(f16));
    unsigned seed=12345;
    for(int i=0;i<M*K;i++){seed=seed*1103515245+12345; alog[i]=(f16)(int)((seed>>16)%4);}
    for(int i=0;i<K*N;i++){seed=seed*1103515245+12345; blog[i]=(f16)(int)((seed>>16)%4);}
    /* K-tiled layouts (32-channel tiles), tile-major. Reduces to row-major/transpose at K=32. */
    int KT = K/32, NT = N/16;
    for(int m=0;m<M;m++)for(int k=0;k<K;k++) a[m*K+k]=alog[m*K+k];   /* feature flat [M][K] */
    /* weights [Ntile][Ktile][16][32]: N tiles by 16, K tiles by 32 (transposed within) */
    for(int nt=0;nt<NT;nt++)for(int kt=0;kt<KT;kt++)for(int nl=0;nl<16;nl++)for(int kk=0;kk<32;kk++)
        bbuf[nt*KT*16*32 + kt*16*32 + nl*32 + kk] = blog[(kt*32+kk)*N + (nt*16+nl)];
    for(int m=0;m<M;m++)for(int n=0;n<N;n++){float s=0;for(int k=0;k<K;k++)s+=(float)alog[m*K+k]*(float)blog[k*N+n];href[m*N+n]=s;}

    uint32_t rc[REGCMD_N];
    synth_regcmd(rc, M,K,N, (uint32_t)A.dma,(uint32_t)B.dma,(uint32_t)C.dma);
    memcpy(regcmd.cpu, rc, sizeof rc);

    struct rknpu_task t; memset(&t,0,sizeof t);
    t.enable_mask=0xd; t.int_mask=0x300; t.int_clear=0x1ffff; t.int_status=0;
    t.regcfg_amount=108; t.regcmd_addr=regcmd.dma;
    memcpy(task.cpu,&t,sizeof t);

    int both=RKNPU_MEM_SYNC_TO_DEVICE|RKNPU_MEM_SYNC_FROM_DEVICE;
    bsync(&regcmd,both);bsync(&task,both);bsync(&A,both);bsync(&B,both);bsync(&C,both);
    bsync(&B,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&regcmd,RKNPU_MEM_SYNC_TO_DEVICE);bsync(&A,RKNPU_MEM_SYNC_TO_DEVICE);

    struct rknpu_submit s; memset(&s,0,sizeof s);
    s.flags=0x5; s.timeout=6000; s.task_number=1; s.task_obj_addr=task.obj;
    s.core_mask=RKNPU_CORE0_MASK; s.fence_fd=-1; s.subcore_task[0]=(struct rknpu_subcore_task){0,1};
    if (ioctl(g_fd,DRM_IOCTL_RKNPU_SUBMIT,&s)){perror("SUBMIT");return 1;}
    bsync(&C,RKNPU_MEM_SYNC_FROM_DEVICE);

    float *c=C.cpu; int bad=0; float maxerr=0;
    for(int i=0;i<M*N;i++){float e=c[i]-href[i]; if(e<0)e=-e; if(e>maxerr)maxerr=e; if(e>0.5f)bad++;}
    double gflop = 2.0*M*K*N/1e9, us = (double)s.hw_elapse_time;
    printf("MKN=%d,%d,%d  C[0]=%.1f ref[0]=%.1f  mism=%d/%d : %s  | hw=%.0fus  %.1f GFLOP/s\n",
           M,K,N, c[0],href[0], bad, M*N, bad?"WRONG":"CORRECT", us, us>0?gflop/(us/1e6):0);
    return bad?2:0;
}
