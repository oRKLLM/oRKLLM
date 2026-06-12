/* rknpu_trace.c — LD_PRELOAD ioctl interposer for RKNPU regcmd reverse-engineering.
 *
 * Milestone M1.1: log every RKNPU DRM ioctl a process makes (MEM_CREATE / MEM_MAP /
 * MEM_DESTROY / MEM_SYNC / SUBMIT / ACTION) with their decoded struct fields. Run a
 * known-good matmul (mmtest) under it to learn the buffer inventory and submission
 * shape that librknnrt builds.
 *
 *   gcc -shared -fPIC -O2 -I. -o rknpu_trace.so rknpu_trace.c -ldl
 *   sudo env LD_PRELOAD=$PWD/rknpu_trace.so ./mmtest
 *
 * M1.2 will extend this to dump the regcmd buffer contents (by tracking the
 * dma_addr <-> mmap'd CPU pointer correspondence). For now: structure only.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include "rknpu_ioctl.h"

static int (*real_ioctl)(int, unsigned long, ...) = NULL;

__attribute__((constructor))
static void rknpu_trace_init(void) {
    real_ioctl = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
    fprintf(stderr, "[rknpu_trace] loaded\n");
}

int ioctl(int fd, unsigned long request, ...) {
    va_list ap;
    va_start(ap, request);
    void *arg = va_arg(ap, void *);
    va_end(ap);

    if (!real_ioctl)
        real_ioctl = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");

    int ret = real_ioctl(fd, request, arg);

    switch (request) {
    case DRM_IOCTL_RKNPU_MEM_CREATE: {
        struct rknpu_mem_create *m = arg;
        fprintf(stderr,
            "[trace] MEM_CREATE  fd=%d handle=%u size=%llu flags=0x%x dma=0x%llx obj=0x%llx sram=%llu domain=%d core=0x%x -> %d\n",
            fd, m->handle, (unsigned long long)m->size, m->flags,
            (unsigned long long)m->dma_addr, (unsigned long long)m->obj_addr,
            (unsigned long long)m->sram_size, m->iommu_domain_id, m->core_mask, ret);
        break;
    }
    case DRM_IOCTL_RKNPU_MEM_MAP: {
        struct rknpu_mem_map *m = arg;
        fprintf(stderr, "[trace] MEM_MAP     fd=%d handle=%u offset=0x%llx -> %d\n",
            fd, m->handle, (unsigned long long)m->offset, ret);
        break;
    }
    case DRM_IOCTL_RKNPU_MEM_DESTROY: {
        struct rknpu_mem_destroy *m = arg;
        fprintf(stderr, "[trace] MEM_DESTROY fd=%d handle=%u obj=0x%llx -> %d\n",
            fd, m->handle, (unsigned long long)m->obj_addr, ret);
        break;
    }
    case DRM_IOCTL_RKNPU_MEM_SYNC: {
        struct rknpu_mem_sync *m = arg;
        fprintf(stderr, "[trace] MEM_SYNC    fd=%d obj=0x%llx off=0x%llx size=%llu flags=0x%x -> %d\n",
            fd, (unsigned long long)m->obj_addr, (unsigned long long)m->offset,
            (unsigned long long)m->size, m->flags, ret);
        break;
    }
    case DRM_IOCTL_RKNPU_SUBMIT: {
        struct rknpu_submit *s = arg;
        fprintf(stderr,
            "[trace] SUBMIT      fd=%d flags=0x%x timeout=%u task_start=%u task_number=%u counter=%u prio=%d task_obj=0x%llx domain=%d base=0x%llx core=0x%x fence=%d hw_us=%lld -> %d\n",
            fd, s->flags, s->timeout, s->task_start, s->task_number, s->task_counter,
            s->priority, (unsigned long long)s->task_obj_addr, s->iommu_domain_id,
            (unsigned long long)s->task_base_addr, s->core_mask, s->fence_fd,
            (long long)s->hw_elapse_time, ret);
        break;
    }
    case DRM_IOCTL_RKNPU_ACTION: {
        struct rknpu_action *a = arg;
        fprintf(stderr, "[trace] ACTION      fd=%d flags=%u value=0x%x -> %d\n",
            fd, a->flags, a->value, ret);
        break;
    }
    default:
        break;
    }
    return ret;
}
