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

// Struct layout verified against llama.cpp-rockchip include/llama.h.
// Must be kept in sync with that header to avoid ABI mismatches when calling
// llama_model_default_params / llama_context_default_params by value.
struct llama_model_params {
    // Two pointer fields added in newer llama.cpp before n_gpu_layers
    void *devices;                    // ggml_backend_dev_t** NULL-terminated device list
    void *tensor_buft_overrides;      // const llama_model_tensor_buft_override*
    int32_t n_gpu_layers;
    int32_t split_mode;               // enum llama_split_mode (int32)
    int32_t main_gpu;
    // implicit 4-byte padding before pointer (ABI alignment)
    const float *tensor_split;
    void (*progress_callback)(float, void *);
    void *progress_callback_user_data;
    const struct llama_model_kv_override *kv_overrides;
    bool vocab_only;
    bool use_mmap;
    bool use_mlock;
    bool check_tensors;
};

struct llama_context_params {
    uint32_t n_ctx;
    uint32_t n_batch;
    uint32_t n_ubatch;
    uint32_t n_seq_max;
    int32_t  n_threads;
    int32_t  n_threads_batch;
    int32_t  rope_scaling_type;       // enum llama_rope_scaling_type
    int32_t  pooling_type;            // enum llama_pooling_type
    int32_t  attention_type;          // enum llama_attention_type
    float    rope_freq_base;
    float    rope_freq_scale;
    float    yarn_ext_factor;
    float    yarn_attn_factor;
    float    yarn_beta_fast;
    float    yarn_beta_slow;
    uint32_t yarn_orig_ctx;
    float    defrag_thold;
    // implicit 4-byte padding before pointer (ABI alignment)
    void *cb_eval;                    // ggml_backend_sched_eval_callback
    void *cb_eval_user_data;
    int32_t type_k;                   // enum ggml_type for K-cache
    int32_t type_v;                   // enum ggml_type for V-cache
    void *abort_callback;             // ggml_abort_callback (fn ptr, added in newer llama.cpp)
    void *abort_callback_data;
    // booleans kept at end per llama.cpp comment (avoid misalignment during copy-by-value)
    bool embeddings;
    bool offload_kqv;
    bool flash_attn;
    bool no_perf;
    bool op_offload;
    bool swa_full;
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
typedef void     (*llama_kv_self_clear_t)(struct llama_context *);
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
typedef llama_token (*llama_sampler_sample_t)(struct llama_sampler *, struct llama_context *, int32_t);
typedef void     (*llama_sampler_free_t)(struct llama_sampler *);
typedef bool     (*llama_token_is_eog_t)(const struct llama_vocab *, llama_token);
typedef int32_t  (*llama_n_ctx_t)(const struct llama_context *);
typedef int32_t  (*llama_kv_self_used_cells_t)(const struct llama_context *);
typedef void     (*llama_sampler_accept_t)(struct llama_sampler *, llama_token);
typedef int32_t  (*llama_model_n_embd_t)(const struct llama_model *);
typedef float *  (*llama_get_logits_ith_t)(struct llama_context *, int32_t);
typedef float *  (*llama_get_embeddings_ith_t)(struct llama_context *, int32_t);

// ── Global state ──────────────────────────────────────────────────────────────
static DYNLIB_HANDLE g_lib = nullptr;
static struct llama_model        *g_model   = nullptr;
static const struct llama_vocab  *g_vocab   = nullptr;
static struct llama_context      *g_ctx     = nullptr;
static struct llama_sampler      *g_sampler = nullptr;
static std::atomic<bool>          g_abort{false};

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
static llama_state_seq_save_file_t       fn_state_save     = nullptr;
static llama_state_seq_load_file_t       fn_state_load     = nullptr;
static llama_sampler_chain_init_t        fn_schain_init    = nullptr;
static llama_sampler_chain_default_params_t fn_schain_par  = nullptr;
static llama_sampler_chain_add_t         fn_schain_add     = nullptr;
static llama_sampler_init_top_k_t        fn_s_topk         = nullptr;
static llama_sampler_init_top_p_t        fn_s_topp         = nullptr;
static llama_sampler_init_temp_t         fn_s_temp         = nullptr;
static llama_sampler_init_dist_t         fn_s_dist         = nullptr;
static llama_sampler_sample_t            fn_sample         = nullptr;
static llama_sampler_accept_t            fn_samp_accept    = nullptr;
static llama_sampler_free_t              fn_samp_free      = nullptr;
static llama_token_is_eog_t              fn_is_eog         = nullptr;
static llama_n_ctx_t                     fn_n_ctx          = nullptr;
static llama_kv_self_used_cells_t        fn_kv_used        = nullptr;
static llama_model_n_embd_t              fn_n_embd         = nullptr;
static llama_get_logits_ith_t            fn_get_logits_ith = nullptr;
static llama_get_embeddings_ith_t        fn_get_embeddings_ith = nullptr;

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
    LOAD_SYM2(state_save,    "llama_state_seq_save_file");
    LOAD_SYM2(state_load,    "llama_state_seq_load_file");
    LOAD_SYM2(schain_init,   "llama_sampler_chain_init");
    LOAD_SYM2(schain_par,    "llama_sampler_chain_default_params");
    LOAD_SYM2(schain_add,    "llama_sampler_chain_add");
    LOAD_SYM2(s_topk,        "llama_sampler_init_top_k");
    LOAD_SYM2(s_topp,        "llama_sampler_init_top_p");
    LOAD_SYM2(s_temp,        "llama_sampler_init_temp");
    LOAD_SYM2(s_dist,        "llama_sampler_init_dist");
    LOAD_SYM2(sample,        "llama_sampler_sample");
    LOAD_SYM2(samp_accept,   "llama_sampler_accept");
    LOAD_SYM2(samp_free,     "llama_sampler_free");
    LOAD_SYM2(is_eog,        "llama_token_is_eog");
    LOAD_SYM2(n_ctx,         "llama_n_ctx");
    LOAD_SYM2(kv_used,       "llama_kv_self_used_cells");
    LOAD_SYM2(n_embd,        "llama_model_n_embd");
    LOAD_SYM2(get_logits_ith,"llama_get_logits_ith");
    LOAD_SYM2(get_embeddings_ith, "llama_get_embeddings_ith");

    if (!fn_backend_init || !fn_model_load || !fn_ctx_init || !fn_decode ||
        !fn_tokenize || !fn_tok2piece || !fn_sample || !fn_is_eog) {
        DYNLIB_FREE(g_lib); g_lib = nullptr;
        return Napi::Boolean::New(env, false);
    }

    fn_backend_init();
    return Napi::Boolean::New(env, true);
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

    auto mpar = fn_model_def_par();
    mpar.n_gpu_layers = 999; // offload all to NPU/GPU via ggml-ork backend
    mpar.use_mmap = true;

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
    fn_schain_add(g_sampler, fn_s_dist(0xDEADBEEF));

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
    int maxNewTokens = 512;

    int inferMode = input.Has("infer_mode") && input.Get("infer_mode").IsNumber() ? input.Get("infer_mode").As<Napi::Number>().Int32Value() : 0;
    bool keepHistory = input.Has("keep_history") && input.Get("keep_history").As<Napi::Boolean>().Value();
    std::vector<int32_t> tokenIds;
    bool useTokenInput = false;
    if (input.Has("token_ids") && input.Get("token_ids").IsTypedArray()) {
        auto arr = input.Get("token_ids").As<Napi::Int32Array>();
        tokenIds.assign(arr.Data(), arr.Data() + arr.ElementLength());
        useTokenInput = !tokenIds.empty();
    }

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
            fn_state_load(g_ctx, loadCachePath.c_str(), 0, nullptr, 0, &tokens_loaded);
            if (tokens_loaded > 0) n_past = tokens_loaded;
            else if (fn_kv_used) n_past = fn_kv_used(g_ctx);
        } else if (keepHistory && fn_kv_used) {
            n_past = fn_kv_used(g_ctx);
        } else if (fn_kv_clear) {
            fn_kv_clear(g_ctx);
        }

        auto t0 = std::chrono::high_resolution_clock::now();

        // Decode the prompt (prefill)
        for (int i = 0; i < n && !g_abort; ) {
            int batch = std::min(n - i, 512);
            auto b = fn_batch_one(toks.data() + i, batch);
            for (int j = 0; j < batch; j++) {
                b.pos[j] = n_past + j;
                if (inferMode == 1 || inferMode == 2) b.logits[j] = 1;
            }
            if (fn_decode(g_ctx, b) != 0) { finish("", 3); return; }
            
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
        }
        auto t1 = std::chrono::high_resolution_clock::now();
        prefill_time = std::chrono::duration<float, std::milli>(t1 - t0).count();
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
            std::vector<llama_token> next = {tok};
            auto b = fn_batch_one(next.data(), 1);
            b.pos[0] = n_past;
            if (fn_decode(g_ctx, b) != 0) break;
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
    if (g_ctx && fn_kv_clear) fn_kv_clear(g_ctx);
    return Napi::Number::New(info.Env(), 0);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("load_library",     Napi::Function::New(env, LoadLibrary));
    exports.Set("init_model",       Napi::Function::New(env, InitModel));
    exports.Set("run",              Napi::Function::New(env, Run));
    exports.Set("unload_model",     Napi::Function::New(env, UnloadModel));
    exports.Set("abort_inference",  Napi::Function::New(env, AbortInference));
    exports.Set("clear_kv_cache",   Napi::Function::New(env, ClearKVCache));
    return exports;
}

NODE_API_MODULE(orkllm_llama_napi, Init)
