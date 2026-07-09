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

#ifdef __linux__
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#endif
#ifdef __APPLE__
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#endif

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
    uint32_t n_outputs_max;
    uint32_t n_rs_seq;
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
// DFlash (block-diffusion speculative decode) primitives — feat/dflash libllama only (nullable).
typedef int32_t  (*llama_encode_t)(struct llama_context *, struct llama_batch);
typedef void     (*llama_set_embeddings_layer_inp_t)(struct llama_context *, uint32_t, bool);
typedef float *  (*llama_get_embeddings_layer_inp_t)(struct llama_context *, uint32_t);
typedef void     (*llama_set_embeddings_nextn_t)(struct llama_context *, bool, bool);
typedef float *  (*llama_get_embeddings_nextn_t)(struct llama_context *);
typedef void     (*llama_set_dflash_context_t)(struct llama_context *, const float *, int32_t, const int32_t *);
typedef const int32_t * (*llama_model_target_layer_ids_t)(const struct llama_model *);
typedef uint32_t (*llama_model_target_layer_ids_n_t)(const struct llama_model *);
typedef llama_token (*llama_vocab_mask_t)(const struct llama_vocab *);
typedef size_t   (*llama_state_seq_get_size_t)(struct llama_context *, llama_seq_id);
typedef size_t   (*llama_state_seq_get_data_t)(struct llama_context *, uint8_t *, size_t, llama_seq_id);
typedef size_t   (*llama_state_seq_set_data_t)(struct llama_context *, const uint8_t *, size_t, llama_seq_id);
// ── Global state ──────────────────────────────────────────────────────────────
static DYNLIB_HANDLE g_lib = nullptr;
static std::string   g_libpath;   // path passed to load_library (to locate the sibling libggml-base)
static struct llama_model        *g_model   = nullptr;
static const struct llama_vocab  *g_vocab   = nullptr;
// llama.cpp interprets this seed as "pick a fresh random seed per run", so
// generations actually vary at temperature > 0 (a fixed seed made identical
// prompts always produce identical output).
static const uint32_t LLAMA_RANDOM_SEED = 0xFFFFFFFFu;
static struct llama_context      *g_ctx     = nullptr;
static struct llama_sampler      *g_sampler = nullptr;
// DFlash: the block-diffusion draft, co-resident with the target (its context borrows the target's
// tok_embd/output via ctx_other = g_ctx, and reads the target's extracted hidden layers).
static struct llama_model        *g_draft_model = nullptr;
static struct llama_context      *g_draft_ctx   = nullptr;
static std::string                g_draft_path;
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
// DFlash primitives (feat/dflash libllama only; nullptr on stock runtimes)
static llama_encode_t                    fn_encode         = nullptr;
static llama_set_embeddings_layer_inp_t  fn_set_layer_inp  = nullptr;
static llama_get_embeddings_layer_inp_t  fn_get_layer_inp  = nullptr;
static llama_set_embeddings_nextn_t      fn_set_emb_nextn  = nullptr;
static llama_get_embeddings_nextn_t      fn_get_emb_nextn  = nullptr;
static llama_set_dflash_context_t        fn_set_dflash_ctx = nullptr;
static llama_model_target_layer_ids_t    fn_tlids          = nullptr;
static llama_model_target_layer_ids_n_t  fn_tlids_n        = nullptr;
static llama_vocab_mask_t                fn_vocab_mask     = nullptr;
static llama_state_seq_get_size_t        fn_state_seq_size = nullptr;
static llama_state_seq_get_data_t        fn_state_seq_get  = nullptr;
static llama_state_seq_set_data_t        fn_state_seq_set  = nullptr;

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
    g_libpath = libPath;   // remembered so the DFlash converter can dlopen the sibling libggml-base

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
    // DFlash primitives — optional (present only on a feat/dflash libllama; run_dflash null-checks them).
    LOAD_SYM2(encode,          "llama_encode");
    LOAD_SYM2(set_layer_inp,   "llama_set_embeddings_layer_inp");
    LOAD_SYM2(get_layer_inp,   "llama_get_embeddings_layer_inp");
    LOAD_SYM2(set_emb_nextn,   "llama_set_embeddings_nextn");
    LOAD_SYM2(get_emb_nextn,   "llama_get_embeddings_nextn");
    LOAD_SYM2(set_dflash_ctx,  "llama_set_dflash_context");
    LOAD_SYM2(tlids,           "llama_model_target_layer_ids");
    LOAD_SYM2(tlids_n,         "llama_model_target_layer_ids_n");
    LOAD_SYM2(vocab_mask,      "llama_vocab_mask");
    LOAD_SYM2(state_seq_size,  "llama_state_seq_get_size");
    LOAD_SYM2(state_seq_get,   "llama_state_seq_get_data");
    LOAD_SYM2(state_seq_set,   "llama_state_seq_set_data");

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
    // --no-repack equivalent: keep weights in HOST buffers so the ggml-ork NPU matmul offload fires.
    // The aarch64 repack buffer-type (default on) re-tiles Q4_0/Q4_K weights into a non-host GEMM buffer,
    // which fails ggml-ork's is_host offload gate → Q4_K matmuls silently fall back to CPU. Disabling
    // extra bufts is the in-process equivalent of llama-completion's --no-repack and is required for the
    // NPU path (and for .orkpack conversions to pack via ggml-ork) on repackable quants like Q4_K.
    mpar.use_extra_bufts = opts.Has("use_extra_bufts") && opts.Get("use_extra_bufts").IsBoolean()
                    ? opts.Get("use_extra_bufts").As<Napi::Boolean>().Value() : false;

    g_model = fn_model_load(s_modelPath.c_str(), mpar);
    if (!g_model) return Napi::Number::New(env, -1);

    g_vocab = fn_get_vocab(g_model);

    auto cpar = fn_ctx_def_par();
    cpar.n_ctx     = opts.Has("max_context_len") ? (uint32_t)opts.Get("max_context_len").As<Napi::Number>().Int32Value() : 4096;
    cpar.n_batch   = 512;
    cpar.n_ubatch  = 512;
    cpar.n_outputs_max = cpar.n_batch;
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

#ifdef __linux__
    // After successful initialization, drop the GGUF file from the OS page cache.
    // Since layers have been offloaded to NPU/GPU, the raw GGUF weights in physical
    // memory are a redundant duplicate. Dropping them saves up to 21 GB of RAM!
    // Any CPU-bound layers will page-fault back on demand.
    int fd = open(s_modelPath.c_str(), O_RDONLY);
    if (fd >= 0) {
        posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
        close(fd);
    }
#endif

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
            auto td0 = std::chrono::high_resolution_clock::now();
            int decode_ret = fn_decode(g_ctx, b);
            auto td1 = std::chrono::high_resolution_clock::now();
            const char* val = std::getenv("ORKLLM_VERBOSE");
            if (val != nullptr && std::strcmp(val, "2") == 0) {
                double ms = std::chrono::duration<double, std::milli>(td1 - td0).count();
                std::printf("[Llama TRACE] prefill fn_decode of %d tokens took %.3f ms (ret=%d)\n", batch, ms, decode_ret);
                std::fflush(stdout);
            }
            if (decode_ret != 0) { fn_batch_free(b); finish("", 3); return; }
            
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
            auto td2 = std::chrono::high_resolution_clock::now();
            int decode_ret = fn_decode(g_ctx, b);
            auto td3 = std::chrono::high_resolution_clock::now();
            const char* val = std::getenv("ORKLLM_VERBOSE");
            if (val != nullptr && std::strcmp(val, "2") == 0) {
                double ms = std::chrono::duration<double, std::milli>(td3 - td2).count();
                std::printf("[Llama TRACE] generate fn_decode took %.3f ms (ret=%d)\n", ms, decode_ret);
                std::fflush(stdout);
            }
            if (decode_ret != 0) { fn_batch_free(b); break; }
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

// ── DFlash: block-diffusion speculative decode (skip-ahead) ──────────────────────────────────────────
// Ports examples/dflash's validated loop. The target (g_ctx) must already be loaded via init_model; this
// loads the DFlash draft co-resident (ctx_other = g_ctx so it borrows the target's tok_embd/output and can
// read the target's extracted hidden layers). Each cycle: draft a block on the draft (one grouped forward),
// verify all B on the target in ONE forward (M=B, grouped -> NPU), accept the longest greedy-matching prefix
// + the target's correction (bonus), roll back via a state checkpoint (M-RoPE KV can't partial-seq_rm),
// commit, and grow the fused context from the committed tokens' target hiddens.
// NOTE: first-draft port — validate/iterate via a board node-gyp build against a feat/dflash libllama.
static bool ensure_draft_loaded(const std::string& path) {
    if (g_draft_ctx && g_draft_path == path) return true;
    if (g_draft_ctx)   { fn_ctx_free(g_draft_ctx);     g_draft_ctx   = nullptr; }
    if (g_draft_model) { fn_model_free(g_draft_model); g_draft_model = nullptr; }
    auto mp = fn_model_def_par(); mp.n_gpu_layers = 999;
    g_draft_model = fn_model_load(path.c_str(), mp);
    if (!g_draft_model) return false;
    auto cp = fn_ctx_def_par();
    cp.ctx_other       = g_ctx;                 // borrow target embeddings/output + read extracted layers
    cp.flash_attn_type = 0;                     // DISABLED (block attention uses the non-flash path)
    if (fn_n_ctx) cp.n_ctx = fn_n_ctx(g_ctx);   // match the target's context length
    g_draft_ctx = fn_ctx_init(g_draft_model, cp);
    if (!g_draft_ctx) { fn_model_free(g_draft_model); g_draft_model = nullptr; return false; }
    if (fn_set_emb_nextn) fn_set_emb_nextn(g_draft_ctx, true, false);  // capture the encoder g_embd
    g_draft_path = path;
    return true;
}

Napi::Value RunDflash(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_lib || !g_model || !g_ctx) { Napi::Error::New(env, "target not initialized").ThrowAsJavaScriptException(); return env.Null(); }
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) { Napi::TypeError::New(env, "Expected (input, callback)").ThrowAsJavaScriptException(); return env.Null(); }
    if (!fn_encode || !fn_set_layer_inp || !fn_get_layer_inp || !fn_get_emb_nextn || !fn_set_dflash_ctx ||
        !fn_tlids || !fn_tlids_n || !fn_vocab_mask || !fn_state_seq_size || !fn_state_seq_get || !fn_state_seq_set ||
        !fn_n_embd || !fn_get_logits_ith || !fn_get_memory || !fn_memory_seq_rm) {
        Napi::Error::New(env, "libllama lacks DFlash symbols (needs a feat/dflash runtime)").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object input = info[0].As<Napi::Object>();
    Napi::Function cb  = info[1].As<Napi::Function>();
    std::string prompt    = input.Has("prompt")     && input.Get("prompt").IsString()     ? input.Get("prompt").As<Napi::String>().Utf8Value() : "";
    std::string draftPath = input.Has("draft_path") && input.Get("draft_path").IsString() ? input.Get("draft_path").As<Napi::String>().Utf8Value() : "";
    int block_size    = input.Has("block_size")     && input.Get("block_size").IsNumber()     ? input.Get("block_size").As<Napi::Number>().Int32Value() : 16;
    int maxNewTokens  = input.Has("max_new_tokens") && input.Get("max_new_tokens").IsNumber() ? input.Get("max_new_tokens").As<Napi::Number>().Int32Value() : 512;
    if (block_size <= 0) block_size = 16;
    if (maxNewTokens <= 0) maxNewTokens = 512;

    if (draftPath.empty() || !ensure_draft_loaded(draftPath)) { Napi::Error::New(env, "failed to load DFlash draft").ThrowAsJavaScriptException(); return env.Null(); }

    const int32_t* tlids = fn_tlids(g_draft_model);
    const uint32_t n_tl  = fn_tlids_n(g_draft_model);
    for (uint32_t k = 0; k < n_tl; ++k) fn_set_layer_inp(g_ctx, (uint32_t) tlids[k], true);

    const int32_t     n_embd_tgt = fn_n_embd(g_model);
    const int32_t     n_embd_dec = fn_n_embd(g_draft_model);
    const int32_t     n_embd_enc = (int32_t) n_tl * n_embd_tgt;
    const llama_token mask_tok   = fn_vocab_mask(fn_get_vocab(g_draft_model));

    auto* rctx = new RunContext();
    rctx->tsfn = Napi::ThreadSafeFunction::New(env, cb, "DflashCb", 0, 1);
    g_abort = false;

    std::thread([prompt, block_size, maxNewTokens, n_embd_tgt, n_embd_dec, n_embd_enc, mask_tok, tlids, n_tl, rctx]() {
        auto stream = [&](const std::string& s, int state) {
            rctx->tsfn.NonBlockingCall([s, state](Napi::Env e, Napi::Function f) {
                Napi::Object o = Napi::Object::New(e);
                o.Set("text",  Napi::String::New(e, s));
                o.Set("state", Napi::Number::New(e, state));
                f.Call({o});
            });
            if (state == 2 || state == 3) { rctx->tsfn.Release(); delete rctx; }
        };
        auto piece  = [&](llama_token t) { char b[128]; int n = fn_tok2piece(g_vocab, t, b, sizeof(b)-1, 0, true); if (n < 0) n = 0; return std::string(b, n); };
        const int32_t n_vocab = fn_n_vocab(g_vocab);
        auto argmax = [&](const float* lg) { int b = 0; float bv = lg[0]; for (int v = 1; v < n_vocab; ++v) if (lg[v] > bv) { bv = lg[v]; b = v; } return (llama_token) b; };

        clearCtxMemory();
        fn_memory_seq_rm(fn_get_memory(g_draft_ctx), 0, -1, -1);

        std::vector<llama_token> toks(8192);
        int n_prompt = fn_tokenize(g_vocab, prompt.c_str(), (int32_t) prompt.size(), toks.data(), 8192, true, true);
        if (n_prompt <= 0) { stream("", 3); return; }
        toks.resize(n_prompt);

        std::vector<float>   ctx_g;
        std::vector<int32_t> ctx_pos;
        std::vector<float>   feat;
        std::vector<uint8_t> ckpt;

        auto grab = [&](int32_t n, int32_t row_off) {
            for (uint32_t k = 0; k < n_tl; ++k) {
                float* layer = fn_get_layer_inp(g_ctx, (uint32_t) tlids[k]);
                if (!layer) return false;
                for (int32_t i = 0; i < n; ++i)
                    std::memcpy(feat.data() + (size_t)(row_off + i) * n_embd_enc + (size_t) k * n_embd_tgt,
                                layer + (size_t) i * n_embd_tgt, (size_t) n_embd_tgt * sizeof(float));
            }
            return true;
        };
        auto encode_append = [&](const float* f, int32_t n, int32_t base_pos) {
            llama_batch e = fn_batch_init(n, n_embd_enc, 1);
            e.n_tokens = n;
            std::memcpy(e.embd, f, (size_t) n * n_embd_enc * sizeof(float));
            for (int32_t i = 0; i < n; ++i) { e.pos[i] = i; e.n_seq_id[i] = 1; e.seq_id[i][0] = 0; e.logits[i] = 0; }
            int rc = fn_encode(g_draft_ctx, e);
            fn_batch_free(e);
            if (rc != 0) return false;
            const float* g = fn_get_emb_nextn(g_draft_ctx);
            if (!g) return false;
            size_t off = ctx_g.size(); ctx_g.resize(off + (size_t) n * n_embd_dec);
            std::memcpy(ctx_g.data() + off, g, (size_t) n * n_embd_dec * sizeof(float));
            for (int32_t i = 0; i < n; ++i) ctx_pos.push_back(base_pos + i);
            return true;
        };
        auto decode_toks = [&](llama_context* c, const std::vector<llama_token>& t, const std::vector<int32_t>& pos) {
            llama_batch b = fn_batch_init((int32_t) t.size(), 0, 1);
            b.n_tokens = (int32_t) t.size();
            for (size_t i = 0; i < t.size(); ++i) { b.token[i] = t[i]; b.pos[i] = pos[i]; b.n_seq_id[i] = 1; b.seq_id[i][0] = 0; b.logits[i] = 1; }
            int rc = fn_decode(c, b);
            fn_batch_free(b);
            return rc == 0;
        };

        // prefill the target + build the initial fused context
        { std::vector<int32_t> pp(n_prompt); for (int i = 0; i < n_prompt; ++i) pp[i] = i;
          if (!decode_toks(g_ctx, toks, pp)) { stream("", 3); return; } }
        for (auto id : toks) stream(piece(id), 0);
        feat.assign((size_t) n_prompt * n_embd_enc, 0.0f);
        if (!grab(n_prompt, 0) || !encode_append(feat.data(), n_prompt, 0)) { stream("", 3); return; }

        int32_t     n_ctx_tok = n_prompt;
        llama_token anchor    = toks[n_prompt - 1];
        llama_token t0        = argmax(fn_get_logits_ith(g_ctx, n_prompt - 1));
        int64_t     n_gen     = 0;
        bool        eog       = false;

        // instrumentation: measure acceptance-length tau + throughput of the skip-ahead loop
        int64_t n_cycles = 0, n_acc_total = 0;
        auto    t_loop   = std::chrono::high_resolution_clock::now();

        while (n_gen < maxNewTokens && !eog && !g_abort) {
            // draft block on the draft (clear its KV first; the context is passed out-of-band)
            fn_memory_seq_rm(fn_get_memory(g_draft_ctx), 0, -1, -1);
            fn_set_dflash_ctx(g_draft_ctx, ctx_g.data(), (int32_t) ctx_pos.size(), ctx_pos.data());
            std::vector<llama_token> bt; std::vector<int32_t> bp;
            bt.push_back(anchor); bp.push_back(n_ctx_tok - 1);
            for (int j = 0; j < block_size; ++j) { bt.push_back(mask_tok); bp.push_back(n_ctx_tok + j); }
            if (!decode_toks(g_draft_ctx, bt, bp)) { stream("", 3); return; }
            std::vector<llama_token> d(block_size);
            for (int j = 0; j < block_size; ++j) d[j] = argmax(fn_get_logits_ith(g_draft_ctx, j + 1));

            // checkpoint + verify all B on the target in ONE forward (M=B, grouped -> NPU)
            size_t sz = fn_state_seq_size(g_ctx, 0); ckpt.resize(sz); fn_state_seq_get(g_ctx, ckpt.data(), sz, 0);
            { std::vector<int32_t> vp(block_size); for (int j = 0; j < block_size; ++j) vp[j] = n_ctx_tok + j;
              if (!decode_toks(g_ctx, d, vp)) { stream("", 3); return; } }
            int acc = 0; while (acc < block_size) { llama_token tj = (acc == 0) ? t0 : argmax(fn_get_logits_ith(g_ctx, acc - 1)); if (d[acc] != tj) break; acc++; }
            llama_token bonus = (acc == 0) ? t0 : argmax(fn_get_logits_ith(g_ctx, acc - 1));

            // roll back (restore checkpoint; M-RoPE can't partial-seq_rm) + commit [accepted..., bonus]
            fn_state_seq_set(g_ctx, ckpt.data(), sz, 0);
            std::vector<llama_token> ct; std::vector<int32_t> cp2;
            for (int j = 0; j < acc; ++j) { ct.push_back(d[j]); cp2.push_back(n_ctx_tok + j); }
            ct.push_back(bonus); cp2.push_back(n_ctx_tok + acc);
            if (!decode_toks(g_ctx, ct, cp2)) { stream("", 3); return; }
            feat.assign((size_t)(acc + 1) * n_embd_enc, 0.0f);
            if (!grab(acc + 1, 0) || !encode_append(feat.data(), acc + 1, n_ctx_tok)) { stream("", 3); return; }
            t0 = argmax(fn_get_logits_ith(g_ctx, acc));

            for (int j = 0; j < acc; ++j) { stream(piece(d[j]), 0); if (fn_is_eog(g_vocab, d[j])) eog = true; }
            stream(piece(bonus), 0); if (fn_is_eog(g_vocab, bonus)) eog = true;
            n_gen += acc + 1; anchor = bonus; n_ctx_tok += acc + 1;
            n_cycles++; n_acc_total += acc;
        }
        {
            double secs = std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - t_loop).count();
            double tau  = n_cycles ? (double)(n_acc_total + n_cycles) / (double) n_cycles : 0.0; // (accepted+bonus)/forward
            std::fprintf(stderr,
                "[dflash] DONE: gen=%lld tokens in %lld target-verify forwards (block=%d) over %.2fs | "
                "tau=%.2f tok/forward | throughput=%.2f tok/s\n",
                (long long) n_gen, (long long) n_cycles, block_size, secs, tau, secs > 0 ? n_gen / secs : 0.0);
        }
        stream("", 2);
    }).detach();
    return env.Null();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DFlash safetensors → GGUF converter (native; no Python/torch).
//
// Reads a z-lab DFlash draft's model.safetensors (BF16), quantizes each weight with ggml's exact
// quant, and writes a GGUF (arch 'dflash') — reusing the ggml/gguf C API already in libggml-base
// (dlopen'd as the sibling of the loaded libllama). Tokenizer metadata is copied wholesale from the
// target model's existing GGUF (gguf_set_kv), then the dflash arch/hparam keys are overridden — the
// draft borrows the target's tokenizer/embeddings at run time, so this is exactly right and needs no
// tokenizer.json parsing. JS (the runner) parses config.json + the safetensors header and passes a
// fully-resolved spec; this does only the binary heavy-lifting. Synchronous (runs in a dedicated
// subprocess, so blocking is fine).
namespace dfc {
  struct ggml_init_params { size_t mem_size; void * mem_buffer; bool no_alloc; };
  struct gguf_init_params { bool no_alloc; void * ctx; };
  enum { GGML_TYPE_F32 = 0, GGML_TYPE_F16 = 1, GGML_TYPE_Q8_0 = 8, GGML_TYPE_BF16 = 30 };
  enum { GGUF_TYPE_INT32 = 5 };
  typedef void*  (*ggml_init_t)(struct ggml_init_params);
  typedef void   (*ggml_free_t)(void*);
  typedef void*  (*ggml_new_tensor_1d_t)(void*, int, int64_t);
  typedef void*  (*ggml_new_tensor_2d_t)(void*, int, int64_t, int64_t);
  typedef void*  (*ggml_get_data_t)(const void*);
  typedef void*  (*ggml_set_name_t)(void*, const char*);
  typedef size_t (*ggml_row_size_t)(int, int64_t);
  typedef size_t (*ggml_tensor_overhead_t)(void);
  typedef size_t (*ggml_quantize_chunk_t)(int, const float*, void*, int64_t, int64_t, int64_t, const float*);
  typedef void   (*ggml_fp32_to_fp16_row_t)(const float*, uint16_t*, int64_t);
  typedef void   (*ggml_bf16_to_fp32_row_t)(const uint16_t*, float*, int64_t);
  typedef void*  (*gguf_init_empty_t)(void);
  typedef void*  (*gguf_init_from_file_t)(const char*, struct gguf_init_params);
  typedef void   (*gguf_free_t)(void*);
  typedef void   (*gguf_set_kv_t)(void*, const void*);
  typedef void   (*gguf_set_val_str_t)(void*, const char*, const char*);
  typedef void   (*gguf_set_val_u32_t)(void*, const char*, uint32_t);
  typedef void   (*gguf_set_val_f32_t)(void*, const char*, float);
  typedef void   (*gguf_set_arr_data_t)(void*, const char*, int, const void*, size_t);
  typedef void   (*gguf_add_tensor_t)(void*, const void*);
  typedef bool   (*gguf_write_to_file_t)(const void*, const char*, bool);
}

Napi::Value ConvertDflashGguf(const Napi::CallbackInfo& info) {
  using namespace dfc;
  Napi::Env env = info.Env();
  auto fail = [&](const std::string& m) { Napi::Object o = Napi::Object::New(env); o.Set("ok", false); o.Set("error", m); return o; };
  if (info.Length() < 1 || !info[0].IsObject()) { Napi::TypeError::New(env, "Expected (spec)").ThrowAsJavaScriptException(); return env.Null(); }
  Napi::Object in = info[0].As<Napi::Object>();

  // Locate + dlopen the sibling libggml-base (same dir as the loaded libllama).
  if (g_libpath.empty()) return fail("load_library must be called first");
  std::string dir = g_libpath.substr(0, g_libpath.find_last_of('/') + 1);
  void* gh = nullptr;
  for (const char* n : { "libggml-base.so", "libggml-base.so.0", "libggml-base.dylib" }) {
    gh = dlopen((dir + n).c_str(), RTLD_LAZY | RTLD_LOCAL); if (gh) break;
  }
  if (!gh) return fail("could not dlopen libggml-base next to " + g_libpath);
  #define GS(v, s) auto v = (s##_t) dlsym(gh, #s); if (!v) { dlclose(gh); return fail("missing symbol " #s); }
  GS(_init,   ggml_init);            GS(_free,   ggml_free);
  GS(_nt1,    ggml_new_tensor_1d);   GS(_nt2,    ggml_new_tensor_2d);
  GS(_gdata,  ggml_get_data);        GS(_sname,  ggml_set_name);
  GS(_rsize,  ggml_row_size);        GS(_toh,    ggml_tensor_overhead);
  GS(_quant,  ggml_quantize_chunk);  GS(_f16row, ggml_fp32_to_fp16_row);   GS(_bf16row, ggml_bf16_to_fp32_row);
  GS(_gempty, gguf_init_empty);      GS(_gfromf, gguf_init_from_file);     GS(_gfree, gguf_free);
  GS(_gsetkv, gguf_set_kv);          GS(_gvstr,  gguf_set_val_str);        GS(_gvu32, gguf_set_val_u32);
  GS(_gvf32,  gguf_set_val_f32);     GS(_garr,   gguf_set_arr_data);       GS(_gaddt, gguf_add_tensor);
  GS(_gwrite, gguf_write_to_file);
  #undef GS
  auto cleanup = [&](void* mctx, void* gw, int fd, void* map, size_t maplen) {
    if (map && map != MAP_FAILED) munmap(map, maplen);
    if (fd >= 0) close(fd);
    if (gw)   _gfree(gw);
    if (mctx) _free(mctx);
    dlclose(gh);
  };

  const std::string st_path  = in.Get("safetensors").As<Napi::String>();
  const std::string tgt_gguf = in.Get("target_gguf").As<Napi::String>();
  const std::string outfile  = in.Get("outfile").As<Napi::String>();
  const std::string outtype  = in.Has("outtype") ? in.Get("outtype").As<Napi::String>().Utf8Value() : "q8_0";
  const int wtype = (outtype == "f16") ? GGML_TYPE_F16 : GGML_TYPE_Q8_0;
  Napi::Object meta = in.Get("meta").As<Napi::Object>();
  Napi::Array tensors = in.Get("tensors").As<Napi::Array>();
  auto mi = [&](const char* k){ return meta.Has(k) ? meta.Get(k).As<Napi::Number>().Int32Value() : 0; };
  auto mf = [&](const char* k){ return meta.Has(k) ? meta.Get(k).As<Napi::Number>().FloatValue() : 0.0f; };

  // Build the GGUF: start from the target's KVs (tokenizer + general), then override the dflash arch.
  void* gw = _gempty();
  { gguf_init_params p{ true, nullptr };
    void* tctx = _gfromf(tgt_gguf.c_str(), p);
    if (tctx) { _gsetkv(gw, tctx); _gfree(tctx); }
    else { cleanup(nullptr, gw, -1, nullptr, 0); return fail("could not read target gguf " + tgt_gguf); } }
  _gvstr(gw, "general.architecture", "dflash");
  if (in.Has("general_name")) _gvstr(gw, "general.name", in.Get("general_name").As<Napi::String>().Utf8Value().c_str());
  _gvu32(gw, "dflash.context_length",   (uint32_t) mi("n_ctx_train"));
  _gvu32(gw, "dflash.embedding_length", (uint32_t) mi("n_embd"));
  _gvu32(gw, "dflash.block_count",      (uint32_t) mi("n_layer"));
  _gvu32(gw, "dflash.feed_forward_length",           (uint32_t) mi("n_ff"));
  _gvu32(gw, "dflash.attention.head_count",          (uint32_t) mi("n_head"));
  _gvu32(gw, "dflash.attention.head_count_kv",       (uint32_t) mi("n_head_kv"));
  _gvu32(gw, "dflash.attention.key_length",          (uint32_t) mi("head_dim"));
  _gvu32(gw, "dflash.attention.value_length",        (uint32_t) mi("head_dim"));
  _gvf32(gw, "dflash.attention.layer_norm_rms_epsilon", mf("rms_eps"));
  _gvf32(gw, "dflash.rope.freq_base",                mf("rope_theta"));
  _gvu32(gw, "dflash.block_size",       (uint32_t) mi("block_size"));
  _gvu32(gw, "dflash.vocab_size",       (uint32_t) mi("n_vocab"));
  { Napi::Array tl = in.Get("target_layers").As<Napi::Array>();
    std::vector<int32_t> v(tl.Length());
    for (uint32_t i = 0; i < tl.Length(); ++i) v[i] = tl.Get(i).As<Napi::Number>().Int32Value();
    _garr(gw, "dflash.target_layers", GGUF_TYPE_INT32, v.data(), v.size()); }

  // mmap the safetensors.
  int fd = open(st_path.c_str(), O_RDONLY);
  if (fd < 0) { cleanup(nullptr, gw, -1, nullptr, 0); return fail("open " + st_path); }
  struct stat sb; fstat(fd, &sb);
  size_t maplen = (size_t) sb.st_size;
  void* map = mmap(nullptr, maplen, PROT_READ, MAP_PRIVATE, fd, 0);
  if (map == MAP_FAILED) { cleanup(nullptr, gw, fd, nullptr, 0); return fail("mmap " + st_path); }
  const uint8_t* base = (const uint8_t*) map;

  // Pre-size a ggml context to hold every output tensor's data + struct overhead.
  size_t need = _toh() * (tensors.Length() + 2);
  for (uint32_t i = 0; i < tensors.Length(); ++i) {
    Napi::Object t = tensors.Get(i).As<Napi::Object>();
    int64_t ne0 = t.Get("ne0").As<Napi::Number>().Int64Value();
    int64_t ne1 = t.Has("ne1") ? t.Get("ne1").As<Napi::Number>().Int64Value() : 0;
    bool is1d = (ne1 == 0);
    int wt = is1d ? GGML_TYPE_F32 : wtype;
    need += _rsize(wt, ne0) * (is1d ? 1 : ne1) + 256;
  }
  ggml_init_params ip{ need, nullptr, false };
  void* mctx = _init(ip);
  if (!mctx) { cleanup(nullptr, gw, fd, map, maplen); return fail("ggml_init failed"); }

  std::vector<float> f32;   // reused BF16→F32 scratch
  for (uint32_t i = 0; i < tensors.Length(); ++i) {
    Napi::Object t = tensors.Get(i).As<Napi::Object>();
    std::string name = t.Get("gguf_name").As<Napi::String>();
    int64_t off = t.Get("offset").As<Napi::Number>().Int64Value();      // absolute byte offset of BF16 data
    int64_t ne0 = t.Get("ne0").As<Napi::Number>().Int64Value();
    int64_t ne1 = t.Has("ne1") ? t.Get("ne1").As<Napi::Number>().Int64Value() : 0;
    bool is1d = (ne1 == 0);
    int64_t n  = is1d ? ne0 : ne0 * ne1;
    if (off < 0 || (size_t)(off + n * 2) > maplen) { cleanup(mctx, gw, fd, map, maplen); return fail("tensor out of range: " + name); }

    f32.resize((size_t) n);
    _bf16row((const uint16_t*)(base + off), f32.data(), n);            // BF16 → F32

    void* tn = is1d ? _nt1(mctx, GGML_TYPE_F32, ne0) : _nt2(mctx, wtype, ne0, ne1);
    if (!tn) { cleanup(mctx, gw, fd, map, maplen); return fail("ggml_new_tensor failed (context too small?): " + name); }
    void* dst = _gdata(tn);
    if (is1d)                         std::memcpy(dst, f32.data(), (size_t) n * sizeof(float)); // norms stay F32
    else if (wtype == GGML_TYPE_F16)  _f16row(f32.data(), (uint16_t*)dst, n);
    else                              _quant(GGML_TYPE_Q8_0, f32.data(), dst, 0, ne1, ne0, nullptr);
    _sname(tn, name.c_str());
    _gaddt(gw, tn);
  }

  bool ok = _gwrite(gw, outfile.c_str(), false);
  cleanup(mctx, gw, fd, map, maplen);
  Napi::Object o = Napi::Object::New(env);
  o.Set("ok", ok);
  if (!ok) o.Set("error", "gguf_write_to_file failed");
  return o;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("load_library",     Napi::Function::New(env, LoadLibrary));
    exports.Set("init_model",       Napi::Function::New(env, InitModel));
    exports.Set("run",              Napi::Function::New(env, Run));
    exports.Set("run_dflash",       Napi::Function::New(env, RunDflash));
    exports.Set("convert_dflash_gguf", Napi::Function::New(env, ConvertDflashGguf));
    exports.Set("unload_model",     Napi::Function::New(env, UnloadModel));
    exports.Set("abort_inference",  Napi::Function::New(env, AbortInference));
    exports.Set("clear_kv_cache",   Napi::Function::New(env, ClearKVCache));
    exports.Set("rollback_kv_cache", Napi::Function::New(env, RollbackKVCache));
    return exports;
}

NODE_API_MODULE(orkllm_llama_napi, Init)
