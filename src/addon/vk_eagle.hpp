// Vulkan compute harness for the Eagle-3 speculative-decoding draft head.
//
// Runs an AngelSlim-style EAGLE-3 draft head (one transformer decoder layer +
// LM head) on the Mali GPU (panvk / Mesa) via UMA. The heavy matmuls run as
// BF16 GEMV compute dispatches; RoPE, GQA attention, residual adds, RMSNorm of
// 2560-vectors and the final argmax run on the CPU (all trivially small).
//
// The draft produces k tokens autoregressively (a chain), each step feeding the
// previous draft token's embedding + pre-norm hidden state back in. Token IDs
// are remapped from the compressed draft vocab (32000) to the full target vocab
// (151936) via the d2t offset table before being returned for NPU verification.
//
// Architecture: an AngelSlim-style EAGLE-3 head — fc (3*embd -> embd), one
// decoder layer (GQA attn, head_dim from config.json, input 2*embd), SwiGLU MLP,
// and an LM head over a compressed draft vocab remapped via d2t. All dimensions
// (embd, draft_vocab, q/kv dims, intermediate) are derived at load time from the
// head's safetensors tensor shapes, so any EAGLE-3 head loads — not just the
// Qwen3-VL-4B reference (embd 2560, 32/8 heads, head_dim 128, inter 9728).
// Weights upload as BF16; F16 heads (e.g. AngelSlim Qwen3-1.7B) are converted.
//
// Known v1 approximation: GET_LAST_HIDDEN_LAYER exposes only the target's last
// layer, but fc was trained on concat(low, mid, high). v1 replicates the last
// layer 3x into fc. Acceptance rate must be measured empirically (AGENTS.md §10).
//
// Falls back gracefully (ok() == false) if no compatible GPU is found, so the
// JS layer can drop back to the CPU placeholder draft.

#pragma once
#ifdef HAS_VULKAN

#include <vulkan/vulkan.h>
#include <cstring>
#include <cstdlib>
#include <cmath>
#include <cstdio>
#include <vector>
#include <string>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <fstream>
#include <fcntl.h>
#include <unistd.h>

#ifndef VK_CHECK
#define VK_CHECK(expr) do {                                   \
    VkResult _r = (expr);                                     \
    if (_r != VK_SUCCESS)                                     \
        throw std::runtime_error(std::string(#expr) +         \
            " failed: " + std::to_string((int)_r));           \
} while(0)
#endif

#include "vk_eagle_gemv_spv.h"
#include "vk_eagle_layernorm_spv.h"
#include "vk_eagle_swiglu_spv.h"

class VkEagleDraftHead {
public:
    static VkEagleDraftHead& get() {
        static VkEagleDraftHead inst;
        static std::once_flag flag;
        std::call_once(flag, [&]{ inst.init(); });
        return inst;
    }

    bool ok() const { return ready_; }

    // Override hyperparameters from the head's config.json (the harness defaults
    // suit Qwen3-VL-4B_eagle3 but other heads may differ).
    void set_rope_theta(float t) { rope_theta_ = t; }
    void set_rms_eps(float e)     { rms_eps_ = e; }
    // Per-head attention head_dim (0 → keep the derived/default). Set from the
    // head's config.json before load_weights; used to split Q/KV into heads.
    void set_head_dim(uint32_t hd) { if (hd) cfg_head_dim_ = hd; }

    // Parse the draft-head safetensors into UMA GPU buffers and open the
    // embeddings file for per-row reads. Cached: a second call with the same
    // paths is a no-op. Returns false on any parse/upload failure.
    bool load_weights(const std::string& head_path, const std::string& embed_path) {
        if (!ready_) return false;
        if (head_path == loaded_head_path_ && embed_path == loaded_embed_path_)
            return true;
        try {
            load_head(head_path);
            open_embeddings(embed_path);
            loaded_head_path_  = head_path;
            loaded_embed_path_ = embed_path;
            return true;
        } catch (const std::exception& e) {
            std::fprintf(stderr, "[Eagle-3] load_weights failed: %s\n", e.what());
            return false;
        }
    }

    // Autoregressive k-step draft chain.
    //   hidden:        [num_tokens * embd_size] FP32 (target last hidden layer)
    //   last_token_id: ID of the token preceding the draft (-1 → zero embedding)
    //   ctx_len:       tokens already in target context (RoPE position base)
    // Returns k target-vocab token IDs (empty on failure).
    std::vector<int32_t> forward(const float* hidden, uint32_t embd_size,
                                 uint32_t num_tokens, uint32_t k,
                                 int32_t last_token_id, uint32_t ctx_len) {
        if (!ready_ || embd_size != EMBD || num_tokens == 0) return {};
        try { return run_draft(hidden, num_tokens, k, last_token_id, ctx_len); }
        catch (const std::exception& e) {
            std::fprintf(stderr, "[Eagle-3] forward failed: %s\n", e.what());
            return {};
        }
    }

    ~VkEagleDraftHead() { cleanup(); }
    VkEagleDraftHead(const VkEagleDraftHead&) = delete;
    VkEagleDraftHead& operator=(const VkEagleDraftHead&) = delete;

private:
    VkEagleDraftHead() = default;

    // ── Model dimensions ─────────────────────────────────────────────────────
    // Defaults suit Qwen3-VL-4B-Instruct_eagle3 but are overwritten in load_head()
    // from the head's actual safetensors tensor shapes, so any EAGLE-3 head loads.
    uint32_t EMBD        = 2560;
    uint32_t DRAFT_VOCAB = 32000;
    uint32_t ATTN_IN     = 5120;   // 2 * EMBD
    uint32_t Q_DIM       = 4096;   // N_Q_HEADS * HEAD_DIM
    uint32_t KV_DIM      = 1024;   // N_KV_HEADS * HEAD_DIM
    uint32_t HEAD_DIM    = 128;
    uint32_t N_Q_HEADS   = 32;
    uint32_t N_KV_HEADS  = 8;
    uint32_t GQA_GROUP   = 4;      // N_Q_HEADS / N_KV_HEADS
    uint32_t INTER       = 9728;
    // Hyperparameter defaults (Qwen3-VL-4B_eagle3 config.json). Overridable at
    // run time via set_rope_theta / set_rms_eps from the head's config.json.
    // Note: Qwen3-VL uses interleaved M-RoPE, but for text-only draft positions
    // all three (t,h,w) position components are equal, so it reduces to standard
    // 1-D rotate-half RoPE with this theta.
    static constexpr float    RMS_EPS     = 1e-6f;
    static constexpr float    ROPE_THETA  = 5000000.0f;

    // ── Vulkan objects ───────────────────────────────────────────────────────
    VkInstance            instance_      = VK_NULL_HANDLE;
    VkPhysicalDevice      phys_dev_      = VK_NULL_HANDLE;
    VkDevice              device_        = VK_NULL_HANDLE;
    VkQueue               compute_queue_ = VK_NULL_HANDLE;
    uint32_t              queue_family_  = UINT32_MAX;
    VkCommandPool         cmd_pool_      = VK_NULL_HANDLE;
    VkDescriptorSetLayout desc_layout_   = VK_NULL_HANDLE;
    VkPipelineLayout      pipe_layout_   = VK_NULL_HANDLE;
    VkShaderModule        sh_gemv_       = VK_NULL_HANDLE;
    VkShaderModule        sh_ln_         = VK_NULL_HANDLE;
    VkShaderModule        sh_swiglu_     = VK_NULL_HANDLE;
    VkPipeline            pipe_gemv_     = VK_NULL_HANDLE;
    VkPipeline            pipe_ln_       = VK_NULL_HANDLE;
    VkPipeline            pipe_swiglu_   = VK_NULL_HANDLE;
    VkDescriptorPool      desc_pool_     = VK_NULL_HANDLE;
    bool                  ready_         = false;
    VkPhysicalDeviceMemoryProperties mem_props_ = {};

    // Runtime-overridable hyperparameters (default to the constants above).
    float rope_theta_ = ROPE_THETA;
    float rms_eps_    = RMS_EPS;
    uint32_t cfg_head_dim_ = 0;   // from config.json (0 → derive/default 128)

    struct PushC { uint32_t u0; uint32_t u1; float f0; };

    struct GpuBuf {
        VkBuffer       buf = VK_NULL_HANDLE;
        VkDeviceMemory mem = VK_NULL_HANDLE;
        void*          ptr = nullptr;
        VkDeviceSize   size = 0;
    };

    // Weight buffers
    GpuBuf w_fc_, w_q_, w_k_, w_v_, w_o_, w_gate_, w_up_, w_down_, w_lm_;
    GpuBuf n_input_, n_hidden_, n_postattn_, n_final_;
    // Scratch buffers (allocated once at load to their max size)
    GpuBuf s_in_, s_fc_, s_enorm_, s_hnorm_, s_q_, s_k_, s_v_,
           s_attn_, s_delta_, s_midn_, s_gate_, s_up_, s_swiglu_, s_n2_, s_logits_;

    // Host data
    std::vector<int64_t> d2t_;          // draft → target offset table
    bool                 d2t_is_offset_ = true;
    int                  embed_fd_ = -1;
    bool                 embed_is_f16_ = false; // embed_tokens dtype: F16 vs BF16
    size_t               embed_data_off_ = 0;   // byte offset of embed tensor data
    uint32_t             embed_rows_ = 0;
    std::string          loaded_head_path_, loaded_embed_path_;

    // ── init ───────────────────────────────────────────────────────────────
    void init() {
        ::setenv("PAN_I_WANT_A_BROKEN_VULKAN_DRIVER", "1", 0);
        try {
            create_instance();
            pick_physical_device();
            create_logical_device();
            create_pipelines();
            create_descriptor_pool();
            ready_ = true;
        } catch (const std::exception&) {
            cleanup();
        }
    }

    void create_instance() {
        VkApplicationInfo app{};
        app.sType            = VK_STRUCTURE_TYPE_APPLICATION_INFO;
        app.pApplicationName = "orkllm-eagle-draft";
        app.apiVersion       = VK_API_VERSION_1_0;
        VkInstanceCreateInfo ci{};
        ci.sType            = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
        ci.pApplicationInfo = &app;
        VK_CHECK(vkCreateInstance(&ci, nullptr, &instance_));
    }

    uint32_t find_compute_queue(VkPhysicalDevice dev) {
        uint32_t n = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(dev, &n, nullptr);
        std::vector<VkQueueFamilyProperties> qp(n);
        vkGetPhysicalDeviceQueueFamilyProperties(dev, &n, qp.data());
        for (uint32_t i = 0; i < n; i++)
            if (qp[i].queueFlags & VK_QUEUE_COMPUTE_BIT) return i;
        return UINT32_MAX;
    }

    void pick_physical_device() {
        uint32_t n = 0;
        vkEnumeratePhysicalDevices(instance_, &n, nullptr);
        if (n == 0) throw std::runtime_error("no Vulkan physical devices");
        std::vector<VkPhysicalDevice> devs(n);
        vkEnumeratePhysicalDevices(instance_, &n, devs.data());
        for (auto dev : devs) {
            VkPhysicalDeviceProperties props{};
            vkGetPhysicalDeviceProperties(dev, &props);
            if (props.deviceType != VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU) continue;
            if (find_compute_queue(dev) == UINT32_MAX) continue;
            phys_dev_ = dev;
            vkGetPhysicalDeviceMemoryProperties(dev, &mem_props_);
            queue_family_ = find_compute_queue(dev);
            return;
        }
        throw std::runtime_error("no suitable integrated GPU found");
    }

    void create_logical_device() {
        float prio = 1.f;
        VkDeviceQueueCreateInfo qci{};
        qci.sType            = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
        qci.queueFamilyIndex = queue_family_;
        qci.queueCount       = 1;
        qci.pQueuePriorities = &prio;

        VkPhysicalDevice16BitStorageFeatures f16{};
        f16.sType                              = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES;
        f16.storageBuffer16BitAccess           = VK_TRUE;
        f16.uniformAndStorageBuffer16BitAccess = VK_TRUE;

        const char* ext16 = VK_KHR_16BIT_STORAGE_EXTENSION_NAME;

        VkDeviceCreateInfo dci{};
        dci.sType                   = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
        dci.pNext                   = &f16;
        dci.queueCreateInfoCount    = 1;
        dci.pQueueCreateInfos       = &qci;
        dci.enabledExtensionCount   = 1;
        dci.ppEnabledExtensionNames = &ext16;
        VK_CHECK(vkCreateDevice(phys_dev_, &dci, nullptr, &device_));
        vkGetDeviceQueue(device_, queue_family_, 0, &compute_queue_);

        VkCommandPoolCreateInfo cpci{};
        cpci.sType            = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
        cpci.queueFamilyIndex = queue_family_;
        cpci.flags            = VK_COMMAND_POOL_CREATE_TRANSIENT_BIT;
        VK_CHECK(vkCreateCommandPool(device_, &cpci, nullptr, &cmd_pool_));
    }

    VkShaderModule make_shader(const uint32_t* spv, size_t spv_size) {
        VkShaderModuleCreateInfo ci{};
        ci.sType    = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
        ci.codeSize = spv_size;
        ci.pCode    = spv;
        VkShaderModule m = VK_NULL_HANDLE;
        VK_CHECK(vkCreateShaderModule(device_, &ci, nullptr, &m));
        return m;
    }

    VkPipeline make_pipeline(VkShaderModule shader) {
        VkPipelineShaderStageCreateInfo stage{};
        stage.sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        stage.stage  = VK_SHADER_STAGE_COMPUTE_BIT;
        stage.module = shader;
        stage.pName  = "main";
        VkComputePipelineCreateInfo cpci{};
        cpci.sType  = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
        cpci.stage  = stage;
        cpci.layout = pipe_layout_;
        VkPipeline p = VK_NULL_HANDLE;
        VK_CHECK(vkCreateComputePipelines(device_, VK_NULL_HANDLE, 1, &cpci, nullptr, &p));
        return p;
    }

    void create_pipelines() {
        VkDescriptorSetLayoutBinding bindings[3] = {};
        for (int i = 0; i < 3; i++) {
            bindings[i].binding         = i;
            bindings[i].descriptorType  = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            bindings[i].descriptorCount = 1;
            bindings[i].stageFlags      = VK_SHADER_STAGE_COMPUTE_BIT;
        }
        VkDescriptorSetLayoutCreateInfo dlci{};
        dlci.sType        = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
        dlci.bindingCount = 3;
        dlci.pBindings    = bindings;
        VK_CHECK(vkCreateDescriptorSetLayout(device_, &dlci, nullptr, &desc_layout_));

        VkPushConstantRange pcr{};
        pcr.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
        pcr.offset     = 0;
        pcr.size       = sizeof(PushC);

        VkPipelineLayoutCreateInfo plci{};
        plci.sType                  = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
        plci.setLayoutCount         = 1;
        plci.pSetLayouts            = &desc_layout_;
        plci.pushConstantRangeCount = 1;
        plci.pPushConstantRanges    = &pcr;
        VK_CHECK(vkCreatePipelineLayout(device_, &plci, nullptr, &pipe_layout_));

        sh_gemv_     = make_shader(kGemvSpv,      kGemvSpvSize);
        sh_ln_       = make_shader(kLayernormSpv, kLayernormSpvSize);
        sh_swiglu_   = make_shader(kSwigluSpv,    kSwigluSpvSize);
        pipe_gemv_   = make_pipeline(sh_gemv_);
        pipe_ln_     = make_pipeline(sh_ln_);
        pipe_swiglu_ = make_pipeline(sh_swiglu_);
    }

    void create_descriptor_pool() {
        VkDescriptorPoolSize ps{};
        ps.type            = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        ps.descriptorCount = 3;
        VkDescriptorPoolCreateInfo dpci{};
        dpci.sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
        dpci.maxSets       = 1;
        dpci.poolSizeCount = 1;
        dpci.pPoolSizes    = &ps;
        dpci.flags         = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
        VK_CHECK(vkCreateDescriptorPool(device_, &dpci, nullptr, &desc_pool_));
    }

    // ── memory helpers ───────────────────────────────────────────────────────
    uint32_t find_memory_type(uint32_t type_bits, VkMemoryPropertyFlags req) {
        for (uint32_t i = 0; i < mem_props_.memoryTypeCount; i++) {
            if (!(type_bits & (1u << i))) continue;
            if ((mem_props_.memoryTypes[i].propertyFlags & req) == req) return i;
        }
        throw std::runtime_error("no suitable memory type");
    }

    GpuBuf alloc_buffer(VkDeviceSize size, VkMemoryPropertyFlags props) {
        GpuBuf gb; gb.size = size;
        VkBufferCreateInfo bci{};
        bci.sType       = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        bci.size        = size;
        bci.usage       = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
        bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        VK_CHECK(vkCreateBuffer(device_, &bci, nullptr, &gb.buf));
        VkMemoryRequirements rq{};
        vkGetBufferMemoryRequirements(device_, gb.buf, &rq);
        VkMemoryAllocateInfo mai{};
        mai.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        mai.allocationSize  = rq.size;
        mai.memoryTypeIndex = find_memory_type(rq.memoryTypeBits, props);
        VK_CHECK(vkAllocateMemory(device_, &mai, nullptr, &gb.mem));
        VK_CHECK(vkBindBufferMemory(device_, gb.buf, gb.mem, 0));
        VK_CHECK(vkMapMemory(device_, gb.mem, 0, VK_WHOLE_SIZE, 0, &gb.ptr));
        return gb;
    }

    GpuBuf uma_buf(VkDeviceSize sz) {
        constexpr VkMemoryPropertyFlags UMA =
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT |
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        constexpr VkMemoryPropertyFlags HOST =
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
            VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        try { return alloc_buffer(sz, UMA); }
        catch (...) { return alloc_buffer(sz, HOST); }
    }

    void free_buffer(GpuBuf& gb) {
        if (gb.ptr) { vkUnmapMemory(device_, gb.mem); gb.ptr = nullptr; }
        if (gb.buf) { vkDestroyBuffer(device_, gb.buf, nullptr); gb.buf = VK_NULL_HANDLE; }
        if (gb.mem) { vkFreeMemory(device_, gb.mem, nullptr);    gb.mem = VK_NULL_HANDLE; }
    }

    // ── dispatch with push constants ─────────────────────────────────────────
    void dispatch(VkPipeline pipeline, uint32_t groups, const PushC& pc,
                  GpuBuf& b0, GpuBuf& b1, GpuBuf& b2) {
        VkDescriptorSetAllocateInfo dsai{};
        dsai.sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
        dsai.descriptorPool     = desc_pool_;
        dsai.descriptorSetCount = 1;
        dsai.pSetLayouts        = &desc_layout_;
        VkDescriptorSet ds = VK_NULL_HANDLE;
        VK_CHECK(vkAllocateDescriptorSets(device_, &dsai, &ds));

        VkDescriptorBufferInfo dbi[3] = {
            { b0.buf, 0, VK_WHOLE_SIZE },
            { b1.buf, 0, VK_WHOLE_SIZE },
            { b2.buf, 0, VK_WHOLE_SIZE },
        };
        VkWriteDescriptorSet writes[3] = {};
        for (int i = 0; i < 3; i++) {
            writes[i].sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
            writes[i].dstSet          = ds;
            writes[i].dstBinding      = i;
            writes[i].descriptorCount = 1;
            writes[i].descriptorType  = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            writes[i].pBufferInfo     = &dbi[i];
        }
        vkUpdateDescriptorSets(device_, 3, writes, 0, nullptr);

        VkCommandBufferAllocateInfo cbai{};
        cbai.sType              = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
        cbai.commandPool        = cmd_pool_;
        cbai.level              = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        cbai.commandBufferCount = 1;
        VkCommandBuffer cb = VK_NULL_HANDLE;
        VK_CHECK(vkAllocateCommandBuffers(device_, &cbai, &cb));

        VkCommandBufferBeginInfo cbbi{};
        cbbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        cbbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        VK_CHECK(vkBeginCommandBuffer(cb, &cbbi));
        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE,
                                pipe_layout_, 0, 1, &ds, 0, nullptr);
        vkCmdPushConstants(cb, pipe_layout_, VK_SHADER_STAGE_COMPUTE_BIT,
                           0, sizeof(PushC), &pc);
        vkCmdDispatch(cb, groups, 1, 1);
        VK_CHECK(vkEndCommandBuffer(cb));

        VkFenceCreateInfo fci{};
        fci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
        VkFence fence = VK_NULL_HANDLE;
        VK_CHECK(vkCreateFence(device_, &fci, nullptr, &fence));
        VkSubmitInfo si{};
        si.sType              = VK_STRUCTURE_TYPE_SUBMIT_INFO;
        si.commandBufferCount = 1;
        si.pCommandBuffers    = &cb;
        VK_CHECK(vkQueueSubmit(compute_queue_, 1, &si, fence));
        VK_CHECK(vkWaitForFences(device_, 1, &fence, VK_TRUE, UINT64_MAX));
        vkDestroyFence(device_, fence, nullptr);
        vkFreeCommandBuffers(device_, cmd_pool_, 1, &cb);
        vkFreeDescriptorSets(device_, desc_pool_, 1, &ds);
    }

    // Linear: out[OUT] = W[OUT x IN] @ in (input already in s_in_ or given buf)
    void gemv(GpuBuf& in, GpuBuf& w, GpuBuf& out, uint32_t OUT, uint32_t IN) {
        PushC pc{ OUT, IN, 0.f };
        dispatch(pipe_gemv_, (OUT + 127u) / 128u, pc, in, w, out);
    }
    void rmsnorm(GpuBuf& in, GpuBuf& scale, GpuBuf& out, uint32_t DIM) {
        PushC pc{ DIM, 0u, rms_eps_ };
        dispatch(pipe_ln_, 1u, pc, in, scale, out);
    }
    void swiglu(GpuBuf& gate, GpuBuf& up, GpuBuf& out, uint32_t DIM) {
        PushC pc{ DIM, 0u, 0.f };
        dispatch(pipe_swiglu_, (DIM + 63u) / 64u, pc, gate, up, out);
    }

    float* fptr(GpuBuf& b) { return reinterpret_cast<float*>(b.ptr); }

    // ── safetensors parsing ────────────────────────────────────────────────
    struct TensorInfo { std::string dtype; std::vector<int64_t> shape; size_t begin, end; };

    static std::unordered_map<std::string, TensorInfo>
    parse_safetensors_header(std::ifstream& f, size_t& data_start) {
        uint64_t hlen = 0;
        f.read(reinterpret_cast<char*>(&hlen), 8);
        if (!f) throw std::runtime_error("cannot read safetensors header length");
        std::string hdr(hlen, '\0');
        f.read(&hdr[0], hlen);
        if (!f) throw std::runtime_error("cannot read safetensors header");
        data_start = 8 + hlen;

        std::unordered_map<std::string, TensorInfo> out;
        // Minimal JSON scan tailored to safetensors layout (flat object of
        // {dtype, shape, data_offsets}). Avoids a JSON dependency in the addon.
        size_t i = 0;
        auto skip_ws = [&]{ while (i < hdr.size() && (hdr[i]==' '||hdr[i]=='\n'||hdr[i]=='\t'||hdr[i]=='\r')) i++; };
        auto read_string = [&]() -> std::string {
            skip_ws();
            if (hdr[i] != '"') throw std::runtime_error("expected string in header");
            i++; std::string s;
            while (i < hdr.size() && hdr[i] != '"') { s += hdr[i]; i++; }
            i++; return s;
        };
        // Skip any JSON value (string / number / bool / null / array / object),
        // tracking quotes and brace depth. Used to step over the safetensors
        // `__metadata__` block (whose string values like "format":"pt" are not
        // tensor descriptors) and any forward-compat fields we don't recognise.
        auto skip_value = [&]() {
            skip_ws();
            if (i >= hdr.size()) return;
            if (hdr[i] == '"') { read_string(); return; }
            if (hdr[i] == '{' || hdr[i] == '[') {
                int depth = 0;
                while (i < hdr.size()) {
                    char c = hdr[i];
                    if (c == '"') { read_string(); continue; }
                    if (c == '{' || c == '[') { depth++; i++; }
                    else if (c == '}' || c == ']') { depth--; i++; if (depth == 0) return; }
                    else i++;
                }
                return;
            }
            while (i < hdr.size() && hdr[i] != ',' && hdr[i] != '}' && hdr[i] != ']') i++;
        };
        skip_ws();
        if (hdr[i] != '{') throw std::runtime_error("bad header");
        i++;
        while (true) {
            skip_ws();
            if (i >= hdr.size() || hdr[i] == '}') break;
            std::string key = read_string();
            skip_ws();
            if (hdr[i] != ':') throw std::runtime_error("expected :");
            i++; skip_ws();
            // `__metadata__` is not a tensor — its value is a string→string map
            // ({"format":"pt", ...}); skip it wholesale rather than parsing it as
            // a tensor descriptor (which threw "unexpected field: format").
            if (key == "__metadata__") {
                skip_value();
                skip_ws();
                if (i < hdr.size() && hdr[i] == ',') i++;
                continue;
            }
            if (hdr[i] != '{') throw std::runtime_error("expected tensor object");
            // parse the inner object
            TensorInfo ti{};
            i++; // {
            while (true) {
                skip_ws();
                if (hdr[i] == '}') { i++; break; }
                std::string fld = read_string();
                skip_ws(); if (hdr[i] != ':') throw std::runtime_error("expected :"); i++; skip_ws();
                if (fld == "dtype") {
                    ti.dtype = read_string();
                } else if (fld == "shape") {
                    if (hdr[i] != '[') throw std::runtime_error("expected [");
                    i++;
                    while (true) {
                        skip_ws();
                        if (hdr[i] == ']') { i++; break; }
                        size_t j = i; while (j < hdr.size() && hdr[j] != ',' && hdr[j] != ']') j++;
                        ti.shape.push_back(std::stoll(hdr.substr(i, j - i)));
                        i = j; skip_ws();
                        if (hdr[i] == ',') i++;
                    }
                } else if (fld == "data_offsets") {
                    if (hdr[i] != '[') throw std::runtime_error("expected [");
                    i++; skip_ws();
                    size_t j = i; while (hdr[j] != ',') j++;
                    ti.begin = std::stoull(hdr.substr(i, j - i));
                    i = j + 1; skip_ws();
                    j = i; while (hdr[j] != ']') j++;
                    ti.end = std::stoull(hdr.substr(i, j - i));
                    i = j + 1;
                } else {
                    skip_value();   // forward-compat: ignore unknown tensor fields
                }
                skip_ws();
                if (hdr[i] == ',') i++;
            }
            if (key != "__metadata__") out[key] = ti;
            skip_ws();
            if (hdr[i] == ',') i++;
        }
        return out;
    }

    static float f16_to_f32(uint16_t h) {
        uint32_t s = (h >> 15) & 1, e = (h >> 10) & 0x1f, m = h & 0x3ff, out;
        if (e == 0)      { if (m == 0) out = s << 31;                       // ±0
                           else { e = 127 - 15 + 1; while (!(m & 0x400)) { m <<= 1; e--; } m &= 0x3ff;
                                  out = (s << 31) | (e << 23) | (m << 13); } } // subnormal
        else if (e == 0x1f) out = (s << 31) | 0x7f800000 | (m << 13);       // inf/nan
        else out = (s << 31) | ((e - 15 + 127) << 23) | (m << 13);
        float f; std::memcpy(&f, &out, 4); return f;
    }
    static uint16_t f32_to_bf16(float f) {
        uint32_t u; std::memcpy(&u, &f, 4);
        // round-to-nearest-even truncation to the high 16 bits
        return (uint16_t)((u + 0x7fff + ((u >> 16) & 1)) >> 16);
    }

    // Upload a weight tensor into a fresh UMA buffer as BF16 (the GEMV shader's
    // weight format). Accepts BF16 (verbatim copy) or F16 (converted to BF16 —
    // some EAGLE-3 heads, e.g. AngelSlim Qwen3-1.7B, ship F16; the 3-bit mantissa
    // loss is acceptable for a draft head whose output is verified on the NPU).
    GpuBuf upload_weight(std::ifstream& f, size_t data_start, const TensorInfo& ti,
                         size_t expect_elems) {
        const bool isBf16 = (ti.dtype == "BF16");
        const bool isF16  = (ti.dtype == "F16");
        if (!isBf16 && !isF16) throw std::runtime_error("weight dtype " + ti.dtype + " not supported (need BF16/F16)");
        size_t bytes = ti.end - ti.begin;
        if (bytes != expect_elems * 2) throw std::runtime_error("tensor size mismatch");
        GpuBuf gb = uma_buf(bytes);
        f.seekg(data_start + ti.begin);
        if (isBf16) {
            f.read(reinterpret_cast<char*>(gb.ptr), bytes);
        } else {
            std::vector<uint16_t> tmp(expect_elems);
            f.read(reinterpret_cast<char*>(tmp.data()), bytes);
            uint16_t* dst = reinterpret_cast<uint16_t*>(gb.ptr);
            for (size_t i = 0; i < expect_elems; i++) dst[i] = f32_to_bf16(f16_to_f32(tmp[i]));
        }
        if (!f) throw std::runtime_error("tensor read failed");
        return gb;
    }

    void load_head(const std::string& path) {
        std::ifstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("cannot open draft head: " + path);
        size_t data_start = 0;
        auto t = parse_safetensors_header(f, data_start);

        auto need = [&](const char* k) -> TensorInfo& {
            auto it = t.find(k);
            if (it == t.end()) throw std::runtime_error(std::string("missing tensor: ") + k);
            return it->second;
        };

        // ── Derive model dimensions from the head's tensor shapes ──────────────
        // (no hard-coding to one head; safetensors weights are [out, in]).
        auto dim = [&](const char* k, int axis) -> uint32_t {
            TensorInfo& ti = need(k);
            if ((int)ti.shape.size() <= axis) throw std::runtime_error(std::string(k) + ": unexpected rank");
            return (uint32_t)ti.shape[axis];
        };
        EMBD        = dim("fc.weight", 0);                              // fc: [EMBD, 3*EMBD]
        ATTN_IN     = dim("midlayer.self_attn.q_proj.weight", 1);      // [Q_DIM, 2*EMBD]
        Q_DIM       = dim("midlayer.self_attn.q_proj.weight", 0);
        KV_DIM      = dim("midlayer.self_attn.k_proj.weight", 0);
        INTER       = dim("midlayer.mlp.gate_proj.weight", 0);          // [INTER, EMBD]
        DRAFT_VOCAB = dim("lm_head.weight", 0);                         // [DRAFT_VOCAB, EMBD]
        HEAD_DIM    = cfg_head_dim_ ? cfg_head_dim_ : 128;
        if (Q_DIM % HEAD_DIM || KV_DIM % HEAD_DIM)
            throw std::runtime_error("Q/KV dim not a multiple of head_dim");
        N_Q_HEADS   = Q_DIM / HEAD_DIM;
        N_KV_HEADS  = KV_DIM / HEAD_DIM;
        if (!N_KV_HEADS || N_Q_HEADS % N_KV_HEADS) throw std::runtime_error("bad GQA head ratio");
        GQA_GROUP   = N_Q_HEADS / N_KV_HEADS;
        if (ATTN_IN != 2 * EMBD) throw std::runtime_error("attn input != 2*EMBD");
        std::fprintf(stderr, "[Eagle-3] head dims: embd=%u attn_in=%u q=%u kv=%u heads=%u/%u hd=%u inter=%u vocab=%u\n",
                     EMBD, ATTN_IN, Q_DIM, KV_DIM, N_Q_HEADS, N_KV_HEADS, HEAD_DIM, INTER, DRAFT_VOCAB);

        // Free any previously-loaded weights (model swap)
        free_weights();

        w_fc_   = upload_weight(f, data_start, need("fc.weight"),   (size_t)EMBD * (3 * EMBD));
        w_q_    = upload_weight(f, data_start, need("midlayer.self_attn.q_proj.weight"), (size_t)Q_DIM * ATTN_IN);
        w_k_    = upload_weight(f, data_start, need("midlayer.self_attn.k_proj.weight"), (size_t)KV_DIM * ATTN_IN);
        w_v_    = upload_weight(f, data_start, need("midlayer.self_attn.v_proj.weight"), (size_t)KV_DIM * ATTN_IN);
        w_o_    = upload_weight(f, data_start, need("midlayer.self_attn.o_proj.weight"), (size_t)EMBD * Q_DIM);
        w_gate_ = upload_weight(f, data_start, need("midlayer.mlp.gate_proj.weight"),    (size_t)INTER * EMBD);
        w_up_   = upload_weight(f, data_start, need("midlayer.mlp.up_proj.weight"),      (size_t)INTER * EMBD);
        w_down_ = upload_weight(f, data_start, need("midlayer.mlp.down_proj.weight"),    (size_t)EMBD * INTER);
        w_lm_   = upload_weight(f, data_start, need("lm_head.weight"),                   (size_t)DRAFT_VOCAB * EMBD);
        n_input_    = upload_weight(f, data_start, need("midlayer.input_layernorm.weight"),         EMBD);
        n_hidden_   = upload_weight(f, data_start, need("midlayer.hidden_norm.weight"),             EMBD);
        n_postattn_ = upload_weight(f, data_start, need("midlayer.post_attention_layernorm.weight"),EMBD);
        n_final_    = upload_weight(f, data_start, need("norm.weight"),                             EMBD);

        // d2t: I64 [32000]
        {
            TensorInfo& ti = need("d2t");
            if (ti.dtype != "I64") throw std::runtime_error("d2t not I64");
            size_t cnt = (ti.end - ti.begin) / 8;
            d2t_.resize(cnt);
            f.seekg(data_start + ti.begin);
            f.read(reinterpret_cast<char*>(d2t_.data()), cnt * 8);
            if (!f) throw std::runtime_error("d2t read failed");
            // Detect semantics: offset table (target = draft + d2t) vs direct map.
            int64_t mx = 0;
            for (auto v : d2t_) if (v > mx) mx = v;
            d2t_is_offset_ = (mx < 151936);
            std::fprintf(stderr, "[Eagle-3] d2t loaded: %zu entries, max=%lld, mode=%s\n",
                         cnt, (long long)mx, d2t_is_offset_ ? "offset" : "direct");
        }

        alloc_scratch();
    }

    void open_embeddings(const std::string& path) {
        if (embed_fd_ >= 0) { ::close(embed_fd_); embed_fd_ = -1; }
        std::ifstream f(path, std::ios::binary);
        if (!f) throw std::runtime_error("cannot open embeddings: " + path);
        size_t data_start = 0;
        auto t = parse_safetensors_header(f, data_start);
        // Accept any key ending in embed_tokens.weight
        const TensorInfo* ti = nullptr;
        for (auto& kv : t) {
            if (kv.first.size() >= 18 &&
                kv.first.rfind("embed_tokens.weight") != std::string::npos) {
                ti = &kv.second; break;
            }
        }
        if (!ti) throw std::runtime_error("embeddings file has no embed_tokens.weight");
        if (ti->dtype != "BF16" && ti->dtype != "F16")
            throw std::runtime_error("embeddings dtype " + ti->dtype + " not supported (need BF16/F16)");
        embed_is_f16_ = (ti->dtype == "F16");
        if (ti->shape.size() != 2 || ti->shape[1] != (int64_t)EMBD)
            throw std::runtime_error("embeddings shape mismatch");
        embed_rows_     = (uint32_t)ti->shape[0];
        embed_data_off_ = data_start + ti->begin;
        embed_fd_ = ::open(path.c_str(), O_RDONLY);
        if (embed_fd_ < 0) throw std::runtime_error("cannot reopen embeddings fd");
    }

    void alloc_scratch() {
        free_scratch();
        // s_in_ is reused as the input vector for fc (3*EMBD), attn (2*EMBD) and
        // o_proj (Q_DIM) GEMVs — size it to the largest of those.
        uint32_t in_max = 3 * EMBD;
        if (ATTN_IN > in_max) in_max = ATTN_IN;
        if (Q_DIM   > in_max) in_max = Q_DIM;
        s_in_     = uma_buf((size_t)in_max * 4);
        s_fc_     = uma_buf(EMBD * 4);
        s_enorm_  = uma_buf(EMBD * 4);
        s_hnorm_  = uma_buf(EMBD * 4);
        s_q_      = uma_buf(Q_DIM * 4);
        s_k_      = uma_buf(KV_DIM * 4);
        s_v_      = uma_buf(KV_DIM * 4);
        s_attn_   = uma_buf(Q_DIM * 4);
        s_delta_  = uma_buf(EMBD * 4);
        s_midn_   = uma_buf(EMBD * 4);
        s_gate_   = uma_buf(INTER * 4);
        s_up_     = uma_buf(INTER * 4);
        s_swiglu_ = uma_buf(INTER * 4);
        s_n2_     = uma_buf(EMBD * 4);
        s_logits_ = uma_buf(DRAFT_VOCAB * 4);
    }

    // ── embedding row read (BF16 → FP32) ─────────────────────────────────────
    void embed_row(int32_t token_id, float* out) {
        if (token_id < 0 || (uint32_t)token_id >= embed_rows_ || embed_fd_ < 0) {
            std::memset(out, 0, EMBD * sizeof(float));
            return;
        }
        std::vector<uint16_t> raw(EMBD);
        off_t off = (off_t)embed_data_off_ + (off_t)token_id * EMBD * 2;
        ssize_t got = ::pread(embed_fd_, raw.data(), EMBD * 2, off);
        if (got != (ssize_t)(EMBD * 2)) { std::memset(out, 0, EMBD * sizeof(float)); return; }
        if (embed_is_f16_) for (uint32_t i = 0; i < EMBD; i++) out[i] = f16_to_f32(raw[i]);
        else               for (uint32_t i = 0; i < EMBD; i++) out[i] = bf16_to_f32(raw[i]);
    }

    static float bf16_to_f32(uint16_t b) {
        uint32_t u = (uint32_t)b << 16;
        float f; std::memcpy(&f, &u, 4); return f;
    }

    // ── RoPE (NeoX/Llama half-rotation) ──────────────────────────────────────
    // Applies rotary embedding in place to a [n_heads x HEAD_DIM] vector.
    void apply_rope(float* x, uint32_t n_heads, uint32_t pos) {
        const uint32_t half = HEAD_DIM / 2;
        for (uint32_t h = 0; h < n_heads; h++) {
            float* v = x + h * HEAD_DIM;
            for (uint32_t i = 0; i < half; i++) {
                float freq = std::pow(rope_theta_, -((float)(2 * i) / (float)HEAD_DIM));
                float angle = (float)pos * freq;
                float cs = std::cos(angle), sn = std::sin(angle);
                float a = v[i], b = v[i + half];
                v[i]        = a * cs - b * sn;
                v[i + half] = a * sn + b * cs;
            }
        }
    }

    // ── autoregressive draft chain ───────────────────────────────────────────
    std::vector<int32_t> run_draft(const float* hidden, uint32_t num_tokens,
                                   uint32_t k, int32_t last_token_id, uint32_t ctx_len) {
        // fc input: replicate last-layer hidden 3x (v1 approximation, gap #1)
        const float* hlast = hidden + (size_t)(num_tokens - 1) * EMBD;
        float* in = fptr(s_in_);
        for (uint32_t r = 0; r < 3; r++) std::memcpy(in + r * EMBD, hlast, EMBD * 4);
        gemv(s_in_, w_fc_, s_fc_, EMBD, ATTN_IN);          // h = fc(concat) [2560]

        std::vector<float> h(EMBD);
        std::memcpy(h.data(), fptr(s_fc_), EMBD * 4);

        // Draft KV cache (host): RoPE'd K and raw V per step
        std::vector<std::vector<float>> Kc, Vc;
        std::vector<float> e(EMBD), enorm(EMBD), hnorm(EMBD);
        std::vector<int32_t> out;
        out.reserve(k);

        int32_t tok = last_token_id;

        for (uint32_t step = 0; step < k; step++) {
            embed_row(tok, e.data());

            // e_norm = input_layernorm(e); h_norm = hidden_norm(h)
            std::memcpy(fptr(s_in_), e.data(), EMBD * 4);
            rmsnorm(s_in_, n_input_, s_enorm_, EMBD);
            std::memcpy(fptr(s_in_), h.data(), EMBD * 4);
            rmsnorm(s_in_, n_hidden_, s_hnorm_, EMBD);

            // attn input = concat(e_norm, h_norm) [5120]
            std::memcpy(fptr(s_in_),        fptr(s_enorm_), EMBD * 4);
            std::memcpy(fptr(s_in_) + EMBD, fptr(s_hnorm_), EMBD * 4);

            gemv(s_in_, w_q_, s_q_, Q_DIM,  ATTN_IN);
            gemv(s_in_, w_k_, s_k_, KV_DIM, ATTN_IN);
            gemv(s_in_, w_v_, s_v_, KV_DIM, ATTN_IN);

            // RoPE on Q and K at position (ctx_len + step)
            std::vector<float> Q(fptr(s_q_), fptr(s_q_) + Q_DIM);
            std::vector<float> K(fptr(s_k_), fptr(s_k_) + KV_DIM);
            std::vector<float> V(fptr(s_v_), fptr(s_v_) + KV_DIM);
            apply_rope(Q.data(), N_Q_HEADS,  ctx_len + step);
            apply_rope(K.data(), N_KV_HEADS, ctx_len + step);
            Kc.push_back(K);
            Vc.push_back(V);

            // GQA causal attention over steps 0..step
            std::vector<float> attn(Q_DIM);
            const float scale = 1.0f / std::sqrt((float)HEAD_DIM);
            const uint32_t T = (uint32_t)Kc.size();
            std::vector<float> scores(T);
            for (uint32_t qh = 0; qh < N_Q_HEADS; qh++) {
                const float* qv = Q.data() + qh * HEAD_DIM;
                uint32_t kvh = qh / GQA_GROUP;
                float mx = -INFINITY;
                for (uint32_t p = 0; p < T; p++) {
                    const float* kv = Kc[p].data() + kvh * HEAD_DIM;
                    float dot = 0.f;
                    for (uint32_t d = 0; d < HEAD_DIM; d++) dot += qv[d] * kv[d];
                    dot *= scale;
                    scores[p] = dot;
                    if (dot > mx) mx = dot;
                }
                float sum = 0.f;
                for (uint32_t p = 0; p < T; p++) { scores[p] = std::exp(scores[p] - mx); sum += scores[p]; }
                float inv = sum > 0.f ? 1.f / sum : 0.f;
                float* ao = attn.data() + qh * HEAD_DIM;
                for (uint32_t d = 0; d < HEAD_DIM; d++) ao[d] = 0.f;
                for (uint32_t p = 0; p < T; p++) {
                    float wgt = scores[p] * inv;
                    const float* vv = Vc[p].data() + kvh * HEAD_DIM;
                    for (uint32_t d = 0; d < HEAD_DIM; d++) ao[d] += wgt * vv[d];
                }
            }

            // o_proj + residual: h1 = h + o_proj(attn)
            std::memcpy(fptr(s_in_), attn.data(), Q_DIM * 4);
            gemv(s_in_, w_o_, s_delta_, EMBD, Q_DIM);
            std::vector<float> h1(EMBD);
            for (uint32_t i = 0; i < EMBD; i++) h1[i] = h[i] + fptr(s_delta_)[i];

            // MLP: m = post_attention_layernorm(h1); SwiGLU; h2 = h1 + down
            std::memcpy(fptr(s_in_), h1.data(), EMBD * 4);
            rmsnorm(s_in_, n_postattn_, s_midn_, EMBD);
            gemv(s_midn_, w_gate_, s_gate_, INTER, EMBD);
            gemv(s_midn_, w_up_,   s_up_,   INTER, EMBD);
            swiglu(s_gate_, s_up_, s_swiglu_, INTER);
            gemv(s_swiglu_, w_down_, s_delta_, EMBD, INTER);
            std::vector<float> h2(EMBD);
            for (uint32_t i = 0; i < EMBD; i++) h2[i] = h1[i] + fptr(s_delta_)[i];

            // logits = lm_head(norm(h2))
            std::memcpy(fptr(s_in_), h2.data(), EMBD * 4);
            rmsnorm(s_in_, n_final_, s_n2_, EMBD);
            gemv(s_n2_, w_lm_, s_logits_, DRAFT_VOCAB, EMBD);

            // argmax over draft vocab
            const float* lg = fptr(s_logits_);
            int32_t best = 0; float bv = -INFINITY;
            for (uint32_t v = 0; v < DRAFT_VOCAB; v++) if (lg[v] > bv) { bv = lg[v]; best = (int32_t)v; }

            int32_t target_id = d2t_is_offset_
                ? best + (int32_t)d2t_[best]
                : (int32_t)d2t_[best];
            out.push_back(target_id);

            // Feed forward: next embedding from this token, hidden = h2
            tok = target_id;
            h = h2;
        }
        return out;
    }

    // ── cleanup ───────────────────────────────────────────────────────────
    void free_weights() {
        for (GpuBuf* b : { &w_fc_, &w_q_, &w_k_, &w_v_, &w_o_, &w_gate_, &w_up_,
                           &w_down_, &w_lm_, &n_input_, &n_hidden_, &n_postattn_, &n_final_ })
            if (b->buf) free_buffer(*b);
    }
    void free_scratch() {
        for (GpuBuf* b : { &s_in_, &s_fc_, &s_enorm_, &s_hnorm_, &s_q_, &s_k_, &s_v_,
                           &s_attn_, &s_delta_, &s_midn_, &s_gate_, &s_up_, &s_swiglu_,
                           &s_n2_, &s_logits_ })
            if (b->buf) free_buffer(*b);
    }

    void cleanup() {
        if (device_) {
            vkDeviceWaitIdle(device_);
            free_weights();
            free_scratch();
            if (desc_pool_)    vkDestroyDescriptorPool(device_, desc_pool_, nullptr);
            if (pipe_gemv_)    vkDestroyPipeline(device_, pipe_gemv_, nullptr);
            if (pipe_ln_)      vkDestroyPipeline(device_, pipe_ln_, nullptr);
            if (pipe_swiglu_)  vkDestroyPipeline(device_, pipe_swiglu_, nullptr);
            if (pipe_layout_)  vkDestroyPipelineLayout(device_, pipe_layout_, nullptr);
            if (desc_layout_)  vkDestroyDescriptorSetLayout(device_, desc_layout_, nullptr);
            if (sh_gemv_)      vkDestroyShaderModule(device_, sh_gemv_, nullptr);
            if (sh_ln_)        vkDestroyShaderModule(device_, sh_ln_, nullptr);
            if (sh_swiglu_)    vkDestroyShaderModule(device_, sh_swiglu_, nullptr);
            if (cmd_pool_)     vkDestroyCommandPool(device_, cmd_pool_, nullptr);
            vkDestroyDevice(device_, nullptr);
        }
        if (embed_fd_ >= 0) { ::close(embed_fd_); embed_fd_ = -1; }
        if (instance_) vkDestroyInstance(instance_, nullptr);
        device_ = VK_NULL_HANDLE; instance_ = VK_NULL_HANDLE; ready_ = false;
    }
};

#endif // HAS_VULKAN
