// KV cache INT8 quantisation/dequantisation — N-API addon with ARM NEON SIMD.
//
// Both quantize() and dequantize() return Promises resolved on the libuv
// thread pool so the Node.js event loop is never blocked.
//
// ARM NEON path (aarch64): uses float16x8_t / int8x16_t intrinsics.
// Portable fallback: plain C++ scalar loops (used in CI / macOS dev).

#include <napi.h>
#include <fstream>
#include <vector>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <algorithm>

#ifdef __aarch64__
#include <arm_neon.h>
#define HAS_NEON 1
#else
#define HAS_NEON 0
#endif

// ── Constants (confirmed empirically for Qwen3-4B / RKLLM v1.2.3) ─────────
static constexpr uint32_t BYTES_PER_TOKEN  = 147472; // 2*36*8*128*2 + 16 pad
static constexpr uint32_t DIMS             = 128;
static constexpr uint32_t BYTES_FP16_VEC   = DIMS * 2;
static constexpr uint32_t PADDING          = 16;
static constexpr uint32_t VECS_PER_TOKEN   = (BYTES_PER_TOKEN - PADDING) / BYTES_FP16_VEC; // 576
static constexpr uint32_t Q8_VEC_BYTES     = 4 + DIMS;  // FP32 scale + 128 INT8
static constexpr uint32_t Q8_TOKEN_BYTES   = VECS_PER_TOKEN * Q8_VEC_BYTES + PADDING;
static constexpr uint32_t MAGIC            = 0xAA55AA55;
static constexpr uint32_t H0_ORIGINAL      = 43;
static constexpr uint32_t H1_KV_HEADS      = 8;
static constexpr uint32_t FIXED_OVERHEAD_MIN = 600000;
static constexpr uint32_t FIXED_OVERHEAD_MAX = 640000;

// ── Portable scalar FP16 helpers ───────────────────────────────────────────
static inline float fp16_to_f32(uint16_t h) {
    uint32_t s = (h >> 15) & 1u;
    uint32_t e = (h >> 10) & 0x1fu;
    uint32_t m = h & 0x3ffu;
    if (e == 0)  return (s ? -1.f : 1.f) * (m / 1024.f) * 1.f / (1 << 14);
    if (e == 31) return m == 0 ? (s ? -INFINITY : INFINITY) : NAN;
    float v = (1.f + m / 1024.f);
    int exp = (int)e - 15;
    return (s ? -1.f : 1.f) * std::ldexp(v, exp);
}

static inline uint16_t f32_to_fp16(float f) {
    if (std::isnan(f))    return 0x7e00u;
    if (!std::isfinite(f)) return f > 0 ? 0x7c00u : 0xfc00u;
    uint32_t s = (f < 0) ? 1u : 0u;
    f = std::abs(f);
    if (f == 0.f) return (uint16_t)(s << 15);
    int exp; float mant = std::frexp(f, &exp);
    // frexp: f = mant * 2^exp, 0.5 <= mant < 1.0
    // FP16 form: (1 + frac) * 2^(e-15), so mant = 0.5*(1+frac), exp_fp16 = exp+14
    int e16 = exp + 14;
    if (e16 >= 31) return (uint16_t)((s << 15) | 0x7c00u); // overflow → inf
    uint32_t frac;
    if (e16 <= 0) {
        // subnormal
        frac = (uint32_t)std::round(mant * (1 << (e16 + 10)));
        e16 = 0;
    } else {
        frac = (uint32_t)std::round((mant * 2.f - 1.f) * 1024.f);
        if (frac >= 1024) { frac = 0; e16++; }
        if (e16 >= 31) return (uint16_t)((s << 15) | 0x7c00u);
    }
    return (uint16_t)((s << 15) | ((uint32_t)e16 << 10) | frac);
}

// ── SIMD vector quantise: 128 FP16 → scale + 128 INT8 ─────────────────────
// All arithmetic is done in FP32 to avoid requiring the ARMv8.2-A FP16
// arithmetic extension. Only FP16 load/store + FCVT are used (base AArch64).
static void quantize_vec(const uint16_t* __restrict__ fp16,
                          int8_t* __restrict__ out_i8,
                          float*               out_scale) {
#if HAS_NEON
    // Pass 1: load FP16, convert to FP32, find max abs — 8 FP16 per iteration
    float32x4_t maxabs = vdupq_n_f32(0.f);
    for (int i = 0; i < DIMS; i += 8) {
        float16x8_t v8  = vld1q_f16((const __fp16*)(fp16 + i));
        float32x4_t lo  = vabsq_f32(vcvt_f32_f16(vget_low_f16(v8)));
        float32x4_t hi  = vabsq_f32(vcvt_f32_f16(vget_high_f16(v8)));
        maxabs = vmaxq_f32(maxabs, vmaxq_f32(lo, hi));
    }
    // FP32 horizontal max: 4→2→1
    float32x2_t m2 = vpmax_f32(vget_low_f32(maxabs), vget_high_f32(maxabs));
    m2 = vpmax_f32(m2, m2);
    float max_val = vget_lane_f32(m2, 0);

    float scale     = (max_val == 0.f) ? 1.f : max_val / 127.f;
    *out_scale      = scale;
    float32x4_t inv4 = vdupq_n_f32(1.f / scale);

    // Pass 2: load FP16, convert FP32, scale, round, saturate → INT8
    for (int i = 0; i < DIMS; i += 8) {
        float16x8_t v8 = vld1q_f16((const __fp16*)(fp16 + i));
        float32x4_t lo  = vmulq_f32(vcvt_f32_f16(vget_low_f16(v8)),  inv4);
        float32x4_t hi  = vmulq_f32(vcvt_f32_f16(vget_high_f16(v8)), inv4);
        int32x4_t  ilo  = vcvtnq_s32_f32(lo);
        int32x4_t  ihi  = vcvtnq_s32_f32(hi);
        int16x8_t  i16  = vcombine_s16(vqmovn_s32(ilo), vqmovn_s32(ihi));
        vst1_s8(out_i8 + i, vqmovn_s16(i16));
    }
#else
    float vals[DIMS], max_val = 0.f;
    for (int i = 0; i < DIMS; i++) {
        vals[i] = fp16_to_f32(fp16[i]);
        float a = std::abs(vals[i]);
        if (a > max_val) max_val = a;
    }
    float scale = (max_val == 0.f) ? 1.f : max_val / 127.f;
    *out_scale  = scale;
    for (int i = 0; i < DIMS; i++)
        out_i8[i] = (int8_t)std::max(-127, std::min(127, (int)std::round(vals[i] / scale)));
#endif
}

// ── SIMD vector dequantise: scale + 128 INT8 → 128 FP16 ───────────────────
static void dequantize_vec(const int8_t* __restrict__ in_i8,
                            uint16_t* __restrict__     fp16,
                            float                      scale) {
#if HAS_NEON
    float32x4_t sc4 = vdupq_n_f32(scale);
    // 16 INT8 per iteration → 16 FP16
    for (int i = 0; i < DIMS; i += 16) {
        int8x16_t raw = vld1q_s8(in_i8 + i);

        // Low 8 bytes
        int16x8_t lo16 = vmovl_s8(vget_low_s8(raw));
        float32x4_t lo_lo = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_low_s16(lo16))),  sc4);
        float32x4_t lo_hi = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_high_s16(lo16))), sc4);
        vst1q_f16((__fp16*)(fp16 + i),
                  vcombine_f16(vcvt_f16_f32(lo_lo), vcvt_f16_f32(lo_hi)));

        // High 8 bytes
        int16x8_t hi16 = vmovl_s8(vget_high_s8(raw));
        float32x4_t hi_lo = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_low_s16(hi16))),  sc4);
        float32x4_t hi_hi = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_high_s16(hi16))), sc4);
        vst1q_f16((__fp16*)(fp16 + i + 8),
                  vcombine_f16(vcvt_f16_f32(hi_lo), vcvt_f16_f32(hi_hi)));
    }
#else
    for (int i = 0; i < DIMS; i++)
        fp16[i] = f32_to_fp16(in_i8[i] * scale);
#endif
}

// ── File I/O helpers ────────────────────────────────────────────────────────
static std::vector<uint8_t> read_file(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot open: " + path);
    f.seekg(0, std::ios::end);
    std::streamsize sz = f.tellg();
    f.seekg(0);
    std::vector<uint8_t> buf(sz);
    if (!f.read(reinterpret_cast<char*>(buf.data()), sz))
        throw std::runtime_error("Read error: " + path);
    return buf;
}

static void write_file(const std::string& path, const std::vector<uint8_t>& data) {
    std::ofstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot create: " + path);
    if (!f.write(reinterpret_cast<const char*>(data.data()), data.size()))
        throw std::runtime_error("Write error: " + path);
}

// ── AsyncWorker: Quantize ──────────────────────────────────────────────────
class QuantizeWorker : public Napi::AsyncWorker {
public:
    QuantizeWorker(Napi::Env env, Napi::Promise::Deferred def,
                   std::string src, std::string dst)
        : Napi::AsyncWorker(env), def_(def),
          src_path_(std::move(src)), dst_path_(std::move(dst)) {}

    void Execute() override {
        auto src = read_file(src_path_);
        src_bytes_ = src.size();
        if (src.size() < 12) throw std::runtime_error("File too small");

        n_tokens_ = *(const uint32_t*)(src.data() + 8);
        uint64_t kv = src.size() - (uint64_t)BYTES_PER_TOKEN * n_tokens_;
        if (kv < FIXED_OVERHEAD_MIN || kv > FIXED_OVERHEAD_MAX)
            throw std::runtime_error("Implausible fixed overhead: " + std::to_string(kv));
        fixed_ = (uint32_t)kv;

        std::vector<uint8_t> dst(fixed_ + (size_t)Q8_TOKEN_BYTES * n_tokens_);
        std::copy(src.begin(), src.begin() + fixed_, dst.begin());
        *(uint32_t*)(dst.data() + 0) = MAGIC;
        *(uint32_t*)(dst.data() + 4) = fixed_;

        uint8_t* wp = dst.data() + fixed_;
        double sum_sq = 0; float max_err = 0; size_t nv = 0;

        for (uint32_t t = 0; t < n_tokens_; t++) {
            const uint8_t* tok = src.data() + fixed_ + (size_t)t * BYTES_PER_TOKEN;

            for (uint32_t v = 0; v < VECS_PER_TOKEN; v++) {
                const uint16_t* fp16 = (const uint16_t*)(tok + v * BYTES_FP16_VEC);
                float  scale;
                int8_t i8buf[DIMS];

                quantize_vec(fp16, i8buf, &scale);
                *(float*)wp = scale; wp += 4;

                for (int d = 0; d < DIMS; d++) {
                    float orig = fp16_to_f32(fp16[d]);
                    float err  = std::abs(orig - (float)i8buf[d] * scale);
                    if (err > max_err) max_err = err;
                    sum_sq += err * err; nv++;
                    *wp++ = (uint8_t)i8buf[d];
                }
            }
            // Padding verbatim
            const uint8_t* pad = tok + VECS_PER_TOKEN * BYTES_FP16_VEC;
            std::copy(pad, pad + PADDING, wp); wp += PADDING;
        }

        dst_bytes_ = dst.size();
        max_err_ = max_err;
        rmse_ = (nv > 0) ? std::sqrt(sum_sq / nv) : 0.f;
        write_file(dst_path_, dst);
    }

    void OnOK() override {
        Napi::Env env = Env();
        auto r = Napi::Object::New(env);
        r.Set("n_tokens",      (double)n_tokens_);
        r.Set("src_bytes",     (double)src_bytes_);
        r.Set("dst_bytes",     (double)dst_bytes_);
        r.Set("reduction_pct", (1.0 - (double)dst_bytes_ / src_bytes_) * 100.0);
        r.Set("max_abs_err",   (double)max_err_);
        r.Set("rmse",          (double)rmse_);
        r.Set("neon",          (bool)HAS_NEON);
        def_.Resolve(r);
    }
    void OnError(const Napi::Error& e) override { def_.Reject(e.Value()); }

private:
    Napi::Promise::Deferred def_;
    std::string src_path_, dst_path_;
    uint32_t n_tokens_ = 0, fixed_ = 0;
    size_t src_bytes_ = 0, dst_bytes_ = 0;
    float max_err_ = 0, rmse_ = 0;
};

// ── AsyncWorker: Dequantize ────────────────────────────────────────────────
class DequantizeWorker : public Napi::AsyncWorker {
public:
    DequantizeWorker(Napi::Env env, Napi::Promise::Deferred def,
                     std::string src, std::string dst)
        : Napi::AsyncWorker(env), def_(def),
          src_path_(std::move(src)), dst_path_(std::move(dst)) {}

    void Execute() override {
        auto src = read_file(src_path_);
        src_bytes_ = src.size();
        if (*(const uint32_t*)src.data() != MAGIC)
            throw std::runtime_error("Not a .q8cache file (bad magic)");

        uint32_t fixed   = *(const uint32_t*)(src.data() + 4);
        uint32_t n       = *(const uint32_t*)(src.data() + 8);
        n_tokens_ = n; fixed_ = fixed;

        std::vector<uint8_t> dst(fixed + (size_t)BYTES_PER_TOKEN * n, 0);
        std::copy(src.begin(), src.begin() + fixed, dst.begin());
        *(uint32_t*)(dst.data() + 0) = H0_ORIGINAL;
        *(uint32_t*)(dst.data() + 4) = H1_KV_HEADS;

        const uint8_t* rp = src.data() + fixed;

        for (uint32_t t = 0; t < n; t++) {
            uint8_t* tok = dst.data() + fixed + (size_t)t * BYTES_PER_TOKEN;

            for (uint32_t v = 0; v < VECS_PER_TOKEN; v++) {
                float scale         = *(const float*)rp; rp += 4;
                const int8_t* i8p   = (const int8_t*)rp; rp += DIMS;
                uint16_t* fp16p     = (uint16_t*)(tok + v * BYTES_FP16_VEC);
                dequantize_vec(i8p, fp16p, scale);
            }
            // Padding verbatim
            uint8_t* pad = tok + VECS_PER_TOKEN * BYTES_FP16_VEC;
            std::copy(rp, rp + PADDING, pad); rp += PADDING;
        }

        dst_bytes_ = dst.size();
        write_file(dst_path_, dst);
    }

    void OnOK() override {
        Napi::Env env = Env();
        auto r = Napi::Object::New(env);
        r.Set("n_tokens",       (double)n_tokens_);
        r.Set("fixed_overhead", (double)fixed_);
        r.Set("src_bytes",      (double)src_bytes_);
        r.Set("dst_bytes",      (double)dst_bytes_);
        r.Set("neon",           (bool)HAS_NEON);
        def_.Resolve(r);
    }
    void OnError(const Napi::Error& e) override { def_.Reject(e.Value()); }

private:
    Napi::Promise::Deferred def_;
    std::string src_path_, dst_path_;
    uint32_t n_tokens_ = 0, fixed_ = 0;
    size_t src_bytes_ = 0, dst_bytes_ = 0;
};

// ── N-API entry points ─────────────────────────────────────────────────────
static Napi::Value JsQuantize(const Napi::CallbackInfo& info) {
    auto def = Napi::Promise::Deferred::New(info.Env());
    (new QuantizeWorker(info.Env(), def,
        info[0].As<Napi::String>(), info[1].As<Napi::String>()))->Queue();
    return def.Promise();
}

static Napi::Value JsDequantize(const Napi::CallbackInfo& info) {
    auto def = Napi::Promise::Deferred::New(info.Env());
    (new DequantizeWorker(info.Env(), def,
        info[0].As<Napi::String>(), info[1].As<Napi::String>()))->Queue();
    return def.Promise();
}

Napi::Object InitKVCacheQuant(Napi::Env env, Napi::Object exports) {
    exports.Set("quantize",   Napi::Function::New(env, JsQuantize));
    exports.Set("dequantize", Napi::Function::New(env, JsDequantize));
    return exports;
}

NODE_API_MODULE(kvcache_quant_napi, InitKVCacheQuant)
