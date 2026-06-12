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

// ── MUL_MAT via rknn_matmul_api ───────────────────────────────────────────────
// ggml MUL_MAT: dst[ne0=N, ne1=M] where dst = src1 . src0^T
//   src0 (weights) : [ne00=K, ne01=N]  (row n is the K-vector for output col n)
//   src1 (activs)  : [ne10=K, ne11=M]
// rknn computes C[M,N] = A[M,K] . B[K,N]; dst is stored M-rows x N-cols (row
// major, ne0=N contiguous) == C[M,N]. So A = src1 (M,K), B = src0 transposed to
// (K,N), C -> dst.
static void ggml_backend_rknpu_mul_mat(ggml_backend_rknpu_context * /*ctx*/, struct ggml_tensor * dst) {
    const struct ggml_tensor * src0 = dst->src[0];
    const struct ggml_tensor * src1 = dst->src[1];

    const int64_t K = src0->ne[0];
    const int64_t N = src0->ne[1];
    const int64_t M = src1->ne[1];

    rknn_matmul_ctx mctx = 0;
    rknn_matmul_info info; memset(&info, 0, sizeof info);
    info.M = (int32_t) M; info.K = (int32_t) K; info.N = (int32_t) N;
    info.type = RKNN_FLOAT16_MM_FLOAT16_TO_FLOAT32;
    info.B_layout = 0; info.AC_layout = 0;
    rknn_matmul_io_attr io; memset(&io, 0, sizeof io);
    if (rknn_matmul_create(&mctx, &info, &io) != 0) {
        GGML_ABORT("ggml-rknpu: rknn_matmul_create failed (M=%lld K=%lld N=%lld)", (long long)M,(long long)K,(long long)N);
    }

    rknn_tensor_mem * A = rknn_create_mem(mctx, io.A.size);
    rknn_tensor_mem * B = rknn_create_mem(mctx, io.B.size);
    rknn_tensor_mem * C = rknn_create_mem(mctx, io.C.size);

    // A[M,K] fp16  <- src1 F32  (row major, contiguous)
    {
        const float * s = (const float *) src1->data;
        ggml_fp16_t * a = (ggml_fp16_t *) A->virt_addr;
        for (int64_t i = 0; i < M*K; i++) a[i] = ggml_fp32_to_fp16(s[i]);
    }
    // B[K,N] fp16  <- src0 [N,K] fp16, transposed
    {
        const ggml_fp16_t * w = (const ggml_fp16_t *) src0->data; // [N,K]
        ggml_fp16_t * b = (ggml_fp16_t *) B->virt_addr;           // [K,N]
        for (int64_t n = 0; n < N; n++)
            for (int64_t k = 0; k < K; k++)
                b[k*N + n] = w[n*K + k];
    }

    rknn_matmul_set_io_mem(mctx, A, &io.A);
    rknn_matmul_set_io_mem(mctx, B, &io.B);
    rknn_matmul_set_io_mem(mctx, C, &io.C);

    if (rknn_matmul_run(mctx) != 0) {
        GGML_ABORT("ggml-rknpu: rknn_matmul_run failed");
    }

    // C[M,N] f32 -> dst (row major, ne0=N contiguous)
    memcpy(dst->data, C->virt_addr, (size_t)(M*N)*sizeof(float));

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
            const int64_t K  = src0->ne[0];
            const int64_t N  = src0->ne[1];
            // v0: 2D only, fp16 weights x f32 activations, RK3588 fp16 alignment.
            return src0->type == GGML_TYPE_F16 &&
                   src1->type == GGML_TYPE_F32 &&
                   op->type   == GGML_TYPE_F32 &&
                   ggml_is_contiguous(src0) && ggml_is_contiguous(src1) &&
                   src0->ne[2] == 1 && src0->ne[3] == 1 &&
                   src1->ne[2] == 1 && src1->ne[3] == 1 &&
                   (K % 32 == 0) && (N % 16 == 0);
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
