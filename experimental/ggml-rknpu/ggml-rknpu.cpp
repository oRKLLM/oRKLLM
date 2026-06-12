// ggml-rknpu.cpp — a ggml compute backend for the Rockchip RK3588 NPU.
//
// CPU-assist backend in the mould of ggml-blas: tensors live in host (CPU)
// buffers; this backend only claims GGML_OP_MUL_MAT and offloads it to the NPU
// via Rockchip's rknn_matmul_api (librknnrt.so). The scheduler keeps every other
// op on the CPU backend.
//
// v0 scope (validated incrementally — see oRKLLM wiki ggml-backend-rknpu):
//   - FP16 weights (src0) x F32 activations (src1) -> F32 dst
//   - 2D only (no batch broadcast), contiguous, K%32==0 && N%16==0 (RK3588 fp16
//     alignment) — supports_op() gates everything else back to the CPU.
// This is a correct-but-narrow first backend; padding/quant/batching are TODO.

#include "ggml-impl.h"
#include "ggml-rknpu.h"
#include "ggml-backend-impl.h"

#include "rknn_matmul_api.h"

#include <cstring>
#include <cstdlib>
#include <vector>
#include <mutex>

struct ggml_backend_rknpu_context {
    int dummy = 0;
};

static inline int64_t rk_align(int64_t x, int64_t a) { return (x + a - 1) / a * a; }

// fetch element (row-major plane, type-aware) as fp32
static inline float rk_get_f32(const char * row, int64_t i, enum ggml_type t) {
    return t == GGML_TYPE_F32 ? ((const float *) row)[i]
                              : ggml_fp16_to_fp32(((const ggml_fp16_t *) row)[i]);
}

// ── MUL_MAT via rknn_matmul_api ───────────────────────────────────────────────
// ggml MUL_MAT: dst[ne0=N, ne1=M, ne2, ne3] = src1 . src0^T, per (i2,i3) plane,
// with src0 broadcast over src1 (r2=ne12/ne02, r3=ne13/ne03).
//   src0 (weights)   : [ne00=K, ne01=N]   plane
//   src1 (activs)    : [ne10=K, ne11=M]   plane
// rknn: C[M,N] = A[M,K] . B[K,N]  with A=src1 plane, B=src0 plane transposed.
// Generalised v1: arbitrary K/N (zero-padded to RK3588 fp16 alignment K%32/N%16),
// batched/broadcast planes, and F16 *or* F32 inputs (converted to fp16 for the NPU).
static void ggml_backend_rknpu_mul_mat(ggml_backend_rknpu_context * /*ctx*/, struct ggml_tensor * dst) {
    const struct ggml_tensor * src0 = dst->src[0];
    const struct ggml_tensor * src1 = dst->src[1];

    const int64_t K = src0->ne[0];
    const int64_t N = src0->ne[1];
    const int64_t M = src1->ne[1];
    const int64_t Kp = rk_align(K, 32);
    const int64_t Np = rk_align(N, 16);

    const int64_t r2 = src1->ne[2] / src0->ne[2];
    const int64_t r3 = src1->ne[3] / src0->ne[3];

    rknn_matmul_ctx mctx = 0;
    rknn_matmul_info info; memset(&info, 0, sizeof info);
    info.M = (int32_t) M; info.K = (int32_t) Kp; info.N = (int32_t) Np;
    info.type = RKNN_FLOAT16_MM_FLOAT16_TO_FLOAT32;
    info.B_layout = 0; info.AC_layout = 0;
    rknn_matmul_io_attr io; memset(&io, 0, sizeof io);
    if (rknn_matmul_create(&mctx, &info, &io) != 0) {
        GGML_ABORT("ggml-rknpu: rknn_matmul_create failed (M=%lld Kp=%lld Np=%lld)", (long long)M,(long long)Kp,(long long)Np);
    }
    rknn_tensor_mem * A = rknn_create_mem(mctx, io.A.size);
    rknn_tensor_mem * B = rknn_create_mem(mctx, io.B.size);
    rknn_tensor_mem * C = rknn_create_mem(mctx, io.C.size);

    for (int64_t i3 = 0; i3 < dst->ne[3]; i3++) {
        for (int64_t i2 = 0; i2 < dst->ne[2]; i2++) {
            const char * s1 = (const char *) src1->data + i2*src1->nb[2] + i3*src1->nb[3];
            const char * s0 = (const char *) src0->data + (i2/r2)*src0->nb[2] + (i3/r3)*src0->nb[3];
            char       * d  = (char *)       dst->data  + i2*dst->nb[2]  + i3*dst->nb[3];

            // A[M,Kp] fp16  <- src1 plane [K,M] (zero-padded over Kp)
            ggml_fp16_t * a = (ggml_fp16_t *) A->virt_addr;
            memset(a, 0, io.A.size);
            for (int64_t m = 0; m < M; m++) {
                const char * row = s1 + m*src1->nb[1];
                for (int64_t k = 0; k < K; k++) a[m*Kp + k] = ggml_fp32_to_fp16(rk_get_f32(row, k, src1->type));
            }
            // B[Kp,Np] fp16  <- src0 plane [K,N] transposed (zero-padded)
            ggml_fp16_t * b = (ggml_fp16_t *) B->virt_addr;
            memset(b, 0, io.B.size);
            for (int64_t n = 0; n < N; n++) {
                const char * wrow = s0 + n*src0->nb[1];
                for (int64_t k = 0; k < K; k++) b[k*Np + n] = ggml_fp32_to_fp16(rk_get_f32(wrow, k, src0->type));
            }

            rknn_matmul_set_io_mem(mctx, A, &io.A);
            rknn_matmul_set_io_mem(mctx, B, &io.B);
            rknn_matmul_set_io_mem(mctx, C, &io.C);
            if (rknn_matmul_run(mctx) != 0) GGML_ABORT("ggml-rknpu: rknn_matmul_run failed");

            // C[M,Np] f32 -> dst plane (row m = N contiguous f32 at d + m*nb1)
            const float * c = (const float *) C->virt_addr;
            for (int64_t m = 0; m < M; m++) {
                memcpy(d + m*dst->nb[1], c + m*Np, (size_t) N * sizeof(float));
            }
        }
    }

    rknn_destroy_mem(mctx, A);
    rknn_destroy_mem(mctx, B);
    rknn_destroy_mem(mctx, C);
    rknn_matmul_destroy(mctx);
}

// ── backend interface ─────────────────────────────────────────────────────────
static const char * ggml_backend_rknpu_get_name(ggml_backend_t /*backend*/) { return "RKNPU"; }

static void ggml_backend_rknpu_free(ggml_backend_t backend) {
    delete (ggml_backend_rknpu_context *) backend->context;
    delete backend;
}

static enum ggml_status ggml_backend_rknpu_graph_compute(ggml_backend_t backend, struct ggml_cgraph * cgraph) {
    ggml_backend_rknpu_context * ctx = (ggml_backend_rknpu_context *) backend->context;
    for (int i = 0; i < cgraph->n_nodes; i++) {
        struct ggml_tensor * node = cgraph->nodes[i];
        switch (node->op) {
            case GGML_OP_MUL_MAT:  ggml_backend_rknpu_mul_mat(ctx, node); break;
            case GGML_OP_NONE:
            case GGML_OP_RESHAPE:
            case GGML_OP_VIEW:
            case GGML_OP_PERMUTE:
            case GGML_OP_TRANSPOSE: break;
            default: GGML_ABORT("ggml-rknpu: unsupported op %s", ggml_op_desc(node));
        }
    }
    return GGML_STATUS_SUCCESS;
}

static struct ggml_backend_i rknpu_backend_i = {
    /* .get_name           = */ ggml_backend_rknpu_get_name,
    /* .free               = */ ggml_backend_rknpu_free,
    /* .set_tensor_async   = */ NULL,
    /* .get_tensor_async   = */ NULL,
    /* .set_tensor_2d_async= */ NULL,
    /* .get_tensor_2d_async= */ NULL,
    /* .cpy_tensor_async   = */ NULL,
    /* .synchronize        = */ NULL,
    /* .graph_plan_create  = */ NULL,
    /* .graph_plan_free    = */ NULL,
    /* .graph_plan_update  = */ NULL,
    /* .graph_plan_compute = */ NULL,
    /* .graph_compute      = */ ggml_backend_rknpu_graph_compute,
    /* .event_record       = */ NULL,
    /* .event_wait         = */ NULL,
    /* .graph_optimize     = */ NULL,
};

static ggml_guid_t ggml_backend_rknpu_guid(void) {
    static ggml_guid guid = { 0x72,0x6b,0x6e,0x70,0x75,0x00,0x33,0x35,0x38,0x38,0xab,0xcd,0xef,0x01,0x23,0x45 };
    return &guid;
}

ggml_backend_t ggml_backend_rknpu_init(void) {
    ggml_backend_rknpu_context * ctx = new ggml_backend_rknpu_context;
    ggml_backend_t backend = new ggml_backend {
        /* .guid    = */ ggml_backend_rknpu_guid(),
        /* .iface   = */ rknpu_backend_i,
        /* .device  = */ ggml_backend_reg_dev_get(ggml_backend_rknpu_reg(), 0),
        /* .context = */ ctx,
    };
    return backend;
}

bool ggml_backend_is_rknpu(ggml_backend_t backend) {
    return backend != NULL && ggml_guid_matches(backend->guid, ggml_backend_rknpu_guid());
}

// ── device interface ──────────────────────────────────────────────────────────
static const char * ggml_backend_rknpu_device_get_name(ggml_backend_dev_t)        { return "RKNPU"; }
static const char * ggml_backend_rknpu_device_get_description(ggml_backend_dev_t) { return "Rockchip RK3588 NPU (rknn_matmul_api)"; }
static void ggml_backend_rknpu_device_get_memory(ggml_backend_dev_t, size_t * free, size_t * total) { *free = 0; *total = 0; }
static enum ggml_backend_dev_type ggml_backend_rknpu_device_get_type(ggml_backend_dev_t) { return GGML_BACKEND_DEVICE_TYPE_ACCEL; }

static void ggml_backend_rknpu_device_get_props(ggml_backend_dev_t dev, struct ggml_backend_dev_props * props) {
    props->name        = ggml_backend_rknpu_device_get_name(dev);
    props->description = ggml_backend_rknpu_device_get_description(dev);
    props->type        = ggml_backend_rknpu_device_get_type(dev);
    ggml_backend_rknpu_device_get_memory(dev, &props->memory_free, &props->memory_total);
    props->caps = { /*.async=*/false, /*.host_buffer=*/false, /*.buffer_from_host_ptr=*/true, /*.events=*/false };
}

static ggml_backend_t ggml_backend_rknpu_device_init_backend(ggml_backend_dev_t, const char *) { return ggml_backend_rknpu_init(); }
static ggml_backend_buffer_type_t ggml_backend_rknpu_device_get_buffer_type(ggml_backend_dev_t) { return ggml_backend_cpu_buffer_type(); }
static ggml_backend_buffer_t ggml_backend_rknpu_device_buffer_from_host_ptr(ggml_backend_dev_t, void * ptr, size_t size, size_t) { return ggml_backend_cpu_buffer_from_ptr(ptr, size); }

static bool ggml_backend_rknpu_device_supports_op(ggml_backend_dev_t, const struct ggml_tensor * op) {
    switch (op->op) {
        case GGML_OP_NONE:
        case GGML_OP_RESHAPE:
        case GGML_OP_VIEW:
        case GGML_OP_PERMUTE:
        case GGML_OP_TRANSPOSE:
            return true;
        case GGML_OP_MUL_MAT: {
            const struct ggml_tensor * src0 = op->src[0];
            const struct ggml_tensor * src1 = op->src[1];
            // v1: F16/F32 weights x F16/F32 activations -> F32, contiguous, any
            // K/N/M (zero-padded to NPU alignment) and batched/broadcast planes.
            // Quantized weights (INT4/INT8) are still TODO -> stay on CPU.
            const bool t0_ok = src0->type == GGML_TYPE_F16 || src0->type == GGML_TYPE_F32;
            const bool t1_ok = src1->type == GGML_TYPE_F16 || src1->type == GGML_TYPE_F32;
            return t0_ok && t1_ok && op->type == GGML_TYPE_F32 &&
                   ggml_is_contiguous(src0) && ggml_is_contiguous(src1) &&
                   (src1->ne[2] % src0->ne[2] == 0) &&   // broadcastable
                   (src1->ne[3] % src0->ne[3] == 0);
        }
        default:
            return false;
    }
}

static bool ggml_backend_rknpu_device_supports_buft(ggml_backend_dev_t, ggml_backend_buffer_type_t buft) {
    return ggml_backend_buft_is_host(buft);
}

static const struct ggml_backend_device_i ggml_backend_rknpu_device_i = {
    /* .get_name             = */ ggml_backend_rknpu_device_get_name,
    /* .get_description      = */ ggml_backend_rknpu_device_get_description,
    /* .get_memory           = */ ggml_backend_rknpu_device_get_memory,
    /* .get_type             = */ ggml_backend_rknpu_device_get_type,
    /* .get_props            = */ ggml_backend_rknpu_device_get_props,
    /* .init_backend         = */ ggml_backend_rknpu_device_init_backend,
    /* .get_buffer_type      = */ ggml_backend_rknpu_device_get_buffer_type,
    /* .get_host_buffer_type = */ NULL,
    /* .buffer_from_host_ptr = */ ggml_backend_rknpu_device_buffer_from_host_ptr,
    /* .supports_op          = */ ggml_backend_rknpu_device_supports_op,
    /* .supports_buft        = */ ggml_backend_rknpu_device_supports_buft,
    /* .offload_op           = */ NULL,
    /* .event_new            = */ NULL,
    /* .event_free           = */ NULL,
    /* .event_synchronize    = */ NULL,
};

// ── reg interface ─────────────────────────────────────────────────────────────
static const char * ggml_backend_rknpu_reg_get_name(ggml_backend_reg_t) { return "RKNPU"; }
static size_t       ggml_backend_rknpu_reg_get_device_count(ggml_backend_reg_t) { return 1; }
static ggml_backend_dev_t ggml_backend_rknpu_reg_get_device(ggml_backend_reg_t reg, size_t index) {
    GGML_ASSERT(index == 0);
    static ggml_backend_device dev = { /*.iface=*/ ggml_backend_rknpu_device_i, /*.reg=*/ reg, /*.context=*/ nullptr };
    return &dev;
}

static const struct ggml_backend_reg_i ggml_backend_rknpu_reg_i = {
    /* .get_name         = */ ggml_backend_rknpu_reg_get_name,
    /* .get_device_count = */ ggml_backend_rknpu_reg_get_device_count,
    /* .get_device       = */ ggml_backend_rknpu_reg_get_device,
    /* .get_proc_address = */ NULL,
};

ggml_backend_reg_t ggml_backend_rknpu_reg(void) {
    static struct ggml_backend_reg reg = {
        /* .api_version = */ GGML_BACKEND_API_VERSION,
        /* .iface       = */ ggml_backend_rknpu_reg_i,
        /* .context     = */ NULL,
    };
    return &reg;
}

GGML_BACKEND_DL_IMPL(ggml_backend_rknpu_reg)
