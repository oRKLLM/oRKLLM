/* rknpu_probe.c — validate the RKNPU DRM interface against real hardware.
 *
 * Opens the RKNPU render node, queries the driver via RKNPU_ACTION, and does a
 * GEM buffer create -> map -> mmap -> write -> sync -> destroy round-trip. This
 * is the "hello world" for ggml_backend_rknpu: if these ioctls succeed, the
 * backend's device + memory layer is sound and we can move on to job submission.
 *
 *   cc -O2 -o rknpu_probe rknpu_probe.c && ./rknpu_probe
 *
 * Run as a user in the 'render' group (or root). No libdrm needed.
 */
#include "rknpu_ioctl.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/mman.h>

static const char *NODE = "/dev/dri/renderD129"; /* DRIVER=RKNPU on this board */

static int action(int fd, unsigned which, unsigned *out) {
	struct rknpu_action a;
	memset(&a, 0, sizeof a);
	a.flags = which;
	if (ioctl(fd, DRM_IOCTL_RKNPU_ACTION, &a) < 0) return -errno;
	if (out) *out = a.value;
	return 0;
}

int main(void) {
	int fd = open(NODE, O_RDWR | O_CLOEXEC);
	if (fd < 0) { fprintf(stderr, "open %s: %s\n", NODE, strerror(errno)); return 1; }
	printf("opened %s (fd=%d)\n", NODE, fd);

	unsigned v;
	if (action(fd, RKNPU_GET_HW_VERSION, &v) == 0)        printf("  hw_version      = 0x%08x\n", v);
	if (action(fd, RKNPU_GET_DRV_VERSION, &v) == 0)       printf("  drv_version     = 0x%08x (%u.%u.%u)\n", v, (v>>16)&0xff,(v>>8)&0xff,v&0xff);
	if (action(fd, RKNPU_GET_IOMMU_EN, &v) == 0)          printf("  iommu_enabled   = %u\n", v);
	if (action(fd, RKNPU_GET_FREQ, &v) == 0)              printf("  freq            = %u Hz\n", v);
	if (action(fd, RKNPU_GET_TOTAL_SRAM_SIZE, &v) == 0)   printf("  total_sram      = %u bytes\n", v);
	if (action(fd, RKNPU_GET_FREE_SRAM_SIZE, &v) == 0)    printf("  free_sram       = %u bytes\n", v);

	/* buffer round-trip: create -> map -> mmap -> write -> sync -> destroy */
	struct rknpu_mem_create c;
	memset(&c, 0, sizeof c);
	c.size  = 4096;
	c.flags = RKNPU_MEM_NON_CONTIGUOUS | RKNPU_MEM_CACHEABLE | RKNPU_MEM_IOMMU | RKNPU_MEM_ZEROING | RKNPU_MEM_KERNEL_MAPPING;
	if (ioctl(fd, DRM_IOCTL_RKNPU_MEM_CREATE, &c) < 0) {
		fprintf(stderr, "MEM_CREATE: %s\n", strerror(errno));
	} else {
		printf("MEM_CREATE ok: handle=%u dma_addr=0x%llx obj_addr=0x%llx size=%llu\n",
		       c.handle, (unsigned long long)c.dma_addr, (unsigned long long)c.obj_addr, (unsigned long long)c.size);

		struct rknpu_mem_map m; memset(&m, 0, sizeof m); m.handle = c.handle;
		if (ioctl(fd, DRM_IOCTL_RKNPU_MEM_MAP, &m) < 0) {
			fprintf(stderr, "MEM_MAP: %s\n", strerror(errno));
		} else {
			void *p = mmap(NULL, c.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, m.offset);
			if (p == MAP_FAILED) {
				fprintf(stderr, "mmap: %s\n", strerror(errno));
			} else {
				memset(p, 0xA5, 64);                 /* CPU write */
				struct rknpu_mem_sync s; memset(&s, 0, sizeof s);
				s.obj_addr = c.obj_addr; s.size = c.size; s.flags = RKNPU_MEM_SYNC_TO_DEVICE;
				if (ioctl(fd, DRM_IOCTL_RKNPU_MEM_SYNC, &s) < 0)
					fprintf(stderr, "MEM_SYNC: %s\n", strerror(errno));
				else
					printf("mmap+write+sync ok: first bytes %02x %02x %02x ...\n",
					       ((unsigned char*)p)[0], ((unsigned char*)p)[1], ((unsigned char*)p)[2]);
				munmap(p, c.size);
			}
		}
		struct rknpu_mem_destroy d; memset(&d, 0, sizeof d);
		d.handle = c.handle; d.obj_addr = c.obj_addr;
		if (ioctl(fd, DRM_IOCTL_RKNPU_MEM_DESTROY, &d) < 0) fprintf(stderr, "MEM_DESTROY: %s\n", strerror(errno));
		else printf("MEM_DESTROY ok\n");
	}

	close(fd);
	printf("probe complete\n");
	return 0;
}
