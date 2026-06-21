/*
 * orkllm_llama_napi.cpp — llama.cpp N-API backend for oRKLLM.
 *
 * Mirrors the orkllm_napi.cpp rkllm backend exactly: same exported methods
 * (load_library / init_model / run / unload_model / abort_inference / clear_kv_cache),
 * same chunk shape emitted to JS, same ThreadSafeFunction streaming approach.
 *
 * dlopen's libllama.so (built from llama.cpp-rockchip with -DGGML_ORK=ON) at
 * runtime — no compile-time link, so the addon builds fine without libllama
 * present (mismatch → dlopen failure → pool falls back to MockEngine on dev).
 */
#include <napi.h>
#include <thread>
#include <atomic>
#include <string>
#include <vector>
#include <cstring>

#ifdef _WIN32
#include <windows.h>
#define DYNLIB_HANDLE HMODULE
#define DYNLIB_LOAD(p) LoadLibraryA(p)
#define DYNLIB_GETSYM(h,n) GetProcAddress(h,n)
#define DYNLIB_FREE(h) FreeLibrary(h)
#else
#include <dlfcn.h>
#define DYNLIB_HANDLE void*
#define DYNLIB_LOAD(p) dlopen(p, RTLD_LAZY|RTLD_LOCAL)
#define DYNLIB_GETSYM(h,n) dlsym(h,n)
#define DYNLIB_FREE(h) dlclose(h)
#endif

// ── Minimal llama.cpp C API (subset we need) ──────────────────────────────────
// We dlsym these from libllama.so; no compile-time link required. Types must
// match llama.h exactly for the version we build against.

typedef int32_t llama_token;
typedef int32_t llama_pos;
typedef int32_t llama_seq_id;

struct llama_model;
struct llama_context;
struct llama_sampler;
struct llama_vocab;

// Struct layout verified against llama.cpp include/llama.h.
// Must be kept in sync with that header to avoid ABI mismatches when calling
// llama_model_default_params / llama_context_default_params by value.
struct llama_model_params {
    void * devices;
    const void * tensor_buft_overrides;

    int32_t n_gpu_layers;
    int32_t split_mode;

    int32_t main_gpu;
    const float * tensor_split;

    bool (*progress_callback)(float progress, void * user_data);
    void * progress_callback_user_data;

    const void * kv_overrides;

    bool vocab_only;
    bool use_mmap;
    bool use_direct_io;
    bool use_mlock;
    bool check_tensors;
    bool use_extra_bufts;
    bool no_host;
    bool no_alloc;
};

struct llama_context_params {
    uint32_t n_ctx;
    uint32_t n_batch;
    uint32_t n_ubatch;
    uint32_t n_seq_max;
    uint32_t n_rs_seq;
    uint32_t n_outputs_max;
    int32_t  n_threads;
    int32_t  n_threads_batch;

    int32_t  ctx_type;
    int32_t  rope_scaling_type;
    int32_t  pooling_type;
    int32_t  attention_type;
    int32_t  flash_attn_type;

    float    rope_freq_base;
    float    rope_freq_scale;
    float    yarn_ext_factor;
    float    yarn_attn_factor;
    float    yarn_beta_fast;
    float    yarn_beta_slow;
    uint32_t yarn_orig_ctx;
    float    defrag_thold;

    void * cb_eval;
    void * cb_eval_user_data;

    int32_t  type_k;
    int32_t  type_v;

    void * abort_callback;
    void * abort_callback_data;

    bool embeddings;
    bool offload_kqv;
    bool no_perf;
    bool op_offload;
    bool swa_full;
    bool kv_unified;

    void * samplers;
    size_t n_samplers;
    struct llama_context * ctx_other;
};

struct llama_batch {
    int32_t  n_tokens;
    llama_token  *token;
    float       *embd;
    llama_pos   *pos;
    int32_t     *n_seq_id;
    llama_seq_id **seq_id;
    int8_t      *logits;
};

// Function pointer typedefs (subset)
typedef void     (*llama_backend_init_t)(void);
typedef void     (*llama_backend_free_t)(void);
typedef struct llama_model_params (*llama_model_default_params_t)(void);
typedef struct llama_context_params (*llama_context_default_params_t)(void);
typedef struct llama_model * (*llama_model_load_from_file_t)(const char *, struct llama_model_params);
typedef void     (*llama_model_free_t)(struct llama_model *);
typedef struct llama_context * (*llama_init_from_model_t)(struct llama_model *, struct llama_context_params);
typedef void     (*llama_free_t)(struct llama_context *);
typedef const struct llama_vocab * (*llama_model_get_vocab_t)(const struct llama_model *);
typedef int32_t  (*llama_vocab_n_tokens_t)(const struct llama_vocab *);
typedef int32_t  (*llama_tokenize_t)(const struct llama_vocab *, const char *, int32_t, llama_token *, int32_t, bool, bool);
typedef int32_t  (*llama_token_to_piece_t)(const struct llama_vocab *, llama_token, char *, int32_t, int32_t, bool);
typedef struct llama_batch (*llama_batch_get_one_t)(llama_token *, int32_t);
typedef int32_t  (*llama_decode_t)(struct llama_context *, struct llama_batch);
// Chat templating (ABI pinned to llama.cpp b9659-ork). Lets the gguf path apply
// a model's OWN chat template (e.g. LFM2's <|startoftext|>) instead of oRKLLM's
// hardcoded ChatML — which only suits ChatML-family models like Qwen.
struct llama_chat_message { const char * role; const char * content; };
typedef int32_t (*llama_chat_apply_template_t)(const char *, const struct llama_chat_message *, size_t, bool, char *, int32_t);
typedef const char * (*llama_model_chat_template_t)(const struct llama_model *, const char *);
typedef void     (*llama_kv_self_clear_t)(struct llama_context *);
// Full memory reset (clears KV AND the recurrent/hybrid memory module — LFM2 &
// other Mamba/Gated-Delta-Net models retain recurrent state that kv_self_clear
// alone doesn't reset, leaving the context polluted after the first generation).
typedef struct llama_memory_i * llama_memory_t;
typedef llama_memory_t (*llama_get_memory_t)(const struct llama_context *);
typedef void (*llama_memory_clear_t)(llama_memory_t, bool);
typedef bool (*llama_memory_seq_rm_t)(llama_memory_t, llama_seq_id, llama_pos, llama_pos);
typedef bool     (*llama_state_seq_save_file_t)(struct llama_context *, const char *, llama_seq_id, const llama_token *, size_t);
typedef size_t   (*llama_state_seq_load_file_t)(struct llama_context *, const char *, llama_seq_id, llama_token *, size_t, size_t *);
struct llama_sampler_chain_params {
    bool no_perf;   // whether to measure performance timings
};
typedef struct llama_sampler * (*llama_sampler_chain_init_t)(struct llama_sampler_chain_params);
typedef struct llama_sampler_chain_params (*llama_sampler_chain_default_params_t)(void);
typedef void     (*llama_sampler_chain_add_t)(struct llama_sampler *, struct llama_sampler *);
typedef struct llama_sampler * (*llama_sampler_init_top_k_t)(int32_t);
typedef struct llama_sampler * (*llama_sampler_init_top_p_t)(float, size_t);
typedef struct llama_sampler * (*llama_sampler_init_temp_t)(float);
typedef struct llama_sampler * (*llama_sampler_init_dist_t)(uint32_t);
// Signatures pinned to the runtime's llama.cpp (commit 8a72f666, the modern
// 4-arg penalties form — older builds also took n_vocab + special-token ids).
typedef struct llama_sampler * (*llama_sampler_init_penalties_t)(int32_t, float, float, float);
typedef struct llama_sampler * (*llama_sampler_init_min_p_t)(float, size_t);
typedef struct llama_sampler * (*llama_sampler_init_mirostat_v2_t)(uint32_t, float, float);
typedef llama_token (*llama_sampler_sample_t)(struct llama_sampler *, struct llama_context *, int32_t);
typedef void     (*llama_sampler_free_t)(struct llama_sampler *);
typedef bool     (*llama_token_is_eog_t)(const struct llama_vocab *, llama_token);
typedef int32_t  (*llama_n_ctx_t)(const struct llama_context *);
typedef int32_t  (*llama_kv_self_used_cells_t)(const struct llama_context *);
typedef void     (*llama_sampler_accept_t)(struct llama_sampler *, llama_token);
typedef int32_t  (*llama_model_n_embd_t)(const struct llama_model *);
typedef float *  (*llama_get_logits_ith_t)(struct llama_context *, int32_t);
typedef float *  (*llama_get_embeddings_ith_t)(struct llama_context *, int32_t);
typedef struct llama_batch (*llama_batch_init_t)(int32_t, int32_t, int32_t);
typedef void (*llama_batch_free_t)(struct llama_batch);
// ── Global state ──────────────────────────────────────────────────────────────
static DYNLIB_HANDLE g_lib = nullptr;
static struct llama_model        *g_model   = nullptr;
static const struct llama_vocab  *g_vocab   = nullptr;
// llama.cpp interprets this seed as "pick a fresh random seed per run", so
// generations actually vary at temperature > 0 (a fixed seed made identical
// prompts always produce identical output).
static const uint32_t LLAMA_RANDOM_SEED = 0xFFFFFFFFu;
static struct llama_context      *g_ctx     = nullptr;
static struct llama_sampler      *g_sampler = nullptr;
static std::atomic<bool>          g_abort{false};

// Abort callback wired into llama_context_params. llama_decode invokes this
// between graph splits, so setting g_abort interrupts an in-flight decode —
// crucially the PREFILL, which for a short prompt is a single blocking
// llama_decode call (g_abort is otherwise only checked between batches/tokens,
// so without this, Stop has no effect during a long prefill). Returns true=abort.
static bool ork_abort_cb(void * /*data*/) { return g_abort.load(); }

// Resolved function pointers
static llama_backend_init_t              fn_backend_init   = nullptr;
static llama_backend_free_t              fn_backend_free   = nullptr;
static llama_model_default_params_t      fn_model_def_par  = nullptr;
static llama_context_default_params_t    fn_ctx_def_par    = nullptr;
static llama_model_load_from_file_t      fn_model_load     = nullptr;
static llama_model_free_t                fn_model_free     = nullptr;
static llama_init_from_model_t           fn_ctx_init       = nullptr;
static llama_free_t                      fn_ctx_free       = nullptr;
static llama_model_get_vocab_t           fn_get_vocab      = nullptr;
static llama_vocab_n_tokens_t            fn_n_vocab        = nullptr;
static llama_tokenize_t                  fn_tokenize       = nullptr;
static llama_token_to_piece_t            fn_tok2piece      = nullptr;
static llama_batch_get_one_t             fn_batch_one      = nullptr;
static llama_decode_t                    fn_decode         = nullptr;
static llama_kv_self_clear_t             fn_kv_clear       = nullptr;
static llama_get_memory_t                fn_get_memory     = nullptr;
static llama_memory_clear_t              fn_memory_clear   = nullptr;
static llama_memory_seq_rm_t             fn_memory_seq_rm  = nullptr;

// Fully reset the context's memory (KV + recurrent). Prefer llama_memory_clear
// (resets the recurrent/hybrid module too); fall back to kv_self_clear.
static void clearCtxMemory() {
  if (fn_get_memory && fn_memory_clear) fn_memory_clear(fn_get_memory(g_ctx), true);
  else if (fn_kv_clear) fn_kv_clear(g_ctx);
}
static llama_state_seq_save_file_t       fn_state_save     = nullptr;
static llama_state_seq_load_file_t       fn_state_load     = nullptr;
static llama_sampler_chain_init_t        fn_schain_init    = nullptr;
static llama_sampler_chain_default_params_t fn_schain_par  = nullptr;
static llama_sampler_chain_add_t         fn_schain_add     = nullptr;
static llama_sampler_init_top_k_t        fn_s_topk         = nullptr;
static llama_sampler_init_top_p_t        fn_s_topp         = nullptr;
static llama_sampler_init_temp_t         fn_s_temp         = nullptr;
static llama_sampler_init_dist_t         fn_s_dist         = nullptr;
static llama_sampler_init_penalties_t    fn_s_penalties    = nullptr;
static llama_sampler_init_min_p_t        fn_s_min_p        = nullptr;
static llama_sampler_init_mirostat_v2_t  fn_s_mirostat_v2  = nullptr;
static llama_chat_apply_template_t       fn_chat_apply     = nullptr;
static llama_model_chat_template_t       fn_model_tmpl     = nullptr;
static llama_sampler_sample_t            fn_sample         = nullptr;
static llama_sampler_accept_t            fn_samp_accept    = nullptr;
static llama_sampler_free_t              fn_samp_free      = nullptr;
static llama_token_is_eog_t              fn_is_eog         = nullptr;
static llama_n_ctx_t                     fn_n_ctx          = nullptr;
static llama_kv_self_used_cells_t        fn_kv_used        = nullptr;
// Optional ggml-vulkan API (newer runtimes): selectively scope the Vulkan backend
// to TurboQuant-only / prefill-only ops. nullptr on runtimes that predate it.
typedef void (*ggml_vk_set_mode_t)(int);
static ggml_vk_set_mode_t                fn_vk_set_mode    = nullptr;
static llama_model_n_embd_t              fn_n_embd         = nullptr;
static llama_get_logits_ith_t            fn_get_logits_ith = nullptr;
static llama_get_embeddings_ith_t        fn_get_embeddings_ith = nullptr;
static llama_batch_init_t                fn_batch_init     = nullptr;
static llama_batch_free_t                fn_batch_free     = nullptr;

#define LOAD_SYM(name) fn_##name = (decltype(fn_##name))DYNLIB_GETSYM(g_lib, "llama_" #name)
#define LOAD_SYM2(fn_name, sym) fn_##fn_name = (decltype(fn_##fn_name))DYNLIB_GETSYM(g_lib, sym)

struct RunContext {
    Napi::ThreadSafeFunction tsfn;
};

// ── N-API exported methods ────────────────────────────────────────────────────

Napi::Value LoadLibrary(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string path to libllama.so").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string libPath = info[0].As<Napi::String>().Utf8Value();

    if (g_lib) { DYNLIB_FREE(g_lib); g_lib = nullptr; }
    g_lib = DYNLIB_LOAD(libPath.c_str());
    if (!g_lib) return Napi::Boolean::New(env, false);

    LOAD_SYM2(backend_init,  "llama_backend_init");
    LOAD_SYM2(backend_free,  "llama_backend_free");
    LOAD_SYM2(model_def_par, "llama_model_default_params");
    LOAD_SYM2(ctx_def_par,   "llama_context_default_params");
    LOAD_SYM2(model_load,    "llama_model_load_from_file");
    LOAD_SYM2(model_free,    "llama_model_free");
    LOAD_SYM2(ctx_init,      "llama_init_from_model");
    LOAD_SYM2(ctx_free,      "llama_free");
    LOAD_SYM2(get_vocab,     "llama_model_get_vocab");
    LOAD_SYM2(n_vocab,       "llama_vocab_n_tokens");
    LOAD_SYM(tokenize);
    LOAD_SYM2(tok2piece,     "llama_token_to_piece");
    LOAD_SYM2(batch_one,     "llama_batch_get_one");
    LOAD_SYM(decode);
    LOAD_SYM2(kv_clear,      "llama_kv_self_clear");
    LOAD_SYM2(get_memory,    "llama_get_memory");
    LOAD_SYM2(memory_clear,  "llama_memory_clear");
    LOAD_SYM2(memory_seq_rm, "llama_memory_seq_rm");
    LOAD_SYM2(state_save,    "llama_state_seq_save_file");
    LOAD_SYM2(state_load,    "llama_state_seq_load_file");
    LOAD_SYM2(schain_init,   "llama_sampler_chain_init");
    LOAD_SYM2(schain_par,    "llama_sampler_chain_default_params");
    LOAD_SYM2(schain_add,    "llama_sampler_chain_add");
    LOAD_SYM2(s_topk,        "llama_sampler_init_top_k");
    LOAD_SYM2(s_topp,        "llama_sampler_init_top_p");
    LOAD_SYM2(s_temp,        "llama_sampler_init_temp");
    LOAD_SYM2(s_dist,        "llama_sampler_init_dist");
    // Optional samplers (nullptr if absent — guarded at use). Enable the model's
    // penalty / mirostat / min_p settings on the gguf path.
    LOAD_SYM2(s_penalties,   "llama_sampler_init_penalties");
    LOAD_SYM2(s_min_p,       "llama_sampler_init_min_p");
    LOAD_SYM2(s_mirostat_v2, "llama_sampler_init_mirostat_v2");
    LOAD_SYM2(chat_apply,    "llama_chat_apply_template");
    LOAD_SYM2(model_tmpl,    "llama_model_chat_template");
    LOAD_SYM2(sample,        "llama_sampler_sample");
    LOAD_SYM2(samp_accept,   "llama_sampler_accept");
    LOAD_SYM2(samp_free,     "llama_sampler_free");
    LOAD_SYM2(is_eog,        "llama_token_is_eog");
    LOAD_SYM2(n_ctx,         "llama_n_ctx");
    LOAD_SYM2(kv_used,       "llama_kv_self_used_cells");
    // Optional — present only on runtimes built with the selective-Vulkan API.
    fn_vk_set_mode = (ggml_vk_set_mode_t)DYNLIB_GETSYM(g_lib, "ggml_vk_set_mode");
    LOAD_SYM2(n_embd,        "llama_model_n_embd");
    LOAD_SYM2(get_logits_ith,"llama_get_logits_ith");
    LOAD_SYM2(get_embeddings_ith, "llama_get_embeddings_ith");
    LOAD_SYM2(batch_init,    "llama_batch_init");
    LOAD_SYM2(batch_free,    "llama_batch_free");

    if (!fn_backend_init || !fn_model_load || !fn_ctx_init || !fn_decode ||
        !fn_tokenize || !fn_tok2piece || !fn_sample || !fn_is_eog || !fn_batch_init || !fn_batch_free) {
        DYNLIB_FREE(g_lib); g_lib = nullptr;
        return Napi::Boolean::New(env, false);
    }

    fn_backend_init();
    return Napi::Boolean::New(env, true);
}

// Map a KV-cache-type option string to its ggml_type enum value. The TurboQuant
// types (WHT + polar codebook KV compression) are turbo2/3/4 = 42/43/44. Returns
// -1 for unknown → caller leaves the context default (f16). The asymmetric policy
// (K >= V precision; never lead with turbo K) is enforced upstream in oRKLLM.
static int kvTypeFromStr(const std::string& s) {
    if (s == "f16")    return 1;   // GGML_TYPE_F16
    if (s == "q4_0")   return 2;   // GGML_TYPE_Q4_0
    if (s == "q5_1")   return 7;   // GGML_TYPE_Q5_1
    if (s == "q8_0")   return 8;   // GGML_TYPE_Q8_0
    if (s == "turbo2") return 42;  // GGML_TYPE_TURBO2_0
    if (s == "turbo3") return 43;  // GGML_TYPE_TURBO3_0
    if (s == "turbo4") return 44;  // GGML_TYPE_TURBO4_0
    return -1;
}

Napi::Value InitModel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_lib) {
        Napi::Error::New(env, "Library not loaded").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "Expected (model_path, options)").ThrowAsJavaScriptException();
        return env.Null();
    }

    static std::string s_modelPath;
    s_modelPath = info[0].As<Napi::String>().Utf8Value();
    Napi::Object opts = info[1].As<Napi::Object>();

    // Unload any existing model first
    if (g_sampler) { fn_samp_free(g_sampler); g_sampler = nullptr; }
    if (g_ctx)     { fn_ctx_free(g_ctx);       g_ctx = nullptr; }
    if (g_model)   { fn_model_free(g_model);   g_model = nullptr; }
    g_vocab = nullptr;

    // Selective Vulkan mode (runtime API `ggml_vk_set_mode`; no-op if the runtime
    // predates it). Set BEFORE model load per the runtime's guidance: TURBOQUANT(1)
    // restricts Vulkan to TurboQuant KV ops (WHT + turbo types) so model layers
    // stay on the NPU and decode isn't corrupted; PREFILL(2) keeps only prefill
    // matmul on Vulkan; ALL(0)/default = everything on Vulkan.
    if (fn_vk_set_mode && opts.Has("vk_mode") && opts.Get("vk_mode").IsString()) {
        std::string m = opts.Get("vk_mode").As<Napi::String>().Utf8Value();
        int mode = (m == "turboquant") ? 1 : (m == "prefill") ? 2 : 0;
        fn_vk_set_mode(mode);
    }

    auto mpar = fn_model_def_par();
    // Default 999 (offload all to the GPU/NPU backend). With TurboQuant KV the
    // runtime's best practice is n_gpu_layers=0 — keep weights off Vulkan (no
    // per-decode CPY) while Vulkan handles only the KV ops — so the pool can set
    // this per-load.
    mpar.n_gpu_layers = opts.Has("n_gpu_layers") ? opts.Get("n_gpu_layers").As<Napi::Number>().Int32Value() : 999;
    // use_mmap: when layers are offloaded/packed to the NPU/GPU, the mmap'd GGUF
    // source is held in RAM *in addition to* the resident copy — a full duplicate
    // (the OOM logs showed ~22 GB file-rss of the mapped source alongside the
    // offloaded weights). Disabling mmap reads weights straight into the resident
    // buffers with no second copy. Pool defaults this to false for the gguf path.
    mpar.use_mmap = opts.Has("use_mmap") && opts.Get("use_mmap").IsBoolean()
                    ? opts.Get("use_mmap").As<Napi::Boolean>().Value() : true;

    g_model = fn_model_load(s_modelPath.c_str(), mpar);
    if (!g_model) return Napi::Number::New(env, -1);

    g_vocab = fn_get_vocab(g_model);

    auto cpar = fn_ctx_def_par();
    cpar.n_ctx     = opts.Has("max_context_len") ? (uint32_t)opts.Get("max_context_len").As<Napi::Number>().Int32Value() : 4096;
    cpar.n_batch   = 512;
    cpar.n_ubatch  = 512;
    cpar.n_threads = 4;
    cpar.n_threads_batch = 4;
    cpar.offload_kqv = true;
    cpar.embeddings = true;
    cpar.n_rs_seq = 16;
    // Let g_abort interrupt an in-flight llama_decode (esp. a long single-batch
    // prefill) — so the Chat "Stop" / client-disconnect abort takes effect promptly
    // instead of waiting for the whole decode call to return.
    cpar.abort_callback      = (void *) ork_abort_cb;
    cpar.abort_callback_data = nullptr;

    // KV-cache quantization (TurboQuant etc.). type_k/type_v default to F16; only
    // overridden when a recognized type is passed. Turbo/quantized types require
    // flash attention, which the runtime auto-enables for them, so flash_attn_type
    // is left at its default (AUTO).
    if (opts.Has("kv_type_k") && opts.Get("kv_type_k").IsString()) {
        int t = kvTypeFromStr(opts.Get("kv_type_k").As<Napi::String>().Utf8Value());
        if (t >= 0) cpar.type_k = t;
    }
    if (opts.Has("kv_type_v") && opts.Get("kv_type_v").IsString()) {
        int t = kvTypeFromStr(opts.Get("kv_type_v").As<Napi::String>().Utf8Value());
        if (t >= 0) cpar.type_v = t;
    }

    g_ctx = fn_ctx_init(g_model, cpar);
    if (!g_ctx) {
        fn_model_free(g_model); g_model = nullptr;
        return Napi::Number::New(env, -2);
    }

    // Build sampler chain
    auto sparams = fn_schain_par();
    g_sampler = fn_schain_init(sparams);
    int32_t topk = opts.Has("top_k") ? opts.Get("top_k").As<Napi::Number>().Int32Value() : 40;
    float   topp = opts.Has("top_p") ? opts.Get("top_p").As<Napi::Number>().FloatValue()  : 0.9f;
    float   temp = opts.Has("temperature") ? opts.Get("temperature").As<Napi::Number>().FloatValue() : 0.8f;
    fn_schain_add(g_sampler, fn_s_topk(topk));
    fn_schain_add(g_sampler, fn_s_topp(topp, 1));
    fn_schain_add(g_sampler, fn_s_temp(temp));
    fn_schain_add(g_sampler, fn_s_dist(LLAMA_RANDOM_SEED));

    g_abort = false;
    return Napi::Number::New(env, 0);
}

Napi::Value Run(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_lib || !g_model || !g_ctx) {
        Napi::Error::New(env, "Llama model not initialized").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (input_object, callback_function)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object input = info[0].As<Napi::Object>();
    Napi::Function cb  = info[1].As<Napi::Function>();

    std::string prompt          = input.Has("prompt") && input.Get("prompt").IsString()
                                  ? input.Get("prompt").As<Napi::String>().Utf8Value() : "";
    std::string loadCachePath   = input.Has("loadCachePath") && input.Get("loadCachePath").IsString()
                                  ? input.Get("loadCachePath").As<Napi::String>().Utf8Value() : "";
    std::string saveCachePath   = input.Has("saveCachePath") && input.Get("saveCachePath").IsString()
                                  ? input.Get("saveCachePath").As<Napi::String>().Utf8Value() : "";
    int inferMode = input.Has("infer_mode") && input.Get("infer_mode").IsNumber() ? input.Get("infer_mode").As<Napi::Number>().Int32Value() : 0;

    // Per-request generation cap. The chat/bench layer sends max_new_tokens;
    // honour it instead of a fixed limit (this used to be hardcoded to 512, so
    // the model's Max New Tokens setting had no effect on the gguf path).
    int maxNewTokens = input.Has("max_new_tokens") && input.Get("max_new_tokens").IsNumber()
                       ? input.Get("max_new_tokens").As<Napi::Number>().Int32Value() : 512;
    if (maxNewTokens <= 0) maxNewTokens = 512;

    // Rebuild the sampler chain from THIS request's sampling params so per-request
    // settings take effect. The chain is otherwise fixed at load (init_model), so
    // changing a model's sampling settings did nothing until reload. Runs are
    // serialized per worker, so replacing g_sampler here is safe. Penalty /
    // mirostat / min_p samplers are optional (nullptr if libllama lacks them).
    auto optF = [&](const char* k, float d) {
        return input.Has(k) && input.Get(k).IsNumber() ? input.Get(k).As<Napi::Number>().FloatValue() : d;
    };
    auto optI = [&](const char* k, int32_t d) {
        return input.Has(k) && input.Get(k).IsNumber() ? input.Get(k).As<Napi::Number>().Int32Value() : d;
    };
    if (inferMode == 0) {
        int32_t topk = optI("top_k", 40);
        float   topp = optF("top_p", 0.9f);
        float   temp = optF("temperature", 0.8f);
        float   minp = optF("min_p", 0.0f);
        float   rep  = optF("repeat_penalty", 1.0f);
        float   freq = optF("frequency_penalty", 0.0f);
        float   pres = optF("presence_penalty", 0.0f);
        int32_t miro = optI("mirostat", 0);
        float   mtau = optF("mirostat_tau", 5.0f);
        float   meta = optF("mirostat_eta", 0.1f);

        if (g_sampler) { fn_samp_free(g_sampler); g_sampler = nullptr; }
        auto sp = fn_schain_par();
        g_sampler = fn_schain_init(sp);

        // Repetition/frequency/presence penalties operate on raw logits — add first.
        if (fn_s_penalties && (rep != 1.0f || freq != 0.0f || pres != 0.0f)) {
            fn_schain_add(g_sampler, fn_s_penalties(64, rep, freq, pres));
        }

        if (miro > 0 && fn_s_mirostat_v2) {
            // Mirostat v2 is a terminal sampler (selects the token); temp first.
            fn_schain_add(g_sampler, fn_s_temp(temp));
            fn_schain_add(g_sampler, fn_s_mirostat_v2(LLAMA_RANDOM_SEED, mtau, meta));
        } else {
            fn_schain_add(g_sampler, fn_s_topk(topk));
            fn_schain_add(g_sampler, fn_s_topp(topp, 1));
            if (minp > 0.0f && fn_s_min_p) fn_schain_add(g_sampler, fn_s_min_p(minp, 1));
            fn_schain_add(g_sampler, fn_s_temp(temp));
            fn_schain_add(g_sampler, fn_s_dist(LLAMA_RANDOM_SEED));
        }
    }
    bool keepHistory = input.Has("keep_history") && input.Get("keep_history").As<Napi::Boolean>().Value();
    std::vector<int32_t> tokenIds;
    bool useTokenInput = false;
    if (input.Has("token_ids") && input.Get("token_ids").IsTypedArray()) {
        auto arr = input.Get("token_ids").As<Napi::Int32Array>();
        tokenIds.assign(arr.Data(), arr.Data() + arr.ElementLength());
        useTokenInput = !tokenIds.empty();
    }

    // Chat templating: if structured messages were passed and the model has a
    // NON-ChatML template (e.g. LFM2's <|startoftext|>), format the prompt with
    // the model's OWN template via llama.cpp instead of the ChatML `prompt` the
    // chat layer built (which only suits ChatML models like Qwen — for those the
    // template contains "im_start" and we keep `prompt` as-is, preserving the
    // thinking-mode seed). Any failure (unsupported template, no symbols) falls
    // back to `prompt`.
    if (inferMode == 0 && !useTokenInput && input.Has("messages") && input.Get("messages").IsArray()
        && fn_chat_apply && fn_model_tmpl) {
        const char* tmpl = fn_model_tmpl(g_model, nullptr);
        if (tmpl && !strstr(tmpl, "im_start")) {
            auto arr = input.Get("messages").As<Napi::Array>();
            std::vector<std::string> roles, contents;
            for (uint32_t i = 0; i < arr.Length(); i++) {
                Napi::Object m = arr.Get(i).As<Napi::Object>();
                roles.push_back(m.Has("role")    ? m.Get("role").As<Napi::String>().Utf8Value()    : std::string("user"));
                contents.push_back(m.Has("content") ? m.Get("content").As<Napi::String>().Utf8Value() : std::string(""));
            }
            std::vector<llama_chat_message> msgs;
            for (size_t i = 0; i < roles.size(); i++) msgs.push_back({ roles[i].c_str(), contents[i].c_str() });
            if (!msgs.empty()) {
                std::vector<char> buf(8192);
                int32_t n = fn_chat_apply(tmpl, msgs.data(), msgs.size(), true, buf.data(), (int32_t)buf.size());
                if (n > (int32_t)buf.size()) { buf.resize(n); n = fn_chat_apply(tmpl, msgs.data(), msgs.size(), true, buf.data(), (int32_t)buf.size()); }
                if (n > 0) {
                    prompt = std::string(buf.data(), (size_t)n);
                    // Thinking control: reasoning templates (LFM2, Qwen3…) open a
                    // <think> block in the assistant generation prompt to force
                    // reasoning. When the model's Thinking setting is OFF, close
                    // that block immediately (empty) so the model skips reasoning.
                    bool enableThinking = input.Has("enable_thinking") && input.Get("enable_thinking").As<Napi::Boolean>().Value();
                    size_t tp = prompt.rfind("<think>");
                    bool openThink = (tp != std::string::npos && prompt.find("</think>", tp) == std::string::npos);
                    if (!enableThinking) {
                        if (openThink) {
                            prompt += "\n</think>\n\n";           // template opened it → close empty
                        } else if (tp == std::string::npos && strstr(tmpl, "think")) {
                            prompt += "<think>\n\n</think>\n\n";   // reasoning model self-emits think → seed empty
                        }
                    }
                    fprintf(stderr, "[orkllm-llama] chat-template applied: enableThinking=%d hasThink=%d openThink=%d tail=[%s]\n",
                            (int)enableThinking, (int)(tp != std::string::npos), (int)openThink,
                            prompt.substr(prompt.size() > 70 ? prompt.size() - 70 : 0).c_str());
                }
            }
        }
    }

    // Clear any leftover state from a previous run (KV + recurrent memory — e.g.
    // an aborted Eagle-3 attempt, or a hybrid model's lingering recurrent state).
    clearCtxMemory();

    auto *rctx = new RunContext();
    rctx->tsfn  = Napi::ThreadSafeFunction::New(env, cb, "LlamaCallback", 0, 1);
    g_abort = false;

    std::thread([prompt, loadCachePath, saveCachePath, maxNewTokens, inferMode, keepHistory, tokenIds, useTokenInput, rctx]() {
        float prefill_time = 0;
        int prefill_tokens = 0;
        float generate_time = 0;
        int generated_tokens = 0;

        auto finish = [&](const std::string &text, int state,
                          const std::vector<float>& h_states = {}, int h_embd = 0, int h_num = 0,
                          const std::vector<float>& l_states = {}, int l_vocab = 0, int l_num = 0) {
            rctx->tsfn.NonBlockingCall([text, state, h_states, h_embd, h_num, l_states, l_vocab, l_num, prefill_time, prefill_tokens, generate_time, generated_tokens](Napi::Env e, Napi::Function f) {
                Napi::Object o = Napi::Object::New(e);
                o.Set("text",  Napi::String::New(e, text));
                o.Set("state", Napi::Number::New(e, state));
                Napi::Object perf = Napi::Object::New(e);
                perf.Set("prefill_time_ms",  Napi::Number::New(e, prefill_time));
                perf.Set("prefill_tokens",   Napi::Number::New(e, prefill_tokens));
                perf.Set("generate_time_ms", Napi::Number::New(e, generate_time));
                perf.Set("generate_tokens",  Napi::Number::New(e, generated_tokens));
                o.Set("perf", perf);
                if (!h_states.empty()) {
                    auto buf = Napi::Float32Array::New(e, h_states.size());
                    std::memcpy(buf.Data(), h_states.data(), h_states.size() * sizeof(float));
                    o.Set("hidden_states", buf);
                    o.Set("hidden_embd_size", Napi::Number::New(e, h_embd));
                    o.Set("hidden_num_tokens", Napi::Number::New(e, h_num));
                }
                o.Set("logits_vocab_size", Napi::Number::New(e, l_vocab));
                if (!l_states.empty()) {
                    auto buf = Napi::Float32Array::New(e, l_states.size());
                    std::memcpy(buf.Data(), l_states.data(), l_states.size() * sizeof(float));
                    o.Set("logits", buf);
                    o.Set("logits_num_tokens", Napi::Number::New(e, l_num));
                }
                f.Call({o});
            });
            if (state == 2 || state == 3 || !h_states.empty() || !l_states.empty()) {
                rctx->tsfn.Release();
                delete rctx;
            }
        };



        // Tokenize
        std::vector<llama_token> toks;
        if (useTokenInput) {
            toks = tokenIds;
        } else {
            const int maxTok = 8192;
            toks.resize(maxTok);
            int n = fn_tokenize(g_vocab, prompt.c_str(), (int32_t)prompt.size(),
                                toks.data(), maxTok, /*add_special=*/true, /*parse_special=*/true);
            if (n < 0) { finish("", 3); return; }
            toks.resize(n);
        }

        int n = toks.size();
        std::vector<float> all_hidden_states;
        std::vector<float> all_logits;
        int n_embd = fn_n_embd ? fn_n_embd(g_model) : 0;
        int n_vocab = fn_n_vocab(g_vocab);

        int n_past = 0;
        if (!loadCachePath.empty() && fn_state_load) {
            size_t tokens_loaded = 0;
            size_t capacity = 0;
            std::FILE* f = std::fopen(loadCachePath.c_str(), "rb");
            if (f) {
                if (std::fseek(f, 8, SEEK_SET) == 0) {
                    uint32_t n_tokens = 0;
                    if (std::fread(&n_tokens, sizeof(n_tokens), 1, f) == 1) {
                        capacity = n_tokens;
                    }
                }
                std::fclose(f);
            }
            if (capacity == 0) capacity = 8192; // fallback
            std::vector<llama_token> tokens_loaded_buf(capacity);
            fn_state_load(g_ctx, loadCachePath.c_str(), 0, tokens_loaded_buf.data(), tokens_loaded_buf.size(), &tokens_loaded);
            if (tokens_loaded > 0) n_past = tokens_loaded;
            else if (fn_kv_used) n_past = fn_kv_used(g_ctx);
        } else if (keepHistory && fn_kv_used) {
            n_past = fn_kv_used(g_ctx);
        } else {
            clearCtxMemory();
        }

        auto t0 = std::chrono::high_resolution_clock::now();

        // Decode the prompt (prefill)
        for (int i = 0; i < n && !g_abort; ) {
            int batch = std::min(n - i, 512);
            auto b = fn_batch_init(batch, 0, 1);
            b.n_tokens = batch;
            for (int j = 0; j < batch; j++) {
                b.token[j] = toks[i + j];
                b.pos[j] = n_past + j;
                b.n_seq_id[j] = 1;
                b.seq_id[j][0] = 0;
                b.logits[j] = (inferMode == 1 || inferMode == 2) ? 1 : (j == batch - 1 ? 1 : 0);
            }
            if (fn_decode(g_ctx, b) != 0) { fn_batch_free(b); finish("", 3); return; }
            
            if (inferMode == 1 || inferMode == 2) {
                for (int j = 0; j < batch; j++) {
                    float* hs = nullptr;
                    if (inferMode == 1 && fn_get_embeddings_ith) hs = fn_get_embeddings_ith(g_ctx, j);
                    if (hs) all_hidden_states.insert(all_hidden_states.end(), hs, hs + n_embd);
                    
                    if (inferMode == 2 && fn_get_logits_ith) {
                        float* l = fn_get_logits_ith(g_ctx, j);
                        if (l) all_logits.insert(all_logits.end(), l, l + n_vocab);
                    }
                    
                    char piece[128];
                    int plen = fn_tok2piece(g_vocab, toks[i + j], piece, sizeof(piece) - 1, 0, true);
                    if (plen < 0) plen = 0;
                    piece[plen] = '\0';
                    std::string s(piece, plen);

                    rctx->tsfn.NonBlockingCall([s, tok=toks[i+j]](Napi::Env e, Napi::Function f) {
                        Napi::Object o = Napi::Object::New(e);
                        o.Set("text",  Napi::String::New(e, s));
                        o.Set("token_id", Napi::Number::New(e, tok));
                        o.Set("state", Napi::Number::New(e, 0));
                        f.Call({o});
                    });
                }
            }
            i += batch;
            n_past += batch;
            prefill_tokens += batch;
            if (i >= n) {
                auto t1 = std::chrono::high_resolution_clock::now();
                prefill_time = std::chrono::duration<float, std::milli>(t1 - t0).count();
            }
            fn_batch_free(b);
        }
        if (g_abort) { finish("", 3); return; }

        if (inferMode == 1) {
            finish("", 0, all_hidden_states, n_embd, n, {}, n_vocab, 0);
            return;
        } else if (inferMode == 2) {
            finish("", 0, all_hidden_states, n_embd, n, all_logits, n_vocab, n);
            return;
        }

        // Optional: save KV cache to disk after prefill
        if (!saveCachePath.empty() && fn_state_save) {
            fn_state_save(g_ctx, saveCachePath.c_str(), 0, toks.data(), (size_t)n);
        }

        // Generate
        auto t2 = std::chrono::high_resolution_clock::now();
        char piece[128];
        for (int gen = 0; gen < maxNewTokens && !g_abort; gen++) {
            llama_token tok = fn_sample(g_sampler, g_ctx, -1);
            if (fn_samp_accept) fn_samp_accept(g_sampler, tok);
            if (fn_is_eog(g_vocab, tok)) break;

            int plen = fn_tok2piece(g_vocab, tok, piece, sizeof(piece) - 1, 0, true);
            if (plen < 0) plen = 0;
            piece[plen] = '\0';
            std::string s(piece, plen);
            generated_tokens++;

            rctx->tsfn.NonBlockingCall([s, prefill_time, prefill_tokens](Napi::Env e, Napi::Function f) {
                Napi::Object o = Napi::Object::New(e);
                o.Set("text",  Napi::String::New(e, s));
                o.Set("state", Napi::Number::New(e, 0));
                Napi::Object perf = Napi::Object::New(e);
                perf.Set("prefill_time_ms",  Napi::Number::New(e, prefill_time));
                perf.Set("prefill_tokens",   Napi::Number::New(e, prefill_tokens));
                perf.Set("generate_time_ms", Napi::Number::New(e, 0));
                perf.Set("generate_tokens",  Napi::Number::New(e, 0));
                o.Set("perf", perf);
                f.Call({o});
            });

            // Decode the sampled token
            if (maxNewTokens > 0 && generated_tokens >= maxNewTokens) break;

            auto b = fn_batch_init(1, 0, 1);
            b.n_tokens = 1;
            b.token[0] = tok;
            b.pos[0] = n_past;
            b.n_seq_id[0] = 1;
            b.seq_id[0][0] = 0;
            b.logits[0] = 1;
            if (fn_decode(g_ctx, b) != 0) { fn_batch_free(b); break; }
            fn_batch_free(b);
            n_past++;
        }
        auto t3 = std::chrono::high_resolution_clock::now();
        generate_time = std::chrono::duration<float, std::milli>(t3 - t2).count();

        finish("", 2 /*RKLLM_RUN_FINISH*/);
    }).detach();

    return env.Null();
}

Napi::Value UnloadModel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_sampler) { fn_samp_free(g_sampler); g_sampler = nullptr; }
    if (g_ctx)     { fn_ctx_free(g_ctx);       g_ctx = nullptr; }
    if (g_model)   { fn_model_free(g_model);   g_model = nullptr; }
    return Napi::Number::New(env, 0);
}

Napi::Value AbortInference(const Napi::CallbackInfo& info) {
    g_abort = true;
    return Napi::Number::New(info.Env(), 0);
}

Napi::Value ClearKVCache(const Napi::CallbackInfo& info) {
    if (g_ctx) clearCtxMemory();
    return Napi::Number::New(info.Env(), 0);
}

Napi::Value RollbackKVCache(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_ctx) return Napi::Boolean::New(env, false);
    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected number position to rollback to").ThrowAsJavaScriptException();
        return env.Null();
    }
    int pos = info[0].As<Napi::Number>().Int32Value();
    int seq_id = 0;
    if (info.Length() >= 2 && info[1].IsNumber()) {
        seq_id = info[1].As<Napi::Number>().Int32Value();
    }
    bool ok = false;
    if (fn_get_memory && fn_memory_seq_rm) {
        ok = fn_memory_seq_rm(fn_get_memory(g_ctx), seq_id, pos, -1);
    }
    return Napi::Boolean::New(env, ok);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("load_library",     Napi::Function::New(env, LoadLibrary));
    exports.Set("init_model",       Napi::Function::New(env, InitModel));
    exports.Set("run",              Napi::Function::New(env, Run));
    exports.Set("unload_model",     Napi::Function::New(env, UnloadModel));
    exports.Set("abort_inference",  Napi::Function::New(env, AbortInference));
    exports.Set("clear_kv_cache",   Napi::Function::New(env, ClearKVCache));
    exports.Set("rollback_kv_cache", Napi::Function::New(env, RollbackKVCache));
    return exports;
}

NODE_API_MODULE(orkllm_llama_napi, Init)
