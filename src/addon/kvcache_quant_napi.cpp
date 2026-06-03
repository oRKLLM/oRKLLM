// KV cache quantisation — N-API addon.
//
// Three schemes, all async (libuv thread pool via AsyncWorker):
//
//  Scheme        | Magic      | Vec bytes | Token bytes | Reduction
//  --------------|------------|-----------|-------------|----------
//  min-max INT8  | 0xAA55AA55 | 132       | 76,048      | ~44%
//  polar INT8    | 0xBB55BB55 | 130       | 74,896      | ~49%
//  polar INT4    | 0xCC44CC44 |  66       | 38,032      | ~74%
//
// Compute path selection (polar INT8 only):
//   1. Vulkan (Mali-G52 via panvk)  — HAS_VULKAN + integrated GPU available
//   2. ARM NEON SIMD                — aarch64, always available
//   3. Portable scalar              — all other platforms (CI / macOS dev)
//
// NEON is kept as the fallback so the addon works on any aarch64 system
// regardless of whether libvulkan-dev was installed at build time.

#include <napi.h>
#include <fstream>
#include <vector>
#include <cmath>
#include <cstdint>
#include <cstring>
#include "vk_quant.hpp"   // no-op when HAS_VULKAN is not defined
#include <stdexcept>
#include <string>
#include <algorithm>

#ifdef __aarch64__
#include <arm_neon.h>
#define HAS_NEON 1
#else
#define HAS_NEON 0
#endif

// ── Constants ──────────────────────────────────────────────────────────────
static constexpr uint32_t BYTES_PER_TOKEN   = 147472;
static constexpr uint32_t DIMS              = 128;
static constexpr uint32_t BYTES_FP16_VEC    = DIMS * 2;
static constexpr uint32_t PADDING           = 16;
static constexpr uint32_t VECS_PER_TOKEN    = (BYTES_PER_TOKEN - PADDING) / BYTES_FP16_VEC; // 576

static constexpr uint32_t Q8_VEC_BYTES      = 4 + DIMS;      // f32 scale  + 128 i8  = 132
static constexpr uint32_t PQ8_VEC_BYTES     = 2 + DIMS;      // f16 norm   + 128 i8  = 130
static constexpr uint32_t PQ4_VEC_BYTES     = 2 + DIMS / 2;  // f16 norm   +  64 i4  =  66

static constexpr uint32_t Q8_TOKEN_BYTES    = VECS_PER_TOKEN * Q8_VEC_BYTES  + PADDING; // 76,048
static constexpr uint32_t PQ8_TOKEN_BYTES   = VECS_PER_TOKEN * PQ8_VEC_BYTES + PADDING; // 74,896
static constexpr uint32_t PQ4_TOKEN_BYTES   = VECS_PER_TOKEN * PQ4_VEC_BYTES + PADDING; // 38,032

static constexpr uint32_t MAGIC_Q8          = 0xAA55AA55;
static constexpr uint32_t MAGIC_PQ8         = 0xBB55BB55;
static constexpr uint32_t MAGIC_PQ4         = 0xCC44CC44;
static constexpr uint32_t H0_ORIGINAL       = 43;
static constexpr uint32_t H1_KV_HEADS       = 8;
static constexpr uint32_t FIXED_OVERHEAD_MIN = 600000;
static constexpr uint32_t FIXED_OVERHEAD_MAX = 640000;

// ── Portable scalar FP16 ───────────────────────────────────────────────────
static inline float fp16_to_f32(uint16_t h) {
    uint32_t s = (h >> 15) & 1u, e = (h >> 10) & 0x1fu, m = h & 0x3ffu;
    if (e == 0)  return (s ? -1.f : 1.f) * (m / 1024.f) * std::ldexp(1.f, -14);
    if (e == 31) return m == 0 ? (s ? -INFINITY : INFINITY) : NAN;
    return (s ? -1.f : 1.f) * std::ldexp(1.f + m / 1024.f, (int)e - 15);
}

static inline uint16_t f32_to_fp16(float f) {
    if (std::isnan(f))    return 0x7e00u;
    if (!std::isfinite(f)) return f > 0 ? 0x7c00u : 0xfc00u;
    uint32_t s = (f < 0) ? 1u : 0u;
    f = std::abs(f);
    if (f == 0.f) return (uint16_t)(s << 15);
    int exp; float mant = std::frexp(f, &exp);
    int e16 = exp + 14;
    if (e16 >= 31) return (uint16_t)((s << 15) | 0x7c00u);
    uint32_t frac;
    if (e16 <= 0) { frac = (uint32_t)std::round(mant * (1 << (e16 + 10))); e16 = 0; }
    else          { frac = (uint32_t)std::round((mant * 2.f - 1.f) * 1024.f);
                    if (frac >= 1024) { frac = 0; e16++; }
                    if (e16 >= 31) return (uint16_t)((s << 15) | 0x7c00u); }
    return (uint16_t)((s << 15) | ((uint32_t)e16 << 10) | frac);
}

// ── INT4 pack / unpack (scalar, byte-manipulation) ─────────────────────────
// Packing: byte[i] = (v[2i] & 0x0F) | ((v[2i+1] & 0x0F) << 4)
// Values are clamped to [-7, 7] before packing.
static void pack_i4(const int8_t* vals, uint8_t* packed) {
    for (int i = 0; i < 64; i++)
        packed[i] = (uint8_t)((vals[2*i] & 0x0Fu) | ((uint8_t)(vals[2*i+1] & 0x0Fu) << 4));
}

// Unpack: sign-extend each 4-bit nibble to int8_t
static void unpack_i4(const uint8_t* packed, int8_t* vals) {
    for (int i = 0; i < 64; i++) {
        vals[2*i]   = (int8_t)((int8_t)(packed[i] << 4) >> 4); // low nibble, sign-extend
        vals[2*i+1] = (int8_t)(packed[i]) >> 4;                  // high nibble, sign-extend
    }
}

// ── NEON helpers ───────────────────────────────────────────────────────────
#if HAS_NEON
// Compute L2 norm of 128 FP16 values (all arithmetic in FP32)
static inline float l2_norm_neon(const uint16_t* fp16) {
    float32x4_t sum = vdupq_n_f32(0.f);
    for (int i = 0; i < DIMS; i += 8) {
        float16x8_t v8 = vld1q_f16((const __fp16*)(fp16 + i));
        float32x4_t lo = vcvt_f32_f16(vget_low_f16(v8));
        float32x4_t hi = vcvt_f32_f16(vget_high_f16(v8));
        sum = vmlaq_f32(sum, lo, lo);
        sum = vmlaq_f32(sum, hi, hi);
    }
    float32x2_t s2 = vadd_f32(vget_low_f32(sum), vget_high_f32(sum));
    s2 = vpadd_f32(s2, s2);
    return sqrtf(vget_lane_f32(s2, 0));
}

// Scale 128 FP16 values by inv_scale and store as 128 INT8
static inline void scale_to_i8_neon(const uint16_t* fp16, int8_t* out,
                                      float inv_scale) {
    float32x4_t sc = vdupq_n_f32(inv_scale);
    for (int i = 0; i < DIMS; i += 8) {
        float16x8_t v8 = vld1q_f16((const __fp16*)(fp16 + i));
        float32x4_t lo = vmulq_f32(vcvt_f32_f16(vget_low_f16(v8)),  sc);
        float32x4_t hi = vmulq_f32(vcvt_f32_f16(vget_high_f16(v8)), sc);
        int16x8_t i16  = vcombine_s16(vqmovn_s32(vcvtnq_s32_f32(lo)),
                                       vqmovn_s32(vcvtnq_s32_f32(hi)));
        vst1_s8(out + i, vqmovn_s16(i16));
    }
}

// Dequantize 128 INT8 values: v = q * scale → FP16
static inline void i8_to_fp16_neon(const int8_t* in, uint16_t* fp16,
                                     float scale) {
    float32x4_t sc = vdupq_n_f32(scale);
    for (int i = 0; i < DIMS; i += 16) {
        int8x16_t raw = vld1q_s8(in + i);
        int16x8_t lo16 = vmovl_s8(vget_low_s8(raw));
        int16x8_t hi16 = vmovl_s8(vget_high_s8(raw));
        float32x4_t ll = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_low_s16(lo16))),  sc);
        float32x4_t lh = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_high_s16(lo16))), sc);
        float32x4_t hl = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_low_s16(hi16))),  sc);
        float32x4_t hh = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_high_s16(hi16))), sc);
        vst1q_f16((__fp16*)(fp16 + i),     vcombine_f16(vcvt_f16_f32(ll), vcvt_f16_f32(lh)));
        vst1q_f16((__fp16*)(fp16 + i + 8), vcombine_f16(vcvt_f16_f32(hl), vcvt_f16_f32(hh)));
    }
}
#endif // HAS_NEON

// ── Per-vector operations ──────────────────────────────────────────────────

// Min-max INT8: encode
static void encode_q8(const uint16_t* fp16, int8_t* out_i8, float* out_scale) {
#if HAS_NEON
    float32x4_t maxabs = vdupq_n_f32(0.f);
    for (int i = 0; i < DIMS; i += 8) {
        float16x8_t v8 = vld1q_f16((const __fp16*)(fp16 + i));
        float32x4_t lo = vabsq_f32(vcvt_f32_f16(vget_low_f16(v8)));
        float32x4_t hi = vabsq_f32(vcvt_f32_f16(vget_high_f16(v8)));
        maxabs = vmaxq_f32(maxabs, vmaxq_f32(lo, hi));
    }
    float32x2_t m2 = vpmax_f32(vget_low_f32(maxabs), vget_high_f32(maxabs));
    m2 = vpmax_f32(m2, m2);
    float max_val = vget_lane_f32(m2, 0);
    float scale = (max_val == 0.f) ? 1.f : max_val / 127.f;
    *out_scale = scale;
    scale_to_i8_neon(fp16, out_i8, 1.f / scale);
#else
    float vals[DIMS], max_val = 0.f;
    for (int i = 0; i < DIMS; i++) {
        vals[i] = fp16_to_f32(fp16[i]);
        if (std::abs(vals[i]) > max_val) max_val = std::abs(vals[i]);
    }
    float scale = (max_val == 0.f) ? 1.f : max_val / 127.f;
    *out_scale = scale;
    for (int i = 0; i < DIMS; i++)
        out_i8[i] = (int8_t)std::max(-127, std::min(127, (int)std::roundf(vals[i] / scale)));
#endif
}

// Polar INT8: encode — store norm(fp16) + direction(i8)
static void encode_pq8(const uint16_t* fp16, int8_t* out_i8, uint16_t* out_norm_fp16) {
#if HAS_NEON
    float norm = l2_norm_neon(fp16);
    *out_norm_fp16 = f32_to_fp16(norm);
    scale_to_i8_neon(fp16, out_i8, norm == 0.f ? 0.f : 127.f / norm);
#else
    float vals[DIMS], sq = 0.f;
    for (int i = 0; i < DIMS; i++) { vals[i] = fp16_to_f32(fp16[i]); sq += vals[i]*vals[i]; }
    float norm = sqrtf(sq);
    *out_norm_fp16 = f32_to_fp16(norm);
    float inv = (norm == 0.f) ? 0.f : 127.f / norm;
    for (int i = 0; i < DIMS; i++)
        out_i8[i] = (int8_t)std::max(-127, std::min(127, (int)std::roundf(vals[i] * inv)));
#endif
}

// Polar INT4: encode — store norm(fp16) + direction(i4 packed)
static void encode_pq4(const uint16_t* fp16, uint8_t* out_packed, uint16_t* out_norm_fp16) {
#if HAS_NEON
    float norm = l2_norm_neon(fp16);
    *out_norm_fp16 = f32_to_fp16(norm);
    // Quantize direction to INT4 range [-7,7]: scale = 7/norm
    float32x4_t sc  = vdupq_n_f32(norm == 0.f ? 0.f : 7.f / norm);
    float32x4_t clo = vdupq_n_f32(-7.f), chi = vdupq_n_f32(7.f);
    int8_t tmp[DIMS];
    for (int i = 0; i < DIMS; i += 8) {
        float16x8_t v8 = vld1q_f16((const __fp16*)(fp16 + i));
        float32x4_t lo = vminq_f32(vmaxq_f32(vmulq_f32(vcvt_f32_f16(vget_low_f16(v8)),  sc), clo), chi);
        float32x4_t hi = vminq_f32(vmaxq_f32(vmulq_f32(vcvt_f32_f16(vget_high_f16(v8)), sc), clo), chi);
        int16x8_t i16  = vcombine_s16(vqmovn_s32(vcvtnq_s32_f32(lo)),
                                       vqmovn_s32(vcvtnq_s32_f32(hi)));
        vst1_s8(tmp + i, vqmovn_s16(i16));
    }
    pack_i4(tmp, out_packed);
#else
    float vals[DIMS], sq = 0.f;
    for (int i = 0; i < DIMS; i++) { vals[i] = fp16_to_f32(fp16[i]); sq += vals[i]*vals[i]; }
    float norm = sqrtf(sq);
    *out_norm_fp16 = f32_to_fp16(norm);
    float inv = (norm == 0.f) ? 0.f : 7.f / norm;
    int8_t tmp[DIMS];
    for (int i = 0; i < DIMS; i++)
        tmp[i] = (int8_t)std::max(-7, std::min(7, (int)std::roundf(vals[i] * inv)));
    pack_i4(tmp, out_packed);
#endif
}

// Min-max INT8: decode
static void decode_q8(const int8_t* in_i8, uint16_t* fp16, float scale) {
#if HAS_NEON
    i8_to_fp16_neon(in_i8, fp16, scale);
#else
    for (int i = 0; i < DIMS; i++) fp16[i] = f32_to_fp16(in_i8[i] * scale);
#endif
}

// Polar INT8: decode
static void decode_pq8(const int8_t* in_i8, uint16_t* fp16, float norm) {
    // v = direction * norm = (q / 127) * norm
    decode_q8(in_i8, fp16, norm / 127.f);
}

// Polar INT4: decode
static void decode_pq4(const uint8_t* in_packed, uint16_t* fp16, float norm) {
    int8_t tmp[DIMS];
    unpack_i4(in_packed, tmp);
    // v = (q / 7) * norm
    float scale = norm / 7.f;
#if HAS_NEON
    i8_to_fp16_neon(tmp, fp16, scale);
#else
    for (int i = 0; i < DIMS; i++) fp16[i] = f32_to_fp16(tmp[i] * scale);
#endif
}

// ── Error metrics ──────────────────────────────────────────────────────────
static void accumulate_error(const uint16_t* orig_fp16, const uint16_t* rec_fp16,
                              float& max_err, double& sum_sq, size_t& n) {
    for (int i = 0; i < DIMS; i++) {
        float err = std::abs(fp16_to_f32(orig_fp16[i]) - fp16_to_f32(rec_fp16[i]));
        if (err > max_err) max_err = err;
        sum_sq += (double)err * err;
        n++;
    }
}

// ── File I/O ───────────────────────────────────────────────────────────────
static std::vector<uint8_t> read_file(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot open: " + p);
    f.seekg(0, std::ios::end); std::streamsize sz = f.tellg(); f.seekg(0);
    std::vector<uint8_t> b(sz);
    if (!f.read(reinterpret_cast<char*>(b.data()), sz))
        throw std::runtime_error("Read error: " + p);
    return b;
}

static void write_file(const std::string& p, const std::vector<uint8_t>& d) {
    std::ofstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot create: " + p);
    if (!f.write(reinterpret_cast<const char*>(d.data()), d.size()))
        throw std::runtime_error("Write error: " + p);
}

// ── Generic encode/decode machinery ────────────────────────────────────────
enum class Scheme { Q8, PQ8, PQ4 };

struct EncodeStats {
    uint32_t n_tokens = 0, fixed = 0;
    size_t src_bytes = 0, dst_bytes = 0;
    float max_err = 0; double sum_sq = 0; size_t n_vals = 0;
    bool used_gpu = false;
};

static std::vector<uint8_t> encode_file(const std::vector<uint8_t>& src,
                                          Scheme scheme, EncodeStats& st) {
    if (src.size() < 12) throw std::runtime_error("File too small");
    uint32_t n = *(const uint32_t*)(src.data() + 8);
    uint64_t kv = src.size() - (uint64_t)BYTES_PER_TOKEN * n;
    if (kv < FIXED_OVERHEAD_MIN || kv > FIXED_OVERHEAD_MAX)
        throw std::runtime_error("Implausible fixed overhead: " + std::to_string(kv));
    uint32_t fixed = (uint32_t)kv;

    uint32_t tok_bytes = scheme == Scheme::Q8  ? Q8_TOKEN_BYTES  :
                         scheme == Scheme::PQ8 ? PQ8_TOKEN_BYTES : PQ4_TOKEN_BYTES;
    uint32_t magic     = scheme == Scheme::Q8  ? MAGIC_Q8  :
                         scheme == Scheme::PQ8 ? MAGIC_PQ8 : MAGIC_PQ4;

    std::vector<uint8_t> dst(fixed + (size_t)tok_bytes * n);
    std::copy(src.begin(), src.begin() + fixed, dst.begin());
    *(uint32_t*)(dst.data() + 0) = magic;
    *(uint32_t*)(dst.data() + 4) = fixed;

    uint8_t* wp = dst.data() + fixed;
    uint16_t rec[DIMS];

    // ── Polar INT8: try GPU (Vulkan/Mali) first, fall back to NEON ────────
    bool used_gpu = false;
#ifdef HAS_VULKAN
    if (scheme == Scheme::PQ8 || scheme == Scheme::Q8 || scheme == Scheme::PQ4) {
        auto& vkq = VkQuantizer::get();
        if (vkq.ok()) {
            const uint32_t total_vecs = n * VECS_PER_TOKEN;
            // Gather all FP16 into one contiguous buffer
            std::vector<uint16_t> fp16_flat(total_vecs * DIMS);
            for (uint32_t t = 0; t < n; t++) {
                const uint8_t* tok = src.data() + fixed + (size_t)t * BYTES_PER_TOKEN;
                std::memcpy(fp16_flat.data() + (size_t)t * VECS_PER_TOKEN * DIMS,
                            tok, VECS_PER_TOKEN * BYTES_FP16_VEC);
            }

            bool gpu_ok = false;
            if (scheme == Scheme::PQ8) {
                std::vector<int8_t>   i8_flat(total_vecs * DIMS);
                std::vector<uint16_t> norm_flat(total_vecs);
                gpu_ok = vkq.encodePQ8(fp16_flat.data(), total_vecs,
                                       i8_flat.data(), norm_flat.data());
                if (gpu_ok) {
                    for (uint32_t t = 0; t < n; t++) {
                        const uint8_t* tok = src.data() + fixed + (size_t)t * BYTES_PER_TOKEN;
                        for (uint32_t v = 0; v < VECS_PER_TOKEN; v++) {
                            uint32_t idx = t * VECS_PER_TOKEN + v;
                            uint16_t norm16 = norm_flat[idx];
                            const int8_t* i8p = i8_flat.data() + (size_t)idx * DIMS;
                            *(uint16_t*)wp = norm16; wp += 2;
                            std::memcpy(wp, i8p, DIMS); wp += DIMS;
                            const uint16_t* fp16 = (const uint16_t*)(tok + v * BYTES_FP16_VEC);
                            decode_pq8(i8p, rec, fp16_to_f32(norm16));
                            accumulate_error(fp16, rec, st.max_err, st.sum_sq, st.n_vals);
                        }
                        const uint8_t* pad = tok + VECS_PER_TOKEN * BYTES_FP16_VEC;
                        std::copy(pad, pad + PADDING, wp); wp += PADDING;
                    }
                }
            } else if (scheme == Scheme::Q8) {
                std::vector<int8_t> i8_flat(total_vecs * DIMS);
                std::vector<float>  scale_flat(total_vecs);
                gpu_ok = vkq.encodeQ8(fp16_flat.data(), total_vecs,
                                      i8_flat.data(), scale_flat.data());
                if (gpu_ok) {
                    for (uint32_t t = 0; t < n; t++) {
                        const uint8_t* tok = src.data() + fixed + (size_t)t * BYTES_PER_TOKEN;
                        for (uint32_t v = 0; v < VECS_PER_TOKEN; v++) {
                            uint32_t idx = t * VECS_PER_TOKEN + v;
                            float scale = scale_flat[idx];
                            const int8_t* i8p = i8_flat.data() + (size_t)idx * DIMS;
                            *(float*)wp = scale; wp += 4;
                            std::memcpy(wp, i8p, DIMS); wp += DIMS;
                            const uint16_t* fp16 = (const uint16_t*)(tok + v * BYTES_FP16_VEC);
                            decode_q8(i8p, rec, scale);
                            accumulate_error(fp16, rec, st.max_err, st.sum_sq, st.n_vals);
                        }
                        const uint8_t* pad = tok + VECS_PER_TOKEN * BYTES_FP16_VEC;
                        std::copy(pad, pad + PADDING, wp); wp += PADDING;
                    }
                }
            } else { // PQ4
                std::vector<uint8_t>  packed_flat(total_vecs * DIMS / 2);
                std::vector<uint16_t> norm_flat(total_vecs);
                gpu_ok = vkq.encodePQ4(fp16_flat.data(), total_vecs,
                                       packed_flat.data(), norm_flat.data());
                if (gpu_ok) {
                    for (uint32_t t = 0; t < n; t++) {
                        const uint8_t* tok = src.data() + fixed + (size_t)t * BYTES_PER_TOKEN;
                        for (uint32_t v = 0; v < VECS_PER_TOKEN; v++) {
                            uint32_t idx = t * VECS_PER_TOKEN + v;
                            uint16_t norm16 = norm_flat[idx];
                            const uint8_t* pkd = packed_flat.data() + (size_t)idx * (DIMS/2);
                            *(uint16_t*)wp = norm16; wp += 2;
                            std::memcpy(wp, pkd, DIMS/2); wp += DIMS/2;
                            const uint16_t* fp16 = (const uint16_t*)(tok + v * BYTES_FP16_VEC);
                            decode_pq4(pkd, rec, fp16_to_f32(norm16));
                            accumulate_error(fp16, rec, st.max_err, st.sum_sq, st.n_vals);
                        }
                        const uint8_t* pad = tok + VECS_PER_TOKEN * BYTES_FP16_VEC;
                        std::copy(pad, pad + PADDING, wp); wp += PADDING;
                    }
                }
            }
            used_gpu = gpu_ok;
        }
    }
#endif

    if (!used_gpu) {
        // NEON / scalar path for Q8, PQ4, and PQ8 fallback
        for (uint32_t t = 0; t < n; t++) {
            const uint8_t* tok = src.data() + fixed + (size_t)t * BYTES_PER_TOKEN;

            for (uint32_t v = 0; v < VECS_PER_TOKEN; v++) {
                const uint16_t* fp16 = (const uint16_t*)(tok + v * BYTES_FP16_VEC);

                if (scheme == Scheme::Q8) {
                    float scale; int8_t i8[DIMS];
                    encode_q8(fp16, i8, &scale);
                    *(float*)wp = scale; wp += 4;
                    std::copy(i8, i8 + DIMS, (int8_t*)wp); wp += DIMS;
                    decode_q8(i8, rec, scale);
                } else if (scheme == Scheme::PQ8) {
                    uint16_t norm16; int8_t i8[DIMS];
                    encode_pq8(fp16, i8, &norm16);
                    *(uint16_t*)wp = norm16; wp += 2;
                    std::copy(i8, i8 + DIMS, (int8_t*)wp); wp += DIMS;
                    decode_pq8(i8, rec, fp16_to_f32(norm16));
                } else { // PQ4
                    uint16_t norm16; uint8_t packed[DIMS/2];
                    encode_pq4(fp16, packed, &norm16);
                    *(uint16_t*)wp = norm16; wp += 2;
                    std::copy(packed, packed + DIMS/2, wp); wp += DIMS/2;
                    decode_pq4(packed, rec, fp16_to_f32(norm16));
                }
                accumulate_error(fp16, rec, st.max_err, st.sum_sq, st.n_vals);
            }
            // Padding verbatim
            const uint8_t* pad = tok + VECS_PER_TOKEN * BYTES_FP16_VEC;
            std::copy(pad, pad + PADDING, wp); wp += PADDING;
        }
    }

    st.n_tokens = n; st.fixed = fixed;
    st.src_bytes = src.size(); st.dst_bytes = dst.size();
    st.used_gpu = used_gpu;
    return dst;
}

static std::vector<uint8_t> decode_file(const std::vector<uint8_t>& src) {
    uint32_t magic = *(const uint32_t*)src.data();
    Scheme scheme;
    if      (magic == MAGIC_Q8)  scheme = Scheme::Q8;
    else if (magic == MAGIC_PQ8) scheme = Scheme::PQ8;
    else if (magic == MAGIC_PQ4) scheme = Scheme::PQ4;
    else throw std::runtime_error("Unrecognised cache magic: " + std::to_string(magic));

    uint32_t fixed = *(const uint32_t*)(src.data() + 4);
    uint32_t n     = *(const uint32_t*)(src.data() + 8);

    std::vector<uint8_t> dst(fixed + (size_t)BYTES_PER_TOKEN * n, 0);
    std::copy(src.begin(), src.begin() + fixed, dst.begin());
    *(uint32_t*)(dst.data() + 0) = H0_ORIGINAL;
    *(uint32_t*)(dst.data() + 4) = H1_KV_HEADS;

    const uint8_t* rp = src.data() + fixed;

    for (uint32_t t = 0; t < n; t++) {
        uint8_t* tok = dst.data() + fixed + (size_t)t * BYTES_PER_TOKEN;

        for (uint32_t v = 0; v < VECS_PER_TOKEN; v++) {
            uint16_t* fp16 = (uint16_t*)(tok + v * BYTES_FP16_VEC);

            if (scheme == Scheme::Q8) {
                float scale = *(const float*)rp; rp += 4;
                decode_q8((const int8_t*)rp, fp16, scale); rp += DIMS;
            } else if (scheme == Scheme::PQ8) {
                float norm = fp16_to_f32(*(const uint16_t*)rp); rp += 2;
                decode_pq8((const int8_t*)rp, fp16, norm); rp += DIMS;
            } else {
                float norm = fp16_to_f32(*(const uint16_t*)rp); rp += 2;
                decode_pq4(rp, fp16, norm); rp += DIMS/2;
            }
        }
        uint8_t* pad = tok + VECS_PER_TOKEN * BYTES_FP16_VEC;
        std::copy(rp, rp + PADDING, pad); rp += PADDING;
    }
    return dst;
}

// ── AsyncWorker templates ──────────────────────────────────────────────────
class EncodeWorker : public Napi::AsyncWorker {
public:
    EncodeWorker(Napi::Env env, Napi::Promise::Deferred def,
                 std::string src, std::string dst, Scheme scheme)
        : Napi::AsyncWorker(env), def_(def),
          src_path_(std::move(src)), dst_path_(std::move(dst)), scheme_(scheme) {}

    void Execute() override {
        auto src = read_file(src_path_);
        auto dst = encode_file(src, scheme_, stats_);
        write_file(dst_path_, dst);
    }
    void OnOK() override {
        Napi::Env env = Env();
        auto r = Napi::Object::New(env);
        r.Set("n_tokens",      (double)stats_.n_tokens);
        r.Set("src_bytes",     (double)stats_.src_bytes);
        r.Set("dst_bytes",     (double)stats_.dst_bytes);
        r.Set("reduction_pct", (1.0 - (double)stats_.dst_bytes / stats_.src_bytes) * 100.0);
        r.Set("max_abs_err",   (double)stats_.max_err);
        r.Set("rmse",          stats_.n_vals ? std::sqrt(stats_.sum_sq / stats_.n_vals) : 0.0);
        r.Set("neon",          (bool)HAS_NEON);
        r.Set("gpu",           stats_.used_gpu);
        r.Set("scheme",        std::string(scheme_ == Scheme::Q8  ? "q8"  :
                                           scheme_ == Scheme::PQ8 ? "pq8" : "pq4"));
        def_.Resolve(r);
    }
    void OnError(const Napi::Error& e) override { def_.Reject(e.Value()); }
private:
    Napi::Promise::Deferred def_;
    std::string src_path_, dst_path_;
    Scheme scheme_;
    EncodeStats stats_;
};

class DecodeWorker : public Napi::AsyncWorker {
public:
    DecodeWorker(Napi::Env env, Napi::Promise::Deferred def,
                 std::string src, std::string dst)
        : Napi::AsyncWorker(env), def_(def),
          src_path_(std::move(src)), dst_path_(std::move(dst)) {}

    void Execute() override {
        auto src = read_file(src_path_);
        src_bytes_ = src.size();
        auto dst = decode_file(src);
        dst_bytes_ = dst.size();
        magic_     = *(const uint32_t*)src.data();
        n_tokens_  = *(const uint32_t*)(src.data() + 8);
        write_file(dst_path_, dst);
    }
    void OnOK() override {
        Napi::Env env = Env();
        auto r = Napi::Object::New(env);
        r.Set("n_tokens",  (double)n_tokens_);
        r.Set("src_bytes", (double)src_bytes_);
        r.Set("dst_bytes", (double)dst_bytes_);
        r.Set("neon",      (bool)HAS_NEON);
        r.Set("scheme",    std::string(magic_ == MAGIC_Q8  ? "q8"  :
                                       magic_ == MAGIC_PQ8 ? "pq8" : "pq4"));
        def_.Resolve(r);
    }
    void OnError(const Napi::Error& e) override { def_.Reject(e.Value()); }
private:
    Napi::Promise::Deferred def_;
    std::string src_path_, dst_path_;
    size_t src_bytes_ = 0, dst_bytes_ = 0;
    uint32_t magic_ = 0, n_tokens_ = 0;
};

// ── N-API exports ──────────────────────────────────────────────────────────
static Napi::Value make_encode(const Napi::CallbackInfo& info, Scheme s) {
    auto def = Napi::Promise::Deferred::New(info.Env());
    (new EncodeWorker(info.Env(), def,
        info[0].As<Napi::String>(), info[1].As<Napi::String>(), s))->Queue();
    return def.Promise();
}

static Napi::Value JsQuantize(const Napi::CallbackInfo& i)       { return make_encode(i, Scheme::Q8);  }
static Napi::Value JsQuantizePolar8(const Napi::CallbackInfo& i)  { return make_encode(i, Scheme::PQ8); }
static Napi::Value JsQuantizePolar4(const Napi::CallbackInfo& i)  { return make_encode(i, Scheme::PQ4); }

static Napi::Value JsDequantize(const Napi::CallbackInfo& info) {
    auto def = Napi::Promise::Deferred::New(info.Env());
    (new DecodeWorker(info.Env(), def,
        info[0].As<Napi::String>(), info[1].As<Napi::String>()))->Queue();
    return def.Promise();
}

Napi::Object InitKVCacheQuant(Napi::Env env, Napi::Object exports) {
    exports.Set("quantize",       Napi::Function::New(env, JsQuantize));
    exports.Set("quantizePolar8", Napi::Function::New(env, JsQuantizePolar8));
    exports.Set("quantizePolar4", Napi::Function::New(env, JsQuantizePolar4));
    exports.Set("dequantize",     Napi::Function::New(env, JsDequantize));
    return exports;
}

NODE_API_MODULE(kvcache_quant_napi, InitKVCacheQuant)
