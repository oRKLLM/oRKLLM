/* rknpu_mm.h — reusable fp16 NPU matmul library (M4 keystone).
 *
 * Turns the validated standalone kernels into a callable API: ONE device handle, weights
 * packed once and kept resident on the NPU, many matmuls streamed against them. This is
 * what a transformer forward pass needs (fixed weights, streaming activations).
 *
 * Matmul: C[M,N] (fp32) = A[M,K] (fp16, row-major) x B[K,N] (fp16, row-major).
 * Uses the K-split + single-submit-scheduler hybrid internally (arbitrary M/K/N, incl.
 * non-power-of-2 K via the per-M-tile fallback). Requires NPU hardware (/dev/dri/card1).
 */
#ifndef RKNPU_MM_H
#define RKNPU_MM_H
#include <stdint.h>
typedef _Float16 rk_f16;

typedef struct rknpu_mm rknpu_mm;       /* device context */
typedef struct rknpu_w  rknpu_w;        /* resident packed weights for one B[K,N] */

rknpu_mm *rknpu_mm_init(void);                       /* open + power on; NULL on failure */
void      rknpu_mm_free(rknpu_mm *ctx);

/* Pack + upload B[K,N] (row-major fp16) into NPU-resident tile layout. Reusable across
 * many rknpu_mm_run calls. K%32==0, N%16==0. */
rknpu_w  *rknpu_mm_pack(rknpu_mm *ctx, int K, int N, const rk_f16 *B);
void      rknpu_mm_w_free(rknpu_w *w);

/* C[M,N] = A[M,K] x (packed weights). A row-major fp16, C row-major fp32. Returns 0 ok. */
int       rknpu_mm_run(rknpu_mm *ctx, rknpu_w *w, int M, const rk_f16 *A, float *C);

#endif
