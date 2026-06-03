#include <napi.h>
#include <thread>
#include <mutex>
#include <queue>
#include <string>
#include <iostream>
#include <cstring>

#ifdef _WIN32
#include <windows.h>
#define DYNLIB_HANDLE HMODULE
#define DYNLIB_LOAD(path) LoadLibraryA(path)
#define DYNLIB_GETSYM(handle, name) GetProcAddress(handle, name)
#define DYNLIB_FREE(handle) FreeLibrary(handle)
#else
#include <dlfcn.h>
#define DYNLIB_HANDLE void*
#define DYNLIB_LOAD(path) dlopen(path, RTLD_LAZY)
#define DYNLIB_GETSYM(handle, name) dlsym(handle, name)
#define DYNLIB_FREE(handle) dlclose(handle)
#endif

// Enums
enum LLMCallState {
    RKLLM_RUN_NORMAL = 0,
    RKLLM_RUN_WAITING = 1,
    RKLLM_RUN_FINISH = 2,
    RKLLM_RUN_ERROR = 3
};

enum RKLLMInputType {
    RKLLM_INPUT_PROMPT = 0,
    RKLLM_INPUT_TOKEN = 1,
    RKLLM_INPUT_EMBED = 2,
    RKLLM_INPUT_MULTIMODAL = 3
};

enum RKLLMInferMode {
    RKLLM_INFER_GENERATE = 0,
    RKLLM_INFER_GET_LAST_HIDDEN_LAYER = 1,
    RKLLM_INFER_GET_LOGITS = 2
};

// Structures
struct RKLLMExtendParam {
    int32_t base_domain_id;
    int8_t embed_flash;
    int8_t enabled_cpus_num;
    uint32_t enabled_cpus_mask;
    uint8_t n_batch;
    int8_t use_cross_attn;
    uint8_t reserved[104];
};

struct RKLLMParam {
    const char* model_path;
    int32_t max_context_len;
    int32_t max_new_tokens;
    float top_k;
    int32_t n_keep;
    float top_p;
    float temperature;
    float repeat_penalty;
    float frequency_penalty;
    float presence_penalty;
    int32_t mirostat;
    float mirostat_tau;
    float mirostat_eta;
    bool skip_special_token;
    bool is_async;
    bool enable_thinking;
    const char* img_start;
    const char* img_end;
    const char* img_content;
    RKLLMExtendParam extend_param;
    bool use_gpu;
};

struct RKLLMLoraAdapter {
    const char* lora_adapter_path;
    const char* lora_adapter_name;
    float scale;
};

struct RKLLMEmbedInput {
    float* embed;
    size_t n_tokens;
};

struct RKLLMTokenInput {
    int32_t* input_ids;
    size_t n_tokens;
};

struct RKLLMMultiModelInput {
    const char* prompt;
    float* image_embed;
    size_t n_image_tokens;
    size_t n_image;
    size_t image_width;
    size_t image_height;
};

union RKLLMInputUnion {
    const char* prompt_input;
    RKLLMEmbedInput embed_input;
    RKLLMTokenInput token_input;
    RKLLMMultiModelInput multimodal_input;
};

struct RKLLMInput {
    const char* role;
    bool enable_thinking;
    RKLLMInputType input_type;
    RKLLMInputUnion input_data;
};

struct RKLLMLoraParam {
    const char* lora_adapter_name;
};

struct RKLLMPromptCacheParam {
    int save_prompt_cache;
    const char* prompt_cache_path;
};

struct RKLLMInferParam {
    RKLLMInferMode mode;
    RKLLMLoraParam* lora_params;
    RKLLMPromptCacheParam* prompt_cache_params;
    int keep_history;
};

struct RKLLMResultLastHiddenLayer {
    float* hidden_states;
    int embd_size;
    int num_tokens;
};

struct RKLLMResultLogits {
    float* logits;
    int vocab_size;
    int num_tokens;
};

struct RKLLMPerfStat {
    float prefill_time_ms;
    int prefill_tokens;
    float generate_time_ms;
    int generate_tokens;
    float memory_usage_mb;
};

struct RKLLMResult {
    const char* text;
    int token_id;
    RKLLMResultLastHiddenLayer last_hidden_layer;
    RKLLMResultLogits logits;
    RKLLMPerfStat perf;
};

typedef void* RKLLM_Handle_t;
typedef int (*LLMResultCallback)(RKLLMResult* result, void* userdata, LLMCallState state);

// Dynamic library function signatures
typedef int (*rkllm_init_t)(RKLLM_Handle_t* handle, RKLLMParam* param, LLMResultCallback callback);
typedef int (*rkllm_run_t)(RKLLM_Handle_t handle, RKLLMInput* input, RKLLMInferParam* param, void* userdata);
typedef int (*rkllm_destroy_t)(RKLLM_Handle_t handle);
typedef int (*rkllm_clear_kv_cache_t)(RKLLM_Handle_t handle, int type, int* reserved1, int* reserved2);
typedef int (*rkllm_abort_t)(RKLLM_Handle_t handle);
typedef int (*rkllm_load_prompt_cache_t)(RKLLM_Handle_t handle, const char* prompt_cache_path);

// Global state variables
DYNLIB_HANDLE g_libHandle = nullptr;
RKLLM_Handle_t g_handle = nullptr;

rkllm_init_t g_rkllm_init = nullptr;
rkllm_run_t g_rkllm_run = nullptr;
rkllm_destroy_t g_rkllm_destroy = nullptr;
rkllm_clear_kv_cache_t g_rkllm_clear_kv_cache = nullptr;
rkllm_abort_t g_rkllm_abort = nullptr;
rkllm_load_prompt_cache_t g_rkllm_load_prompt_cache = nullptr;

struct RequestContext {
    Napi::ThreadSafeFunction tsfn;
};

// Global callback function registered with rkllm_init
int GlobalLLMCallback(RKLLMResult* result, void* userdata, LLMCallState state) {
    if (userdata == nullptr) return 0;
    
    RequestContext* ctx = static_cast<RequestContext*>(userdata);
    
    std::string text = "";
    float prefill_time = 0;
    int prefill_tokens = 0;
    float gen_time = 0;
    int gen_tokens = 0;
    
    int token_id = -1;
    if (result != nullptr) {
        if (result->text != nullptr) {
            text = result->text;
        }
        token_id = result->token_id;
        prefill_time = result->perf.prefill_time_ms;
        prefill_tokens = result->perf.prefill_tokens;
        gen_time = result->perf.generate_time_ms;
        gen_tokens = result->perf.generate_tokens;
    }

    // Broadcast token back to JS thread-safely
    ctx->tsfn.NonBlockingCall([text, token_id, state, prefill_time, prefill_tokens, gen_time, gen_tokens](Napi::Env env, Napi::Function jsCallback) {
        Napi::Object resultObj = Napi::Object::New(env);
        resultObj.Set("text", Napi::String::New(env, text));
        resultObj.Set("token_id", Napi::Number::New(env, token_id));
        resultObj.Set("state", Napi::Number::New(env, static_cast<int>(state)));

        Napi::Object perfObj = Napi::Object::New(env);
        perfObj.Set("prefill_time_ms", Napi::Number::New(env, prefill_time));
        perfObj.Set("prefill_tokens", Napi::Number::New(env, prefill_tokens));
        perfObj.Set("generate_time_ms", Napi::Number::New(env, gen_time));
        perfObj.Set("generate_tokens", Napi::Number::New(env, gen_tokens));

        resultObj.Set("perf", perfObj);

        jsCallback.Call({ resultObj });
    });
    
    if (state == RKLLM_RUN_FINISH || state == RKLLM_RUN_ERROR) {
        ctx->tsfn.Release();
        delete ctx;
    }
    return 0;
}

Napi::Value LoadLibrary(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string path to librkllmrt.so").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string path = info[0].As<Napi::String>().Utf8Value();
    
    if (g_libHandle != nullptr) {
        DYNLIB_FREE(g_libHandle);
        g_libHandle = nullptr;
    }
    
    g_libHandle = DYNLIB_LOAD(path.c_str());
    if (g_libHandle == nullptr) {
        return Napi::Boolean::New(env, false);
    }
    
    g_rkllm_init = (rkllm_init_t)DYNLIB_GETSYM(g_libHandle, "rkllm_init");
    g_rkllm_run = (rkllm_run_t)DYNLIB_GETSYM(g_libHandle, "rkllm_run");
    g_rkllm_destroy = (rkllm_destroy_t)DYNLIB_GETSYM(g_libHandle, "rkllm_destroy");
    g_rkllm_clear_kv_cache = (rkllm_clear_kv_cache_t)DYNLIB_GETSYM(g_libHandle, "rkllm_clear_kv_cache");
    g_rkllm_abort = (rkllm_abort_t)DYNLIB_GETSYM(g_libHandle, "rkllm_abort");
    // Optional: rkllm_load_prompt_cache may not be present in all runtime versions
    g_rkllm_load_prompt_cache = (rkllm_load_prompt_cache_t)DYNLIB_GETSYM(g_libHandle, "rkllm_load_prompt_cache");

    if (!g_rkllm_init || !g_rkllm_run || !g_rkllm_destroy || !g_rkllm_clear_kv_cache || !g_rkllm_abort) {
        DYNLIB_FREE(g_libHandle);
        g_libHandle = nullptr;
        return Napi::Boolean::New(env, false);
    }
    
    return Napi::Boolean::New(env, true);
}

Napi::Value InitModel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_libHandle == nullptr) {
        Napi::Error::New(env, "Library not loaded").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsObject()) {
        Napi::TypeError::New(env, "Expected (model_path, options)").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string modelPath = info[0].As<Napi::String>().Utf8Value();
    Napi::Object options = info[1].As<Napi::Object>();
    
    // Persist model path in static string memory so ptr remains valid
    static std::string s_modelPath;
    s_modelPath = modelPath;
    
    RKLLMParam param;
    memset(&param, 0, sizeof(RKLLMParam));
    param.model_path = s_modelPath.c_str();
    
    param.max_context_len = options.Has("max_context_len") ? options.Get("max_context_len").As<Napi::Number>().Int32Value() : 2048;
    param.max_new_tokens = options.Has("max_new_tokens") ? options.Get("max_new_tokens").As<Napi::Number>().Int32Value() : 512;
    param.top_k = options.Has("top_k") ? options.Get("top_k").As<Napi::Number>().FloatValue() : 40.0f;
    param.use_gpu = true;
    param.top_p = options.Has("top_p") ? options.Get("top_p").As<Napi::Number>().FloatValue() : 0.9f;
    param.temperature = options.Has("temperature") ? options.Get("temperature").As<Napi::Number>().FloatValue() : 0.8f;
    param.repeat_penalty = options.Has("repeat_penalty") ? options.Get("repeat_penalty").As<Napi::Number>().FloatValue() : 1.1f;
    param.frequency_penalty = options.Has("frequency_penalty") ? options.Get("frequency_penalty").As<Napi::Number>().FloatValue() : 0.0f;
    param.presence_penalty = options.Has("presence_penalty") ? options.Get("presence_penalty").As<Napi::Number>().FloatValue() : 0.0f;
    param.mirostat = options.Has("mirostat") ? options.Get("mirostat").As<Napi::Number>().Int32Value() : 0;
    param.mirostat_tau = options.Has("mirostat_tau") ? options.Get("mirostat_tau").As<Napi::Number>().FloatValue() : 5.0f;
    param.mirostat_eta = options.Has("mirostat_eta") ? options.Get("mirostat_eta").As<Napi::Number>().FloatValue() : 0.1f;
    
    param.enable_thinking = options.Has("enable_thinking") && options.Get("enable_thinking").As<Napi::Boolean>().Value();
    param.skip_special_token = true;
    param.img_start = "";
    param.img_end = "";
    param.img_content = "";

    // base_domain_id selects which NPU compute domain (core) to use.
    // 1 = domain 1 (default, uses both cores for single-model max throughput)
    // 2 = domain 2 (pin to second core for multi-worker parallel serving)
    param.extend_param.base_domain_id =
        options.Has("base_domain_id")
            ? options.Get("base_domain_id").As<Napi::Number>().Int32Value()
            : 1;
    param.extend_param.embed_flash = 1;
    param.extend_param.n_batch = 1;
    param.extend_param.use_cross_attn = 0;
    param.extend_param.enabled_cpus_num = 4;

    if (options.Has("enabled_cpus_mask")) {
        param.extend_param.enabled_cpus_mask = options.Get("enabled_cpus_mask").As<Napi::Number>().Uint32Value();
    } else {
        param.extend_param.enabled_cpus_mask = 240; // Default to cores 4,5,6,7 (big cores mask)
    }
    
    int ret = g_rkllm_init(&g_handle, &param, GlobalLLMCallback);
    if (ret != 0) {
        g_handle = nullptr;
    }
    
    return Napi::Number::New(env, ret);
}

Napi::Value Run(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_libHandle == nullptr || g_handle == nullptr) {
        Napi::Error::New(env, "RKLLM model is not initialized").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected (input_object, callback_function)").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    Napi::Object inputObj = info[0].As<Napi::Object>();
    Napi::Function jsCallback = info[1].As<Napi::Function>();
    
    std::string prompt = inputObj.Has("prompt") ? inputObj.Get("prompt").As<Napi::String>().Utf8Value() : "";
    std::string loadCachePath = inputObj.Has("loadCachePath") && inputObj.Get("loadCachePath").IsString()
        ? inputObj.Get("loadCachePath").As<Napi::String>().Utf8Value() : "";
    std::string saveCachePath = inputObj.Has("saveCachePath") && inputObj.Get("saveCachePath").IsString()
        ? inputObj.Get("saveCachePath").As<Napi::String>().Utf8Value() : "";
    // infer_mode: 0=RKLLM_INFER_GENERATE (default), 2=RKLLM_INFER_GET_LOGITS (spec decode verify)
    int inferMode = inputObj.Has("infer_mode") && inputObj.Get("infer_mode").IsNumber()
        ? inputObj.Get("infer_mode").As<Napi::Number>().Int32Value() : 0;

    RequestContext* ctx = new RequestContext();
    ctx->tsfn = Napi::ThreadSafeFunction::New(
        env,
        jsCallback,
        "RKLLMCallback",
        0, // infinite queue
        1  // 1 thread reference
    );

    // Spawn background thread to run inference synchronously without blocking the event loop
    std::thread runThread([prompt, loadCachePath, saveCachePath, inferMode, ctx]() {
        // Load prefix KV cache from disk if provided
        if (!loadCachePath.empty() && g_rkllm_load_prompt_cache) {
            g_rkllm_load_prompt_cache(g_handle, loadCachePath.c_str());
        }

        RKLLMInput input;
        memset(&input, 0, sizeof(RKLLMInput));
        input.input_type = RKLLM_INPUT_PROMPT;
        input.input_data.prompt_input = prompt.c_str();

        RKLLMInferParam inferParam;
        memset(&inferParam, 0, sizeof(RKLLMInferParam));
        // infer_mode: 0=generate (default), 2=get_logits (for speculative decode verification)
        inferParam.mode = static_cast<RKLLMInferMode>(inferMode);
        inferParam.keep_history = 0;

        RKLLMPromptCacheParam cacheParam;
        if (!saveCachePath.empty()) {
            memset(&cacheParam, 0, sizeof(RKLLMPromptCacheParam));
            cacheParam.save_prompt_cache = 1;
            cacheParam.prompt_cache_path = saveCachePath.c_str();
            inferParam.prompt_cache_params = &cacheParam;
        }

        int ret = g_rkllm_run(g_handle, &input, &inferParam, static_cast<void*>(ctx));
        if (ret != 0) {
            // If run failed to trigger, call error and clean up
            ctx->tsfn.NonBlockingCall([](Napi::Env env, Napi::Function jsCallback) {
                Napi::Object resultObj = Napi::Object::New(env);
                resultObj.Set("text", Napi::String::New(env, ""));
                resultObj.Set("state", Napi::Number::New(env, static_cast<int>(RKLLM_RUN_ERROR)));
                jsCallback.Call({ resultObj });
            });
            ctx->tsfn.Release();
            delete ctx;
        }
    });
    runThread.detach();
    
    return env.Null();
}

Napi::Value UnloadModel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_libHandle == nullptr) {
        return Napi::Number::New(env, -1);
    }
    if (g_handle == nullptr) {
        return Napi::Number::New(env, 0);
    }
    
    int ret = g_rkllm_destroy(g_handle);
    g_handle = nullptr;
    return Napi::Number::New(env, ret);
}

Napi::Value AbortInference(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_libHandle == nullptr || g_handle == nullptr) {
        return Napi::Number::New(env, -1);
    }
    int ret = g_rkllm_abort(g_handle);
    return Napi::Number::New(env, ret);
}

Napi::Value ClearKVCache(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_libHandle == nullptr || g_handle == nullptr) {
        return Napi::Number::New(env, -1);
    }
    int ret = g_rkllm_clear_kv_cache(g_handle, 1, nullptr, nullptr);
    return Napi::Number::New(env, ret);
}

Napi::Value LoadPromptCache(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_libHandle == nullptr || g_handle == nullptr) {
        return Napi::Number::New(env, -1);
    }
    if (!g_rkllm_load_prompt_cache) {
        return Napi::Number::New(env, -2); // not supported by this runtime version
    }
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string cache path").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string cachePath = info[0].As<Napi::String>().Utf8Value();
    int ret = g_rkllm_load_prompt_cache(g_handle, cachePath.c_str());
    return Napi::Number::New(env, ret);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "load_library"), Napi::Function::New(env, LoadLibrary));
    exports.Set(Napi::String::New(env, "init_model"), Napi::Function::New(env, InitModel));
    exports.Set(Napi::String::New(env, "run"), Napi::Function::New(env, Run));
    exports.Set(Napi::String::New(env, "unload_model"), Napi::Function::New(env, UnloadModel));
    exports.Set(Napi::String::New(env, "abort_inference"), Napi::Function::New(env, AbortInference));
    exports.Set(Napi::String::New(env, "clear_kv_cache"), Napi::Function::New(env, ClearKVCache));
    exports.Set(Napi::String::New(env, "load_prompt_cache"), Napi::Function::New(env, LoadPromptCache));
    return exports;
}

NODE_API_MODULE(orkllm_napi, Init)
