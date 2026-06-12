/* rknpu_replay.c — M2.1: drive the NPU matmul via raw RKNPU_SUBMIT, NO librknnrt.
 *
 * Replays the captured [4x32]*[32x16] fp16->fp32 regcmd. Allocates the 6 buffers
 * in the same order/size as librknnrt (reproducing the IOVAs the regcmd embeds),
 * patches the A/B/C address fields for safety, writes the regcmd + a one-entry
 * rknpu_task, submits, and checks C == K (=32).
 *
 *   cc -O2 -I/tmp/rknpu -o rknpu_replay rknpu_replay.c
 *   sudo ./rknpu_replay
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include "rknpu_ioctl.h"
#include "regcmd_array.h"   /* static const uint32_t REGCMD[216]; */

#define RENDER "/dev/dri/renderD129"
#define PAGE 4096

/* generic DRM PRIME export (dmabuf) — librknnrt does this per buffer */
struct drm_prime_handle { uint32_t handle; uint32_t flags; int32_t fd; };
#define DRM_IOCTL_PRIME_HANDLE_TO_FD _IOWR('d', 0x2d, struct drm_prime_handle)

typedef _Float16 f16;

struct buf { uint32_t handle; uint64_t dma, obj; void *cpu; };

static int g_fd;

static struct buf bcreate(uint32_t flags) {
    struct rknpu_mem_create c; memset(&c,0,sizeof c);
    c.size = PAGE; c.flags = flags; c.core_mask = RKNPU_CORE0_MASK; c.iommu_domain_id = 0;
    if (ioctl(g_fd, DRM_IOCTL_RKNPU_MEM_CREATE, &c)) { perror("MEM_CREATE"); _exit(1); }
    struct rknpu_mem_map m; memset(&m,0,sizeof m); m.handle = c.handle;
    if (ioctl(g_fd, DRM_IOCTL_RKNPU_MEM_MAP, &m)) { perror("MEM_MAP"); _exit(1); }
    void *p = mmap(NULL, PAGE, PROT_READ|PROT_WRITE, MAP_SHARED, g_fd, m.offset);
    if (p == MAP_FAILED) { perror("mmap"); _exit(1); }
    struct buf b = { c.handle, c.dma_addr, c.obj_addr, p };
    /* PRIME-export the buffer (dmabuf), as librknnrt does — may set up DMA mapping */
    struct drm_prime_handle ph; memset(&ph,0,sizeof ph); ph.handle = c.handle; ph.flags = O_RDWR|O_CLOEXEC;
    if (ioctl(g_fd, DRM_IOCTL_PRIME_HANDLE_TO_FD, &ph)==0)
        printf("  alloc handle=%u dma=0x%llx prime_fd=%d\n", b.handle, (unsigned long long)b.dma, ph.fd);
    else
        printf("  alloc handle=%u dma=0x%llx (prime export failed)\n", b.handle, (unsigned long long)b.dma);
    return b;
}

static uint32_t do_action(uint32_t flags, uint32_t value) {
    struct rknpu_action a; memset(&a,0,sizeof a); a.flags = flags; a.value = value;
    int r = ioctl(g_fd, DRM_IOCTL_RKNPU_ACTION, &a);
    printf("  ACTION flags=%u value=0x%x -> ret=%d out=0x%x\n", flags, value, r, a.value);
    return a.value;
}

static void bsync(struct buf *b, uint32_t flags) {
    struct rknpu_mem_sync s; memset(&s,0,sizeof s);
    s.obj_addr = b->obj; s.offset = 0; s.size = PAGE; s.flags = flags;
    if (ioctl(g_fd, DRM_IOCTL_RKNPU_MEM_SYNC, &s)) perror("MEM_SYNC");
}

/* patch a 32-bit address value into the regcmd entry at (block, off) */
static void patch_addr(uint32_t *rc, int n, uint32_t block, uint32_t off, uint32_t addr) {
    for (int k=0;k+1<n;k+=2) {
        if ((rc[k]&0xffff)==off && (rc[k+1]>>16)==block) {
            rc[k]   = (rc[k]   & 0x0000ffff) | ((addr & 0xffff) << 16);
            rc[k+1] = (rc[k+1] & 0xffff0000) | ((addr >> 16) & 0xffff);
            printf("  patched %x:%x <- 0x%x\n", block, off, addr);
            return;
        }
    }
    printf("  WARN: reg %x:%x not found to patch\n", block, off);
}

int main(void) {
    g_fd = open(RENDER, O_RDWR);
    if (g_fd < 0) { perror("open render"); return 1; }

    /* device-init preamble, mirroring librknnrt */
    printf("init preamble...\n");
    do_action(RKNPU_GET_HW_VERSION, 0);
    do_action(RKNPU_GET_DRV_VERSION, 0);
    do_action(RKNPU_POWER_ON, 0);
    do_action(RKNPU_SET_PROC_NICE, (uint32_t)-19);
    do_action(RKNPU_GET_IOMMU_EN, 0);

    /* same alloc order as librknnrt: regcmd, task, B, A, scratch, C */
    printf("allocating buffers...\n");
    struct buf regcmd = bcreate(0x403);
    struct buf task   = bcreate(0x40b);
    struct buf B      = bcreate(0x403);
    struct buf A      = bcreate(0x403);
    struct buf scratch= bcreate(0x403); (void)scratch;
    struct buf C      = bcreate(0x403);

    /* regcmd: copy + patch A/B/C addresses to actual IOVAs */
    uint32_t rc[216]; memcpy(rc, REGCMD, sizeof rc);
    patch_addr(rc, 216, 0x0201, 0x1070, (uint32_t)A.dma);
    patch_addr(rc, 216, 0x0201, 0x1110, (uint32_t)B.dma);
    patch_addr(rc, 216, 0x1001, 0x4020, (uint32_t)C.dma);
    memcpy(regcmd.cpu, rc, sizeof rc);

    /* task descriptor: one rknpu_task pointing at regcmd */
    struct rknpu_task t; memset(&t,0,sizeof t);
    t.enable_mask = 0x0d; t.int_mask = 0x300; t.int_clear = 0x1ffff; t.int_status = 0x100;
    t.regcfg_amount = 108; t.regcfg_offset = 0; t.regcmd_addr = regcmd.dma;
    memcpy(task.cpu, &t, sizeof t);

    /* inputs: A[4x32]=1, B[32x16]=1 (fp16) */
    f16 *a = A.cpu, *b = B.cpu;
    for (int i=0;i<4*32;i++) a[i]=(f16)1.0f;
    for (int i=0;i<32*16;i++) b[i]=(f16)1.0f;

    /* mirror librknnrt: bidirectional 0x3 sync of every buffer AFTER writing data,
     * then the pre-submit to-device flushes B, regcmd, A, regcmd (double). */
    int both = RKNPU_MEM_SYNC_TO_DEVICE | RKNPU_MEM_SYNC_FROM_DEVICE;
    bsync(&regcmd, both); bsync(&task, both); bsync(&B, both);
    bsync(&A, both); bsync(&scratch, both); bsync(&C, both);
    bsync(&B,      RKNPU_MEM_SYNC_TO_DEVICE);
    bsync(&regcmd, RKNPU_MEM_SYNC_TO_DEVICE);
    bsync(&A,      RKNPU_MEM_SYNC_TO_DEVICE);
    bsync(&regcmd, RKNPU_MEM_SYNC_TO_DEVICE);

    /* submit (mirrors the captured rknpu_submit) */
    struct rknpu_submit s; memset(&s,0,sizeof s);
    s.flags = 0x5; s.timeout = 6000; s.task_start = 0; s.task_number = 3; s.task_counter = 3;
    s.priority = 0; s.task_obj_addr = task.obj; s.iommu_domain_id = 0; s.core_mask = RKNPU_CORE0_MASK;
    s.fence_fd = -1;
    s.subcore_task[0] = (struct rknpu_subcore_task){0,1};
    s.subcore_task[1] = (struct rknpu_subcore_task){0,1};
    s.subcore_task[2] = (struct rknpu_subcore_task){0,1};
    printf("submitting...\n");
    if (ioctl(g_fd, DRM_IOCTL_RKNPU_SUBMIT, &s)) { perror("SUBMIT"); return 1; }
    printf("submit OK, hw_elapse=%lld us\n", (long long)s.hw_elapse_time);

    bsync(&C, RKNPU_MEM_SYNC_FROM_DEVICE);

    float *c = C.cpu;
    printf("C[0..4] = %.1f %.1f %.1f %.1f  (expect 32)\n", c[0],c[1],c[2],c[3]);
    int ok=1; for (int i=0;i<4*16;i++) if (c[i] < 31.5f || c[i] > 32.5f) { ok=0; break; }
    printf("RAW REGCMD REPLAY: %s\n", ok ? "CORRECT" : "WRONG");
    return ok?0:2;
}
